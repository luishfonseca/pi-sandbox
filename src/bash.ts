import {
  DockerDaemonUnreachableError,
  type ExecInContainerOptions,
  type ExecInContainerResult,
  execInContainer,
  isSidecarHealthy,
  killContainer,
  watchSidecarEvents,
} from './docker.js';
import { computeContainerName, computeSidecarName, getStateDir } from './lifecycle.js';
import { hasNetworkPolicy } from './network.js';
import type { StartSandboxDependencies } from './start-container.js';
import { startSandboxContainer } from './start-container.js';
import type { Mutex, SandboxState } from './state.js';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashTool,
  formatSize,
  truncateTail,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type Dockerode from 'dockerode';

export const bashSchema = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }),
  ),
});

export interface BashToolDependencies {
  getNoSandbox: () => boolean;
  localBash: ReturnType<typeof createBashTool>;
  state: SandboxState;
  execInContainerFn: typeof execInContainer;
  ensureConnected: (
    ctx: ExtensionContext,
  ) => Promise<{ container: Dockerode.Container } | { error: string }>;
  docker: Dockerode;
}

export interface EnsureConnectedOptions {
  state: SandboxState;
  lifecycleMutex: Mutex;
  startDeps: StartSandboxDependencies;
  acquireSessionRef: (stateDir: string, sessionId: string) => void;
}

async function isHealthy(container: Dockerode.Container): Promise<boolean> {
  try {
    const info = await container.inspect();
    return info.State.Running;
  } catch (err) {
    if (
      (err as { statusCode?: number }).statusCode === 404 ||
      err instanceof DockerDaemonUnreachableError
    ) {
      return false;
    }
    throw err;
  }
}

export function createEnsureConnected(
  options: EnsureConnectedOptions,
): (ctx: ExtensionContext) => Promise<{ container: Dockerode.Container } | { error: string }> {
  return async function ensureConnected(ctx) {
    const workspaceAbsolutePath = options.state.workspaceAbsolutePath;
    if (workspaceAbsolutePath === undefined || options.state.config === undefined) {
      return { error: 'Sandbox not initialized' };
    }

    if (options.state.fatalError) {
      return { error: options.state.fatalError };
    }

    const stateDir = getStateDir(ctx.sessionManager.getSessionDir());
    options.acquireSessionRef(stateDir, ctx.sessionManager.getSessionId());

    const container = options.state.container;

    // Fast-path: container looks healthy.
    if (container !== undefined && (await isHealthy(container))) {
      return { container };
    }

    const release = await options.lifecycleMutex.acquire();
    try {
      // Double-check inside the mutex.
      const container = options.state.container;
      if (container !== undefined && (await isHealthy(container))) {
        return { container };
      }

      if (options.state.pull.error) {
        return { error: `Sandbox unavailable: ${options.state.pull.error}` };
      }

      const containerName = computeContainerName(workspaceAbsolutePath);
      const result = await startSandboxContainer(
        options.state,
        options.startDeps,
        options.state.config,
        workspaceAbsolutePath,
        containerName,
        stateDir,
      );

      if (result.kind === 'pulling') {
        return { error: `Pulling sandbox image ${options.state.config.image}...` };
      }

      if (result.configStaleness) {
        ctx.ui.notify('Sandbox config has changed. Run /sandbox-reset to recreate.', 'warning');
      }

      const finalContainer = options.state.container;
      if (finalContainer === undefined) {
        return { error: 'Sandbox container not running' };
      }
      return { container: finalContainer };
    } finally {
      release();
    }
  };
}

function createErrorResult(
  text: string,
  details?: Record<string, unknown>,
): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text' as const, text }],
    details: details ?? { error: text },
    isError: true,
  } as AgentToolResult<unknown>;
}

function parseTimeout(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return undefined;
}

function buildExecOptions(
  command: string,
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): ExecInContainerOptions {
  const opts: ExecInContainerOptions = { command, cwd, signal, onUpdate };
  if (timeout !== undefined) {
    opts.timeout = timeout;
  }
  return opts;
}

interface SidecarMonitor {
  abortController: AbortController;
  deathPromise: Promise<void>;
}

async function beginSidecarMonitoring(
  docker: Dockerode,
  workspaceAbsolutePath: string,
): Promise<{ monitor: SidecarMonitor } | { error: string }> {
  const sidecarName = computeSidecarName(workspaceAbsolutePath);
  const abortController = new AbortController();
  const deathPromise = watchSidecarEvents(docker, sidecarName, abortController.signal);

  const healthy = await isSidecarHealthy(docker, sidecarName);
  if (!healthy) {
    abortController.abort();
    return {
      error: 'Egress sidecar is not healthy. Run /sandbox-reset to recreate the sandbox.',
    };
  }

  return { monitor: { abortController, deathPromise } };
}

async function raceExecAgainstSidecar(
  execPromise: Promise<ExecInContainerResult>,
  sidecarDeathPromise: Promise<void>,
  docker: Dockerode,
  workspaceAbsolutePath: string,
): Promise<{ result: ExecInContainerResult } | { error: string }> {
  const execWrapped = execPromise.then((r) => ({ type: 'exec' as const, result: r }));
  const sidecarWrapped = sidecarDeathPromise.then(() => ({ type: 'sidecar' as const }));

  const race = await Promise.race([execWrapped, sidecarWrapped]);

  if (race.type === 'sidecar') {
    const appName = computeContainerName(workspaceAbsolutePath);
    await killContainer(docker, appName);
    try {
      await execPromise;
    } catch {
      /* ignore */
    }
    return {
      error:
        'Egress sidecar died during command execution. Run /sandbox-reset to recreate the sandbox.',
    };
  }

  return { result: race.result };
}

function formatExecResult(
  execResult: ExecInContainerResult,
  timeout: number | undefined,
): {
  text: string;
  isError: boolean;
  details: { exitCode: number | null; stdout: string; stderr: string };
} {
  const combinedOutput = execResult.stdout + execResult.stderr;
  const truncation = truncateTail(combinedOutput, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let text = truncation.content || '';
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
  }

  if (execResult.aborted) {
    text += '\n\nCommand aborted';
    return {
      text,
      isError: true,
      details: {
        exitCode: null,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
      },
    };
  }

  if (execResult.timedOut) {
    text += `\n\nCommand timed out after ${String(timeout)} seconds`;
    return {
      text,
      isError: true,
      details: {
        exitCode: null,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
      },
    };
  }

  if (execResult.exitCode !== 0 && execResult.exitCode !== null) {
    text += `\n\nCommand exited with code ${String(execResult.exitCode)}`;
  }
  if (!text) {
    text = '(no output)';
  }

  return {
    text,
    isError: execResult.exitCode !== 0,
    details: {
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
    },
  };
}

export function createBashToolHandler(
  deps: BashToolDependencies,
): (
  toolCallId: string,
  params: { command: string; timeout?: number },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>> {
  return async function execute(
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ctx: ExtensionContext,
  ) {
    if (deps.getNoSandbox()) {
      return deps.localBash.execute(toolCallId, params, signal, onUpdate);
    }

    if (deps.state.fatalError) {
      return createErrorResult(deps.state.fatalError);
    }

    if (deps.state.pull.isPulling) {
      return createErrorResult(
        `Pulling sandbox image ${deps.state.config?.image ?? 'unknown'}...`,
        { error: 'Image pull in progress' },
      );
    }

    const connected = await deps.ensureConnected(ctx);
    if ('error' in connected) {
      return createErrorResult(connected.error);
    }

    const container = connected.container;
    const workspaceAbsolutePath = deps.state.workspaceAbsolutePath;

    if (workspaceAbsolutePath === undefined) {
      return createErrorResult('Sandbox container not running');
    }

    try {
      const timeout = parseTimeout(params.timeout);
      const execOptions = buildExecOptions(
        params.command,
        workspaceAbsolutePath,
        timeout,
        signal,
        onUpdate,
      );

      let sidecarMonitor: SidecarMonitor | undefined;
      if (deps.state.config && hasNetworkPolicy(deps.state.config)) {
        const monitorResult = await beginSidecarMonitoring(deps.docker, workspaceAbsolutePath);
        if ('error' in monitorResult) {
          deps.state.fatalError = monitorResult.error;
          return createErrorResult(monitorResult.error);
        }
        sidecarMonitor = monitorResult.monitor;
      }

      const execPromise = deps.execInContainerFn(container, execOptions);

      let execResult: ExecInContainerResult;
      if (sidecarMonitor) {
        const raceResult = await raceExecAgainstSidecar(
          execPromise,
          sidecarMonitor.deathPromise,
          deps.docker,
          workspaceAbsolutePath,
        );
        sidecarMonitor.abortController.abort();
        if ('error' in raceResult) {
          deps.state.fatalError = raceResult.error;
          return createErrorResult(raceResult.error);
        }
        execResult = raceResult.result;
      } else {
        execResult = await execPromise;
      }

      const formatted = formatExecResult(execResult, timeout);
      return {
        content: [{ type: 'text' as const, text: formatted.text }],
        details: formatted.details,
        isError: formatted.isError,
      };
    } catch (err) {
      if (err instanceof DockerDaemonUnreachableError) {
        return createErrorResult('Docker daemon unreachable', {
          error: 'Docker daemon unreachable',
        });
      }
      throw err;
    }
  };
}
