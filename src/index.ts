import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { realpathSync } from "node:fs";
import Dockerode from "dockerode";
import { evaluateAccess, resolvePath, type AccessOperation } from "./acl.js";
import { loadConfig, type SandboxConfig } from "./config.js";
import {
  ensureContainer,
  execInContainer,
  DockerDaemonUnreachableError,
  doesImageExist,
  pullImage,
} from "./docker.js";

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
});

export interface SandboxExtensionOptions {
  docker?: Dockerode;
  loadConfigFn?: typeof loadConfig;
  ensureContainerFn?: typeof ensureContainer;
  execInContainerFn?: typeof execInContainer;
  doesImageExistFn?: typeof doesImageExist;
  pullImageFn?: typeof pullImage;
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

    let workspaceAbsolutePath: string | undefined;
    let container: Dockerode.Container | undefined;
    let config: SandboxConfig | undefined;
    let isPulling = false;
    let pullError: string | undefined;

    pi.on("session_shutdown", async () => {
      // Container persists across sessions by design.
    });

    pi.on("session_start", async (_event, ctx) => {
      if (pi.getFlag("no-sandbox")) {
        return;
      }

      const loadedConfig = loadConfigFn(ctx.cwd);
      const workspacePath = realpathSync(ctx.cwd);
      const containerName = `pi-sandbox-${ctx.sessionManager.getSessionId()}`;

      config = loadedConfig;
      workspaceAbsolutePath = workspacePath;

      const imageExists = await doesImageExistFn(docker, loadedConfig.image);
      if (!imageExists) {
        isPulling = true;
        pullError = undefined;
        pullImageFn(docker, loadedConfig.image)
          .then(async () => {
            const runningContainer = await ensureContainerFn(
              docker,
              loadedConfig,
              workspacePath,
              containerName,
            );
            container = runningContainer;
          })
          .catch((err) => {
            pullError = err instanceof Error ? err.message : String(err);
          })
          .finally(() => {
            isPulling = false;
          });
        return;
      }

      const runningContainer = await ensureContainerFn(
        docker,
        loadedConfig,
        workspacePath,
        containerName,
      );
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

      const resolved = resolvePath(path, workspaceAbsolutePath);
      const operation: AccessOperation = event.toolName === "read" ? "read" : "write";
      const result = evaluateAccess(resolved, operation, config.filesystem, workspaceAbsolutePath);

      if (!result.allowed) {
        return { block: true, reason: result.reason ?? "Path blocked by sandbox policy" };
      }

      return undefined;
    });

    pi.registerTool({
      name: "bash",
      label: "bash (sandboxed)",
      description: "Execute a command inside the sandbox container.",
      parameters: bashSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (pi.getFlag("no-sandbox")) {
          return localBash.execute(_toolCallId, params, _signal, _onUpdate);
        }

        if (isPulling) {
          return {
            content: [
              {
                type: "text",
                text: `Pulling sandbox image ${config?.image ?? "unknown"}...`,
              },
            ],
            details: { error: "Image pull in progress" },
            isError: true,
          };
        }
        if (container === undefined || workspaceAbsolutePath === undefined) {
          if (pullError) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to pull sandbox image: ${pullError}`,
                },
              ],
              details: { error: pullError },
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: "Sandbox container not running" }],
            details: { error: "Sandbox container not running" },
            isError: true,
          };
        }

        const cwd = ctx.cwd;

        try {
          const info = await container.inspect();
          if (!info.State.Running) {
            return {
              content: [{ type: "text", text: "Sandbox container not running" }],
              details: { error: "Sandbox container not running" },
              isError: true,
            };
          }

          const result = await execInContainerFn(container, params.command, cwd);
          const text = result.stdout + (result.stderr ? result.stderr : "");
          return {
            content: [{ type: "text", text: text || "(no output)" }],
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
              content: [{ type: "text", text: "Docker daemon unreachable" }],
              details: { error: "Docker daemon unreachable" },
              isError: true,
            };
          }
          throw err;
        }
      },
    });
  };
}

export default createSandboxExtension();
