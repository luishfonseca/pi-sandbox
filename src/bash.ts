import type { ExtensionContext, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  truncateTail,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execInContainer, DockerDaemonUnreachableError, isDockerNotFound } from "./docker.js";
import type Dockerode from "dockerode";
import type { SandboxState, Mutex } from "./state.js";
import type { StartSandboxDependencies } from "./start-container.js";
import { startSandboxContainer } from "./start-container.js";
import { computeContainerName, getStateDir } from "./lifecycle.js";

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
}

export interface EnsureConnectedOptions {
  state: SandboxState;
  lifecycleMutex: Mutex;
  startDeps: StartSandboxDependencies;
  acquireSessionRef: (stateDir: string, sessionId: string) => void;
}

export function createEnsureConnected(options: EnsureConnectedOptions): (
  ctx: ExtensionContext,
) => Promise<{ container: Dockerode.Container } | { error: string }> {
  return async function ensureConnected(ctx) {
    const workspaceAbsolutePath = options.state.workspaceAbsolutePath;
    if (workspaceAbsolutePath === undefined || options.state.config === undefined) {
      return { error: "Sandbox not initialized" };
    }

    const stateDir = getStateDir(ctx.sessionManager.getSessionDir());
    options.acquireSessionRef(stateDir, ctx.sessionManager.getSessionId());

    const container = options.state.container;

    // Fast-path: container looks healthy.
    let needsConnect = container === undefined;
    if (!needsConnect && container !== undefined) {
      try {
        const info = await container.inspect();
        if (!info.State.Running) {
          needsConnect = true;
        }
      } catch (err) {
        if (isDockerNotFound(err) || err instanceof DockerDaemonUnreachableError) {
          needsConnect = true;
        } else {
          throw err;
        }
      }
    }

    if (!needsConnect) {
      const readyContainer = container;
      if (readyContainer === undefined) {
        return { error: "Sandbox container not running" };
      }
      return { container: readyContainer };
    }

    const release = await options.lifecycleMutex.acquire();
    try {
      // Double-check inside the mutex.
      let stillNeedsConnect = options.state.container === undefined;
      if (!stillNeedsConnect && options.state.container !== undefined) {
        try {
          const info = await options.state.container.inspect();
          if (!info.State.Running) {
            stillNeedsConnect = true;
          }
        } catch (err) {
          if (isDockerNotFound(err) || err instanceof DockerDaemonUnreachableError) {
            stillNeedsConnect = true;
          } else {
            throw err;
          }
        }
      }

      if (!stillNeedsConnect) {
        const existingContainer = options.state.container;
        if (existingContainer === undefined) {
          return { error: "Sandbox container not running" };
        }
        return { container: existingContainer };
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
  _ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>> {
  return async function execute(
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ) {
    if (deps.getNoSandbox()) {
      return deps.localBash.execute(toolCallId, params, signal, onUpdate);
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

    const connected = await deps.ensureConnected(_ctx);
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
      const result = await deps.execInContainerFn(container, execOptions);

      const combinedOutput = result.stdout + result.stderr;
      const truncation = truncateTail(combinedOutput, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content || "";
      if (truncation.truncated) {
        text += `\n\n[Output truncated: ${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
      }

      if (result.aborted) {
        text += "\n\nCommand aborted";
        return {
          content: [{ type: "text" as const, text }],
          details: {
            exitCode: null,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          isError: true,
        };
      }

      if (result.timedOut) {
        text += `\n\nCommand timed out after ${String(timeout)} seconds`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            exitCode: null,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          isError: true,
        };
      }

      if (result.exitCode !== 0 && result.exitCode !== null) {
        text += `\n\nCommand exited with code ${String(result.exitCode)}`;
      }
      if (!text) {
        text = "(no output)";
      }
      return {
        content: [{ type: "text" as const, text }],
        details: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        isError: result.exitCode !== 0,
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
