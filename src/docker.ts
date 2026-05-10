import Dockerode from "dockerode";
import { mkdirSync } from "node:fs";
import type { FilesystemConfig, SandboxConfig } from "./config.js";
import { PassThrough } from "node:stream";

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

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ExecWithModem {
  modem: {
    demuxStream(
      source: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ): void;
  };
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
    try {
      mkdirSync(p, { recursive: true });
    } catch {
      // Ignore; Docker will surface the real error if the path is unusable.
    }
  }
}

function isDockerNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    "statusCode" in err &&
    (err as { statusCode: number }).statusCode === 404
  );
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

export async function ensureContainer(
  docker: Dockerode,
  config: SandboxConfig,
  workspaceAbsolutePath: string,
  containerName: string,
): Promise<Dockerode.Container> {
  const container = docker.getContainer(containerName);
  try {
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return container;
  } catch (err) {
    if (isDockerNotFound(err)) {
      createMissingDirs([...config.filesystem.ro, ...config.filesystem.rw]);
      const newContainer = await docker.createContainer({
        name: containerName,
        Image: config.image,
        Cmd: ["sleep", "infinity"],
        HostConfig: {
          NetworkMode: "none",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Binds: buildBindMounts(config.filesystem, workspaceAbsolutePath),
        },
        Env: buildEnvVars(config.env, process.env.HOME ?? "/root"),
        WorkingDir: workspaceAbsolutePath,
      });
      await newContainer.start();
      return newContainer;
    }
    if (isConnectionError(err)) {
      throw new DockerDaemonUnreachableError();
    }
    throw err;
  }
}

export async function execInContainer(
  container: Dockerode.Container,
  command: string,
  cwd?: string,
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: ["sh", "-c", command],
    WorkingDir: cwd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  (exec as ExecWithModem).modem.demuxStream(stream, stdout, stderr);

  await new Promise<void>((resolve, reject) => {
    stream.on("end", () => {
      resolve();
    });
    stream.on("error", (err) => {
      reject(err);
    });
  });

  const info = await exec.inspect();
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
    stderr: Buffer.concat(stderrChunks).toString("utf-8"),
    exitCode: info.ExitCode ?? -1,
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
        const firstError = output?.find((obj) => obj.error)?.error;
        if (firstError) {
          reject(new Error(firstError));
          return;
        }
        resolve();
      });
    });
  });
}
