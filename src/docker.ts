import Dockerode from "dockerode";
import { mkdirSync } from "node:fs";
import { kill } from "node:process";
import { PassThrough } from "node:stream";
import { truncateTail, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import type { TruncationResult } from "@mariozechner/pi-coding-agent";
import { isNodeError } from "./acl.js";
import type { FilesystemConfig, SandboxConfig } from "./config.js";

export class DockerDaemonUnreachableError extends Error {
  constructor() {
    super("Docker daemon unreachable");
  }
}

export class ContainerNotRunningError extends Error {
  constructor() {
    super("Sandbox container not running");
  }
}

export interface ExecInContainerOptions {
  command: string;
  cwd: string;
  timeout?: number | undefined;
  signal?: AbortSignal | undefined;
  onUpdate?:
    | ((payload: {
        content: { type: "text"; text: string }[];
        details: { truncation?: TruncationResult | undefined };
      }) => void)
    | undefined;
}

export interface ExecInContainerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

interface DockerModem {
  demuxStream(
    source: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
  ): void;
}

/**
 * Kills a Docker exec instance by sending SIGKILL to its host PID.
 *
 * exec.inspect() returns the PID in the caller's PID namespace, so we can
 * kill it directly with process.kill(). This works for both regular and
 * rootless Docker because the PID returned by the daemon is in the same
 * namespace as the Node process. It avoids dockerode's missing exec.kill()
 * and the Engine API's non-existent /exec/{id}/kill endpoint.
 *
 * Ignores ESRCH (process already gone) and Pid 0 (process never started).
 */
async function killExec(exec: Dockerode.Exec, sig: NodeJS.Signals = "SIGKILL"): Promise<void> {
  const info = await exec.inspect();
  const pid = info.Pid;
  if (pid === 0) return;
  try {
    kill(pid, sig);
  } catch (err) {
    if (isNodeError(err) && err.code === "ESRCH") {
      return;
    }
    throw err;
  }
}

export function buildBindMounts(
  filesystem: FilesystemConfig,
  workspaceAbsolutePath: string,
): string[] {
  const mounts: string[] = [
    `${workspaceAbsolutePath}:${workspaceAbsolutePath}:rw`,
  ];
  for (const prefix of filesystem.ro) {
    mounts.push(`${prefix}:${prefix}:ro`);
  }
  for (const prefix of filesystem.rw) {
    mounts.push(`${prefix}:${prefix}:rw`);
  }
  return mounts;
}

export function buildEnvVars(
  env: Record<string, string>,
  hostHomeDirectory: string,
): string[] {
  const vars: Record<string, string> = { HOME: hostHomeDirectory, ...env };
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`);
}

export function createMissingDirs(paths: string[]): void {
  for (const p of paths) {
    mkdirSync(p, { recursive: true });
  }
}

function hasStatusCode(err: unknown, statusCode: number): boolean {
  return err instanceof Error && "statusCode" in err && (err as { statusCode: number }).statusCode === statusCode;
}

export function isDockerNotFound(err: unknown): boolean {
  return hasStatusCode(err, 404);
}

function isDockerConflict(err: unknown): boolean {
  return hasStatusCode(err, 409);
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("enoent") ||
    msg.includes("connect") ||
    msg.includes("socket")
  );
}

function rethrowDockerDaemonError(err: unknown): void {
  if (isConnectionError(err)) {
    throw new DockerDaemonUnreachableError();
  }
}

export async function ensureContainer(
  docker: Dockerode,
  config: SandboxConfig,
  workspaceAbsolutePath: string,
  containerName: string,
  networkMode?: string,
): Promise<{ container: Dockerode.Container; created: boolean }> {
  const container = docker.getContainer(containerName);
  try {
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return { container, created: false };
  } catch (err) {
    if (!isDockerNotFound(err)) {
      rethrowDockerDaemonError(err);
      throw err;
    }
  }

  createMissingDirs([...config.filesystem.ro, ...config.filesystem.rw]);
  try {
    const newContainer = await docker.createContainer({
      name: containerName,
      Image: config.image,
      Cmd: ["sleep", "infinity"],
      HostConfig: {
        NetworkMode: networkMode ?? "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Binds: buildBindMounts(config.filesystem, workspaceAbsolutePath),
      },
      Env: buildEnvVars(config.env, process.env.HOME ?? "/root"),
      WorkingDir: workspaceAbsolutePath,
    });
    await newContainer.start();
    return { container: newContainer, created: true };
  } catch (err) {
    if (!isDockerConflict(err)) {
      rethrowDockerDaemonError(err);
      throw err;
    }
  }

  const existing = docker.getContainer(containerName);
  const existingInfo = await existing.inspect();
  if (!existingInfo.State.Running) {
    await existing.start();
  }
  return { container: existing, created: false };
}

export async function getContainerStatus(
  docker: Dockerode,
  containerName: string,
): Promise<"running" | "stopped" | "not found"> {
  const container = docker.getContainer(containerName);
  try {
    const info = await container.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch (err) {
    if (isDockerNotFound(err)) {
      return "not found";
    }
    rethrowDockerDaemonError(err);
    throw err;
  }
}

export async function stopAndRemoveContainer(
  docker: Dockerode,
  containerName: string,
): Promise<void> {
  const container = docker.getContainer(containerName);

  try {
    await container.stop({ t: 1 });
  } catch (err) {
    if (isDockerNotFound(err)) {
      return;
    }
    rethrowDockerDaemonError(err);
    // Other stop errors (e.g., already stopped) are benign.
  }

  try {
    await container.remove({ force: true });
  } catch (err) {
    if (isDockerNotFound(err)) {
      return;
    }
    rethrowDockerDaemonError(err);
    throw err;
  }
}

export async function killContainer(docker: Dockerode, containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);
  try {
    await container.kill();
  } catch (err) {
    if (isDockerNotFound(err)) {
      return;
    }
    rethrowDockerDaemonError(err);
    // Ignore other errors (e.g., container already stopped)
  }
}

export async function ensureNetwork(docker: Dockerode, networkName: string): Promise<void> {
  const network = docker.getNetwork(networkName);
  try {
    await network.inspect();
  } catch (err) {
    if (!isDockerNotFound(err)) {
      rethrowDockerDaemonError(err);
      throw err;
    }
    try {
      await docker.createNetwork({ Name: networkName, Driver: "bridge" });
    } catch (createErr) {
      if (!isDockerConflict(createErr)) {
        rethrowDockerDaemonError(createErr);
        throw createErr;
      }
    }
  }
}

export async function ensureSidecarContainer(
  docker: Dockerode,
  sidecarImage: string,
  sidecarName: string,
  networkName: string,
  configPath: string,
): Promise<{ container: Dockerode.Container; created: boolean }> {
  const container = docker.getContainer(sidecarName);
  try {
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return { container, created: false };
  } catch (err) {
    if (!isDockerNotFound(err)) {
      rethrowDockerDaemonError(err);
      throw err;
    }
  }

  try {
    const newContainer = await docker.createContainer({
      name: sidecarName,
      Image: sidecarImage,
      Cmd: ["run", "-c", "/etc/sing-box/config.json"],
      HostConfig: {
        NetworkMode: networkName,
        CapAdd: ["NET_ADMIN"],
        Devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" }],
        Binds: [`${configPath}:/etc/sing-box/config.json:ro`],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=10m" },
      },
    });
    await newContainer.start();
    return { container: newContainer, created: true };
  } catch (err) {
    if (!isDockerConflict(err)) {
      rethrowDockerDaemonError(err);
      throw err;
    }
  }

  const existing = docker.getContainer(sidecarName);
  const existingInfo = await existing.inspect();
  if (!existingInfo.State.Running) {
    await existing.start();
  }
  return { container: existing, created: false };
}

export async function stopAndRemoveSidecar(docker: Dockerode, sidecarName: string): Promise<void> {
  await stopAndRemoveContainer(docker, sidecarName);
}

export async function isSidecarHealthy(docker: Dockerode, sidecarName: string): Promise<boolean> {
  try {
    const container = docker.getContainer(sidecarName);
    const info = await container.inspect();
    return info.State.Running;
  } catch (err) {
    if (isDockerNotFound(err) || err instanceof DockerDaemonUnreachableError) {
      return false;
    }
    throw err;
  }
}

export async function watchSidecarEvents(
  docker: Dockerode,
  sidecarName: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts = {
      filters: JSON.stringify({
        container: [sidecarName],
        event: ["die", "stop", "kill", "oom"],
      }),
    };

    docker.getEvents(opts, (err, stream) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!stream) {
        reject(new Error("No event stream"));
        return;
      }

      const readableStream = stream as unknown as import("stream").Readable;

      let resolved = false;
      const cleanup = (): void => {
        if (resolved) return;
        resolved = true;
        readableStream.destroy();
      };

      readableStream.on("data", () => {
        cleanup();
        resolve();
      });
      readableStream.on("end", () => {
        cleanup();
        resolve();
      });
      readableStream.on("error", (e) => {
        cleanup();
        // Fail-closed: stream errors mean we lost visibility into sidecar state.
        // Treat them the same as a sidecar death event (caller will kill the app).
        // If we intentionally aborted the stream after exec won, resolve harmlessly.
        resolve();
      });

      if (signal) {
        const onAbort = (): void => {
          cleanup();
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  });
}

function abortedResult(): ExecInContainerResult {
  return { stdout: "", stderr: "", exitCode: null, timedOut: false, aborted: true };
}

export async function execInContainer(
  container: Dockerode.Container,
  options: ExecInContainerOptions,
): Promise<ExecInContainerResult> {
  const { command, cwd, timeout, signal, onUpdate } = options;

  if (signal?.aborted) {
    return abortedResult();
  }

  const exec = await container.exec({
    Cmd: ["sh", "-c", command],
    WorkingDir: cwd,
    AttachStdout: true,
    AttachStderr: true,
  });

  if (signal?.aborted) {
    return abortedResult();
  }

  const stream = await exec.start({ hijack: true, stdin: false });

  if (signal?.aborted) {
    await killExec(exec, "SIGKILL");
    stream.destroy();
    return abortedResult();
  }

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const rollingChunks: Buffer[] = [];
  let rollingBytes = 0;
  const maxRollingBytes = DEFAULT_MAX_BYTES * 2;

  const pushToRollingBuffer = (chunk: Buffer): void => {
    rollingChunks.push(chunk);
    rollingBytes += chunk.length;
    while (rollingBytes > maxRollingBytes && rollingChunks.length > 1) {
      const removed = rollingChunks.shift();
      if (removed === undefined) break;
      rollingBytes -= removed.length;
    }
  };

  const emitUpdate = (): void => {
    if (!onUpdate) return;
    const fullBuffer = Buffer.concat(rollingChunks);
    const fullText = fullBuffer.toString("utf-8");
    const truncation = truncateTail(fullText, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    onUpdate({
      content: [{ type: "text", text: truncation.content || "" }],
      details: truncation.truncated ? { truncation } : {},
    });
  };

  stdout.on("data", (chunk: Buffer): void => {
    stdoutChunks.push(chunk);
    pushToRollingBuffer(chunk);
    emitUpdate();
  });

  stderr.on("data", (chunk: Buffer): void => {
    stderrChunks.push(chunk);
    pushToRollingBuffer(chunk);
    emitUpdate();
  });

  const modem = (exec as unknown as { modem: DockerModem }).modem;
  modem.demuxStream(stream, stdout, stderr);

  const state = { timedOut: false, aborted: false };
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (timeout !== undefined && timeout > 0) {
    timer = setTimeout(() => {
      state.timedOut = true;
      void killExec(exec, "SIGKILL");
      stream.destroy();
    }, timeout * 1000);
  }

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = (): void => {
      state.aborted = true;
      void killExec(exec, "SIGKILL");
      stream.destroy();
    };
    signal.addEventListener("abort", abortHandler);
  }

  await new Promise<void>((resolve, reject) => {
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      if (state.timedOut || state.aborted) {
        resolve();
      } else {
        reject(err);
      }
    };
    const cleanup = (): void => {
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onError);
  });

  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (abortHandler !== undefined && signal) {
    signal.removeEventListener("abort", abortHandler);
  }

  let exitCode: number | null = null;
  if (!state.timedOut && !state.aborted) {
    try {
      const info = await exec.inspect();
      exitCode = info.ExitCode ?? null;
    } catch (err) {
      if (isDockerNotFound(err)) {
        exitCode = null;
      } else {
        throw err;
      }
    }
  }

  const resultStdout = Buffer.concat(stdoutChunks).toString("utf-8");
  const resultStderr = Buffer.concat(stderrChunks).toString("utf-8");

  return {
    stdout: resultStdout,
    stderr: resultStderr,
    exitCode,
    timedOut: state.timedOut,
    aborted: state.aborted,
  };
}

export async function doesImageExist(
  docker: Dockerode,
  image: string,
): Promise<boolean> {
  try {
    const img = docker.getImage(image);
    await img.inspect();
    return true;
  } catch (err) {
    if (isDockerNotFound(err)) {
      return false;
    }
    throw err;
  }
}

interface PullProgress {
  status?: string;
  error?: string;
}

export async function pullImage(
  docker: Dockerode,
  image: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    (docker as unknown as {
      pull: (
        repoTag: string,
        callback: (err: Error | null, stream: NodeJS.ReadableStream) => void,
      ) => void;
    }).pull(image, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      (docker as unknown as {
        modem: {
          followProgress: (
            stream: NodeJS.ReadableStream,
            callback: (err: Error | null, output: PullProgress[]) => void,
          ) => void;
        };
      }).modem.followProgress(stream, (err, output) => {
        if (err) {
          reject(err);
          return;
        }
        const firstError = output.find((obj) => obj.error)?.error;
        if (firstError) {
          reject(new Error(firstError));
          return;
        }
        resolve();
      });
    });
  });
}
