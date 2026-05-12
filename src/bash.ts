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
import type { SandboxState } from "./state.js";

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

    const container = deps.state.container;
    const workspaceAbsolutePath = deps.state.workspaceAbsolutePath;

    if (container === undefined || workspaceAbsolutePath === undefined) {
      const pullError = deps.state.pull.error;
      if (pullError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Sandbox unavailable: ${pullError}`,
            },
          ],
          details: { error: pullError },
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: "Sandbox container not running" }],
        details: { error: "Sandbox container not running" },
        isError: true,
      };
    }

    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        return {
          content: [{ type: "text" as const, text: "Sandbox container not running" }],
          details: { error: "Sandbox container not running" },
          isError: true,
        };
      }
    } catch (err) {
      if (isDockerNotFound(err)) {
        return {
          content: [{ type: "text" as const, text: "Sandbox container not running" }],
          details: { error: "Sandbox container not running" },
          isError: true,
        };
      }
      if (err instanceof DockerDaemonUnreachableError) {
        return {
          content: [{ type: "text" as const, text: "Docker daemon unreachable" }],
          details: { error: "Docker daemon unreachable" },
          isError: true,
        };
      }
      throw err;
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
