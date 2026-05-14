import {
  type AccessOperation,
  evaluateAccess,
  isNodeError,
  resolvePath,
  resolveSymlinks,
} from './acl.js';
import { bashSchema, createBashToolHandler, createEnsureConnected } from './bash.js';
import {
  type SandboxConfig,
  augmentConfigWithPiDir,
  loadConfig,
  validateConfig,
} from './config.js';
import {
  DockerDaemonUnreachableError,
  doesImageExist,
  ensureContainer,
  execInContainer,
  getContainerStatus,
  pullImage,
  stopAndRemoveContainer,
  stopAndRemoveNetwork,
} from './docker.js';
import {
  acquireSessionRef,
  computeConfigHash,
  computeContainerName,
  computeNetworkName,
  computeSidecarName,
  countStaleRefs,
  deleteConfigHash,
  getStateDir,
  readStoredConfigHash,
  releaseSessionRef,
  resetState,
} from './lifecycle.js';
import { hasNetworkPolicy, type NetworkConfig } from './network.js';
import { Mutex, type SandboxState, createSandboxState } from './state.js';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createBashTool, isToolCallEventType } from '@mariozechner/pi-coding-agent';
import Dockerode from 'dockerode';
import { existsSync, readdirSync, realpathSync } from 'node:fs';

function buildFallbackConfig(memoryConfig: SandboxConfig | undefined): SandboxConfig {
  return {
    image: memoryConfig?.image ?? 'unknown',
    env: memoryConfig?.env ?? {},
    filesystem: memoryConfig?.filesystem ?? { rw: [], ro: [] },
    network: memoryConfig?.network ?? {},
  };
}

function loadConfigWithFallback(
  workspacePath: string,
  loadConfigFn: typeof loadConfig,
  memoryConfig: SandboxConfig | undefined,
): { config: SandboxConfig; error?: Error } {
  try {
    const { config: loaded } = loadConfigFn(workspacePath);
    const { config: augmented } = augmentConfigWithPiDir(loaded);
    return { config: augmented };
  } catch (err) {
    return {
      config: buildFallbackConfig(memoryConfig),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function formatNetworkSection(network: NetworkConfig, sidecarStatus?: string): string {
  if (Object.keys(network).length === 0) {
    return 'Network: none';
  }
  const allow: string[] = [];
  if (network.domains?.length) allow.push(...network.domains);
  if (network.cidrs?.length) allow.push(...network.cidrs);
  const deny = network.denyCidrs ?? [];
  return `Network:\n  allow: ${allow.join(', ') || '(none)'}\n  deny: ${deny.join(', ') || '(none)'}\n  sidecar: ${sidecarStatus ?? 'unknown'}`;
}

function formatConfigStaleness(storedHash: string | undefined, configHash: string): string {
  if (storedHash === undefined) return 'unknown';
  if (storedHash === configHash) return 'current';
  return `stale — running container was created with ${storedHash}`;
}

function formatSandboxStatusLines(
  workspacePath: string,
  containerName: string,
  containerStatus: string,
  config: SandboxConfig,
  configHash: string,
  configStaleness: string,
  sessionIds: string[],
  sidecarStatus?: string,
): string[] {
  return [
    'Sandbox status:',
    `Workspace: ${workspacePath}`,
    `Container: ${containerName} (${containerStatus})`,
    `Image: ${config.image}`,
    `Config hash: ${configHash} (${configStaleness})`,
    'Filesystem:',
    `  rw: ${config.filesystem.rw.join(', ') || '(none)'}`,
    `  ro: ${config.filesystem.ro.join(', ') || '(none)'}`,
    formatNetworkSection(config.network, sidecarStatus),
    `Sessions: ${String(sessionIds.length)} active (${sessionIds.slice(0, 10).join(', ')}${sessionIds.length > 10 ? ', ...' : ''})`,
  ];
}

function resolveToolPath(
  path: unknown,
  workspaceAbsolutePath: string,
): { resolved: string } | { block: true; reason: string } {
  if (typeof path !== 'string') {
    return { block: true, reason: 'Missing or invalid path argument' };
  }

  const normalized = resolvePath(path, workspaceAbsolutePath);

  try {
    const resolved = resolveSymlinks(normalized);
    return { resolved };
  } catch (err) {
    if (isNodeError(err)) {
      switch (err.code) {
        case 'ENOENT':
          return { block: true, reason: `Path outside workspace: ${path}` };
        case 'EACCES':
          return { block: true, reason: `Permission denied resolving path: ${path}` };
        case 'ELOOP':
          return { block: true, reason: `Symlink loop detected: ${path}` };
        case 'ENOTDIR':
          return { block: true, reason: `Not a directory in path: ${path}` };
      }
    }
    throw err;
  }
}

export interface SandboxExtensionOptions {
  docker?: Dockerode;
  loadConfigFn?: typeof loadConfig;
  ensureContainerFn?: typeof ensureContainer;
  execInContainerFn?: typeof execInContainer;
  doesImageExistFn?: typeof doesImageExist;
  pullImageFn?: typeof pullImage;
  stopAndRemoveContainerFn?: typeof stopAndRemoveContainer;
  getContainerStatusFn?: typeof getContainerStatus;
}

export function createSandboxExtension(
  options: SandboxExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  return function (pi: ExtensionAPI): void {
    pi.registerFlag('no-sandbox', {
      description: 'Disable the Docker sandbox extension',
      type: 'boolean',
      default: false,
    });

    const localCwd = process.cwd();
    const localBash = createBashTool(localCwd);

    const docker = options.docker ?? new Dockerode();
    const loadConfigFn = options.loadConfigFn ?? loadConfig;
    const ensureContainerFn = options.ensureContainerFn ?? ensureContainer;
    const execInContainerFn = options.execInContainerFn ?? execInContainer;
    const doesImageExistFn = options.doesImageExistFn ?? doesImageExist;
    const pullImageFn = options.pullImageFn ?? pullImage;
    const stopAndRemoveContainerFn = options.stopAndRemoveContainerFn ?? stopAndRemoveContainer;
    const getContainerStatusFn = options.getContainerStatusFn ?? getContainerStatus;

    const state: SandboxState = createSandboxState();
    // In-memory lock for container lifecycle ops in THIS process only —
    // not a cross-session inter-process lock. See Mutex JSDoc for details.
    const lifecycleMutex = new Mutex();

    async function cleanupWorkspaceResources(
      workspacePath: string,
      config: { network: NetworkConfig },
    ): Promise<void> {
      const errors: Error[] = [];

      try {
        await stopAndRemoveContainerFn(docker, computeContainerName(workspacePath));
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }

      if (hasNetworkPolicy(config)) {
        try {
          await stopAndRemoveContainerFn(docker, computeSidecarName(workspacePath));
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
        try {
          await stopAndRemoveNetwork(docker, computeNetworkName(workspacePath));
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }

      const firstError = errors[0];
      if (firstError) {
        throw firstError;
      }
    }

    pi.on('session_shutdown', async (_event, ctx) => {
      if (pi.getFlag('no-sandbox')) {
        return;
      }
      if (state.workspaceAbsolutePath === undefined) {
        return;
      }

      const stateDir = getStateDir(ctx.sessionManager.getSessionDir());
      const isEmpty = releaseSessionRef(stateDir, ctx.sessionManager.getSessionId());

      if (isEmpty) {
        const release = await lifecycleMutex.acquire();
        try {
          await cleanupWorkspaceResources(
            state.workspaceAbsolutePath,
            state.config ?? { network: {} },
          );
          state.container = undefined;
          deleteConfigHash(stateDir);
        } finally {
          release();
        }
      }
    });

    pi.on('session_start', (_event, ctx) => {
      if (pi.getFlag('no-sandbox')) {
        return;
      }

      const { config: loadedConfig, warnings } = loadConfigFn(ctx.cwd);
      for (const warning of warnings) {
        ctx.ui.notify(warning, 'warning');
      }
      const { config: augmentedConfig, warning: augmentWarning } =
        augmentConfigWithPiDir(loadedConfig);
      if (augmentWarning) {
        ctx.ui.notify(augmentWarning, 'warning');
      }
      validateConfig(augmentedConfig);

      const workspacePath = realpathSync(ctx.cwd);

      state.config = augmentedConfig;
      state.workspaceAbsolutePath = workspacePath;
      delete state.fatalError;
    });

    pi.on('tool_call', (event, _ctx) => {
      if (pi.getFlag('no-sandbox')) {
        return undefined;
      }

      if (state.config === undefined || state.workspaceAbsolutePath === undefined) {
        return { block: true, reason: 'Sandbox not initialized' };
      }

      let path: string | undefined;
      if (isToolCallEventType('read', event)) {
        path = event.input.path;
      } else if (isToolCallEventType('write', event)) {
        path = event.input.path;
      } else if (isToolCallEventType('edit', event)) {
        path = event.input.path;
      } else {
        return undefined;
      }

      const pathResult = resolveToolPath(path, state.workspaceAbsolutePath);
      if ('block' in pathResult) {
        return { block: true, reason: pathResult.reason };
      }

      const operation: AccessOperation = event.toolName === 'read' ? 'read' : 'write';
      const result = evaluateAccess(
        pathResult.resolved,
        operation,
        state.config.filesystem,
        state.workspaceAbsolutePath,
      );

      if (!result.allowed) {
        const reason =
          result.reason === 'outside-workspace'
            ? `Path outside workspace: ${path}`
            : `Read-only path: ${path}`;
        return { block: true, reason };
      }

      return undefined;
    });

    pi.registerCommand('sandbox-status', {
      description: 'Display the current sandbox state for the workspace.',
      async handler(_args, ctx) {
        if (pi.getFlag('no-sandbox')) {
          ctx.ui.notify('Sandbox status: disabled (--no-sandbox is set).', 'info');
          return;
        }

        const workspacePath = realpathSync(ctx.cwd);
        const containerName = computeContainerName(workspacePath);
        const stateDir = getStateDir(ctx.sessionManager.getSessionDir());

        const { config: effectiveConfig, error: configError } = loadConfigWithFallback(
          workspacePath,
          loadConfigFn,
          state.config,
        );
        if (configError) {
          ctx.ui.notify(
            `Failed to load sandbox config: ${configError.message}. Using in-memory config.`,
            'warning',
          );
        }

        const configHash = computeConfigHash(effectiveConfig);
        const storedHash = readStoredConfigHash(stateDir);

        let containerStatus: 'running' | 'stopped' | 'not found';
        try {
          containerStatus = await getContainerStatusFn(docker, containerName);
        } catch (err) {
          if (err instanceof DockerDaemonUnreachableError) {
            ctx.ui.notify('Docker daemon unreachable', 'error');
            return;
          }
          throw err;
        }

        let sidecarStatus: string | undefined;
        if (hasNetworkPolicy(effectiveConfig)) {
          try {
            sidecarStatus = await getContainerStatusFn(docker, computeSidecarName(workspacePath));
          } catch {
            sidecarStatus = 'unknown';
          }
        }

        let sessionIds: string[] = [];
        try {
          sessionIds = readdirSync(`${stateDir}/sessions`);
        } catch (err) {
          if (!(isNodeError(err) && err.code === 'ENOENT')) {
            throw err;
          }
        }

        const configStaleness = formatConfigStaleness(storedHash, configHash);
        const lines = formatSandboxStatusLines(
          workspacePath,
          containerName,
          containerStatus,
          effectiveConfig,
          configHash,
          configStaleness,
          sessionIds,
          sidecarStatus,
        );

        ctx.ui.notify(lines.join('\n'), 'info');
      },
    });

    pi.registerCommand('sandbox-reset', {
      description:
        'Force-stop and remove the workspace sandbox container, clearing all refcount state.',
      async handler(_args, ctx) {
        if (pi.getFlag('no-sandbox')) {
          ctx.ui.notify('No sandbox state found.', 'warning');
          return;
        }

        const workspacePath = realpathSync(ctx.cwd);
        const stateDir = getStateDir(ctx.sessionManager.getSessionDir());

        if (!existsSync(stateDir)) {
          ctx.ui.notify('No sandbox state found.', 'warning');
          return;
        }

        const { config: effectiveConfig, error: configError } = loadConfigWithFallback(
          workspacePath,
          loadConfigFn,
          state.config,
        );
        if (configError) {
          ctx.ui.notify(
            `Failed to load config for reset: ${configError.message}. Sidecar may not be removed.`,
            'warning',
          );
        }

        const stale = countStaleRefs(stateDir);

        const release = await lifecycleMutex.acquire();
        try {
          await cleanupWorkspaceResources(workspacePath, effectiveConfig);
          state.container = undefined;
          delete state.fatalError;
          state.pull.isPulling = false;
          state.pull.error = undefined;
          resetState(stateDir);
        } finally {
          release();
        }

        ctx.ui.notify(
          `Reset sandbox container. Removed ${String(stale)} stale session reference(s).`,
          'info',
        );
      },
    });

    const ensureConnected = createEnsureConnected({
      state,
      lifecycleMutex,
      startDeps: { docker, doesImageExistFn, ensureContainerFn, pullImageFn },
      acquireSessionRef,
    });

    pi.registerTool({
      name: 'bash',
      label: 'bash (sandboxed)',
      description: 'Execute a command inside the sandbox container.',
      parameters: bashSchema,
      execute: createBashToolHandler({
        getNoSandbox: () => pi.getFlag('no-sandbox') as boolean,
        localBash,
        state,
        execInContainerFn,
        ensureConnected,
        docker,
      }),
    });
  };
}

export default createSandboxExtension();
