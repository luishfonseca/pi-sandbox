import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { realpathSync, readdirSync } from "node:fs";
import Dockerode from "dockerode";
import { evaluateAccess, resolvePath, resolveSymlinks, type AccessOperation } from "./acl.js";
import { loadConfig, validateConfig, augmentConfigWithPiDir, type SandboxConfig } from "./config.js";
import {
  ensureContainer,
  execInContainer,
  DockerDaemonUnreachableError,
  doesImageExist,
  pullImage,
  stopAndRemoveContainer,
  getContainerStatus,
} from "./docker.js";
import { bashSchema, createBashToolHandler } from "./bash.js";
import {
  computeContainerName,
  computeConfigHash,
  getStateDir,
  acquireSessionRef,
  releaseSessionRef,
  readStoredConfigHash,
  writeConfigHash,
  deleteConfigHash,
  countLeakedRefs,
  resetState,
} from "./lifecycle.js";

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

export function createSandboxExtension(options: SandboxExtensionOptions = {}): (pi: ExtensionAPI) => void {
  return function (pi: ExtensionAPI): void {
    pi.registerFlag("no-sandbox", {
      description: "Disable the Docker sandbox extension",
      type: "boolean",
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

    let workspaceAbsolutePath: string | undefined;
    let container: Dockerode.Container | undefined;
    let config: SandboxConfig | undefined;
    let isPulling = false;
    let pullError: string | undefined;

    pi.on("session_shutdown", async (_event, ctx) => {
      if (pi.getFlag("no-sandbox")) {
        return;
      }
      if (workspaceAbsolutePath === undefined) {
        return;
      }

      const containerName = computeContainerName(workspaceAbsolutePath);
      const stateDir = getStateDir(ctx.sessionManager.getSessionDir());
      const isEmpty = releaseSessionRef(stateDir, ctx.sessionManager.getSessionId());

      if (isEmpty) {
        await stopAndRemoveContainerFn(docker, containerName);
        deleteConfigHash(stateDir);
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      if (pi.getFlag("no-sandbox")) {
        return;
      }

      const { config: loadedConfig, warnings } = loadConfigFn(ctx.cwd);
      for (const warning of warnings) {
        ctx.ui.notify(warning, "warning");
      }
      const augmentResult = augmentConfigWithPiDir(loadedConfig);
      if (augmentResult.warning) {
        ctx.ui.notify(augmentResult.warning, "warning");
      }
      validateConfig(loadedConfig);

      const workspacePath = realpathSync(ctx.cwd);
      const containerName = computeContainerName(workspacePath);
      const configHash = computeConfigHash(loadedConfig);
      const stateDir = getStateDir(ctx.sessionManager.getSessionDir());

      config = loadedConfig;
      workspaceAbsolutePath = workspacePath;

      acquireSessionRef(stateDir, ctx.sessionManager.getSessionId());

      const imageExists = await doesImageExistFn(docker, loadedConfig.image);
      if (!imageExists) {
        isPulling = true;
        pullError = undefined;
        pullImageFn(docker, loadedConfig.image)
          .then(async () => {
            const { container: runningContainer } = await ensureContainerFn(
              docker,
              loadedConfig,
              workspacePath,
              containerName,
            );
            writeConfigHash(stateDir, configHash);
            container = runningContainer;
          })
          .catch((err: unknown) => {
            pullError = err instanceof Error ? err.message : String(err);
          })
          .finally(() => {
            isPulling = false;
          });
        return;
      }

      const { container: runningContainer, created } = await ensureContainerFn(
        docker,
        loadedConfig,
        workspacePath,
        containerName,
      );
      if (created) {
        writeConfigHash(stateDir, configHash);
      } else {
        const storedHash = readStoredConfigHash(stateDir);
        if (storedHash !== undefined && storedHash !== configHash) {
          ctx.ui.notify("Sandbox config has changed. Run /sandbox-reset to recreate.", "warning");
        }
        if (storedHash === undefined) {
          writeConfigHash(stateDir, configHash);
        }
      }
      container = runningContainer;
    });

    pi.on("tool_call", (event, _ctx) => {
      if (pi.getFlag("no-sandbox")) {
        return undefined;
      }

      if (config === undefined || workspaceAbsolutePath === undefined) {
        return { block: true, reason: "Sandbox not initialized" };
      }

      let path: string | undefined;
      if (isToolCallEventType("read", event)) {
        path = event.input.path;
      } else if (isToolCallEventType("write", event)) {
        path = event.input.path;
      } else if (isToolCallEventType("edit", event)) {
        path = event.input.path;
      } else {
        return undefined;
      }

      if (typeof path !== "string") {
        return { block: true, reason: "Missing or invalid path argument" };
      }

      const normalized = resolvePath(path, workspaceAbsolutePath);

      let resolved: string;
      try {
        resolved = resolveSymlinks(normalized);
      } catch (err) {
        if (err instanceof Error && "code" in err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            return { block: true, reason: `Path outside workspace: ${path}` };
          }
          if (code === "EACCES") {
            return { block: true, reason: `Permission denied resolving path: ${path}` };
          }
          if (code === "ELOOP") {
            return { block: true, reason: `Symlink loop detected: ${path}` };
          }
          if (code === "ENOTDIR") {
            return { block: true, reason: `Not a directory in path: ${path}` };
          }
        }
        throw err;
      }

      const operation: AccessOperation = event.toolName === "read" ? "read" : "write";
      const result = evaluateAccess(resolved, operation, config.filesystem, workspaceAbsolutePath);

      if (!result.allowed) {
        const reason =
          result.reason === "outside-workspace"
            ? `Path outside workspace: ${path}`
            : `Read-only path: ${path}`;
        return { block: true, reason };
      }

      return undefined;
    });

    pi.registerCommand("sandbox-status", {
      description: "Display the current sandbox state for the workspace.",
      async handler(_args, ctx) {
        if (pi.getFlag("no-sandbox")) {
          ctx.ui.notify("Sandbox status: disabled (--no-sandbox is set).", "info");
          return;
        }

        const workspacePath = workspaceAbsolutePath ?? realpathSync(ctx.cwd);
        const containerName = computeContainerName(workspacePath);
        const stateDir = getStateDir(ctx.sessionManager.getSessionDir());

        let effectiveConfig: SandboxConfig;
        try {
          const { config: loadedConfig } = loadConfigFn(workspacePath);
          augmentConfigWithPiDir(loadedConfig);
          effectiveConfig = loadedConfig;
        } catch {
          effectiveConfig = {
            image: config?.image ?? "unknown",
            env: config?.env ?? {},
            filesystem: config?.filesystem ?? { rw: [], ro: [] },
          };
        }

        const configHash = computeConfigHash(effectiveConfig);
        const storedHash = readStoredConfigHash(stateDir);

        let containerStatus: "running" | "stopped" | "not found";
        try {
          containerStatus = await getContainerStatusFn(docker, containerName);
        } catch (err) {
          if (err instanceof DockerDaemonUnreachableError) {
            ctx.ui.notify("Docker daemon unreachable", "error");
            return;
          }
          throw err;
        }

        let sessionIds: string[] = [];
        try {
          sessionIds = readdirSync(`${stateDir}/sessions`);
        } catch {
          // ignore
        }

        let configStaleness: string;
        if (storedHash === undefined) {
          configStaleness = "unknown";
        } else if (storedHash === configHash) {
          configStaleness = "current";
        } else {
          configStaleness = `stale — running container was created with ${storedHash}`;
        }

        const lines = [
          "Sandbox status:",
          `Workspace: ${workspacePath}`,
          `Container: ${containerName} (${containerStatus})`,
          `Image: ${effectiveConfig.image}`,
          `Config hash: ${configHash} (${configStaleness})`,
          "Filesystem:",
          `  rw: ${effectiveConfig.filesystem.rw.join(", ") || "(none)"}`,
          `  ro: ${effectiveConfig.filesystem.ro.join(", ") || "(none)"}`,
          `Sessions: ${String(sessionIds.length)} active (${sessionIds.slice(0, 10).join(", ")}${sessionIds.length > 10 ? ", ..." : ""})`,
        ];

        ctx.ui.notify(lines.join("\n"), "info");
      },
    });

    pi.registerCommand("sandbox-reset", {
      description: "Force-stop and remove the workspace sandbox container, clearing all refcount state.",
      async handler(_args, ctx) {
        if (pi.getFlag("no-sandbox")) {
          ctx.ui.notify("No sandbox state found.", "warning");
          return;
        }

        const workspacePath = workspaceAbsolutePath ?? realpathSync(ctx.cwd);
        const containerName = computeContainerName(workspacePath);
        const stateDir = getStateDir(ctx.sessionManager.getSessionDir());

        let hasState = false;
        try {
          readdirSync(stateDir);
          hasState = true;
        } catch (err) {
          if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            hasState = false;
          } else {
            throw err;
          }
        }

        if (!hasState) {
          ctx.ui.notify("No sandbox state found.", "warning");
          return;
        }

        const leaked = countLeakedRefs(stateDir);
        await stopAndRemoveContainerFn(docker, containerName);
        resetState(stateDir);
        ctx.ui.notify(`Reset sandbox container. Removed ${String(leaked)} leaked session reference(s).`, "info");
      },
    });

    pi.registerTool({
      name: "bash",
      label: "bash (sandboxed)",
      description: "Execute a command inside the sandbox container.",
      parameters: bashSchema,
      execute: createBashToolHandler({
        getNoSandbox: () => pi.getFlag("no-sandbox") as boolean,
        localBash,
        getIsPulling: () => isPulling,
        getPullError: () => pullError,
        getConfig: () => config,
        getContainer: () => container,
        getWorkspaceAbsolutePath: () => workspaceAbsolutePath,
        execInContainerFn,
      }),
    });
  };
}

export default createSandboxExtension();
