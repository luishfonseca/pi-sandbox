import type { ExtensionContext, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  truncateTail,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import Dockerode from "dockerode";
import { execInContainer, DockerDaemonUnreachableError, isSidecarHealthy, watchSidecarEvents, killContainer } from "./docker.js";
import type { SandboxState, Mutex } from "./state.js";
import type { StartSandboxDependencies } from "./start-container.js";
import { startSandboxContainer } from "./start-container.js";
import { computeContainerName, computeSidecarName, getStateDir } from "./lifecycle.js";
import { hasNetworkPolicy } from "./network.js";

export const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
});

export interface BashToolDependencies {
  getNoSandbox: () => boolean;
  localBash: ReturnType<typeof createBashTool>;
  state: SandboxState;
  execInContainerFn: typeof execInContainer;
  ensureConnected: (ctx: ExtensionContext) => Promise<{ container: Dockerode.Container } | { error: string }>;
  docker: Dockerode;
  isSidecarHealthyFn?: typeof isSidecarHealthy;
  watchSidecarEventsFn?: typeof watchSidecarEvents;
  killContainerFn?: typeof killContainer;
  computeSidecarNameFn?: typeof computeSidecarName;
  computeContainerNameFn?: typeof computeContainerName;
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
    if ((err as { statusCode?: number }).statusCode === 404 || err instanceof DockerDaemonUnreachableError) {
      return false;
    }
    throw err;
  }
}

export function createEnsureConnected(options: EnsureConnectedOptions): (
  ctx: ExtensionContext,
) => Promise<{ container: Dockerode.Container } | { error: string }> {
  return async function ensureConnected(ctx) {
    const workspaceAbsolutePath = options.state.workspaceAbsolutePath;
    if (workspaceAbsolutePath === undefined || options.state.config === undefined) {
      return { error: "Sandbox not initialized" };
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

      if (result.kind === "pulling") {
        return { error: `Pulling sandbox image ${options.state.config.image}...` };
      }

      if (result.configStaleness) {
        ctx.ui.notify("Sandbox config has changed. Run /sandbox-reset to recreate.", "warning");
      }

      const finalContainer = options.state.container;
      if (finalContainer === undefined) {
        return { error: "Sandbox container not running" };
      }
      return { container: finalContainer };
    } finally {
      release();
    }
  };
}

export function createBashToolHandler(deps: BashToolDependencies): (
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
      return {
        content: [{ type: "text" as const, text: deps.state.fatalError }],
        details: { error: deps.state.fatalError },
        isError: true,
      };
    }

    if (deps.state.pull.isPulling) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Pulling sandbox image ${deps.state.config?.image ?? "unknown"}...`,
          },
        ],
        details: { error: "Image pull in progress" },
        isError: true,
      };
    }

    const connected = await deps.ensureConnected(ctx);
    if ("error" in connected) {
      return {
        content: [{ type: "text" as const, text: connected.error }],
        details: { error: connected.error },
        isError: true,
      };
    }

    const container = connected.container;
    const workspaceAbsolutePath = deps.state.workspaceAbsolutePath;

    if (workspaceAbsolutePath === undefined) {
      return {
        content: [{ type: "text" as const, text: "Sandbox container not running" }],
        details: { error: "Sandbox container not running" },
        isError: true,
      };
    }

    try {
      let timeout: number | undefined;
      if (
        typeof params.timeout === "number" &&
        Number.isFinite(params.timeout) &&
        params.timeout > 0
      ) {
        timeout = params.timeout;
      }

      const execOptions: import("./docker.js").ExecInContainerOptions = {
        command: params.command,
        cwd: workspaceAbsolutePath,
        signal,
        onUpdate,
      };
      if (timeout !== undefined) {
        execOptions.timeout = timeout;
      }

      let sidecarDeathPromise: Promise<void> | undefined;
      let sidecarAbortController: AbortController | undefined;

      if (deps.state.config && hasNetworkPolicy(deps.state.config)) {
        const sidecarName = (deps.computeSidecarNameFn ?? computeSidecarName)(workspaceAbsolutePath);

        // Start the watcher BEFORE the point-in-time health check to close the
        // race window where the sidecar dies between inspection and subscription.
        sidecarAbortController = new AbortController();
        sidecarDeathPromise = (deps.watchSidecarEventsFn ?? watchSidecarEvents)(deps.docker, sidecarName, sidecarAbortController.signal);

        const healthy = await (deps.isSidecarHealthyFn ?? isSidecarHealthy)(deps.docker, sidecarName);
        if (!healthy) {
          sidecarAbortController.abort();
          deps.state.fatalError = "Egress sidecar is not healthy. Run /sandbox-reset to recreate the sandbox.";
          return {
            content: [{ type: "text" as const, text: deps.state.fatalError }],
            details: { error: deps.state.fatalError },
            isError: true,
          };
        }
      }

      const execPromise = deps.execInContainerFn(container, execOptions);

      let execResult: import("./docker.js").ExecInContainerResult;

      if (sidecarDeathPromise) {
        const execWrapped = execPromise.then((r) => ({ type: "exec" as const, result: r }));
        const sidecarWrapped = sidecarDeathPromise.then(() => ({ type: "sidecar" as const }));

        const race = await Promise.race([execWrapped, sidecarWrapped]);

        if (race.type === "sidecar") {
          const appName = (deps.computeContainerNameFn ?? computeContainerName)(workspaceAbsolutePath);
          await (deps.killContainerFn ?? killContainer)(deps.docker, appName);
          try { await execPromise; } catch { /* ignore */ }
          deps.state.fatalError = "Egress sidecar died during command execution. Run /sandbox-reset to recreate the sandbox.";
          return {
            content: [{ type: "text" as const, text: deps.state.fatalError }],
            details: { error: deps.state.fatalError },
            isError: true,
          };
        }

        sidecarAbortController?.abort();
        execResult = race.result;
      } else {
        execResult = await execPromise;
      }

      const combinedOutput = execResult.stdout + execResult.stderr;
      const truncation = truncateTail(combinedOutput, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content || "";
      if (truncation.truncated) {
        text += `\n\n[Output truncated: ${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
      }

      if (execResult.aborted) {
        text += "\n\nCommand aborted";
        return {
          content: [{ type: "text" as const, text }],
          details: {
            exitCode: null,
            stdout: execResult.stdout,
            stderr: execResult.stderr,
          },
          isError: true,
        };
      }

      if (execResult.timedOut) {
        text += `\n\nCommand timed out after ${String(timeout)} seconds`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            exitCode: null,
            stdout: execResult.stdout,
            stderr: execResult.stderr,
          },
          isError: true,
        };
      }

      if (execResult.exitCode !== 0 && execResult.exitCode !== null) {
        text += `\n\nCommand exited with code ${String(execResult.exitCode)}`;
      }
      if (!text) {
        text = "(no output)";
      }
      return {
        content: [{ type: "text" as const, text }],
        details: {
          exitCode: execResult.exitCode,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
        },
        isError: execResult.exitCode !== 0,
      };
    } catch (err) {
      if (err instanceof DockerDaemonUnreachableError) {
        return {
          content: [{ type: "text" as const, text: "Docker daemon unreachable" }],
          details: { error: "Docker daemon unreachable" },
          isError: true,
        };
      }
      throw err;
    }
  };
}
