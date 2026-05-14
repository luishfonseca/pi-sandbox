import { isNodeError } from './acl.js';
import type { FilesystemConfig, SandboxConfig } from './config.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from '@mariozechner/pi-coding-agent';
import type { TruncationResult } from '@mariozechner/pi-coding-agent';
import Dockerode from 'dockerode';
import { mkdirSync } from 'node:fs';
import { kill } from 'node:process';
import { PassThrough } from 'node:stream';

export class DockerDaemonUnreachableError extends Error {
  constructor() {
    super('Docker daemon unreachable');
  }
}

export interface ExecInContainerOptions {
  command: string;
  cwd: string;
  timeout?: number | undefined;
  signal?: AbortSignal | undefined;
  onUpdate?:
    | ((payload: {
        content: { type: 'text'; text: string }[];
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
async function killExec(exec: Dockerode.Exec, sig: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  const info = await exec.inspect();
  const pid = info.Pid;
  if (pid === 0) return;
  try {
    kill(pid, sig);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ESRCH') {
      return;
    }
    throw err;
  }
}

export function buildBindMounts(
  filesystem: FilesystemConfig,
  workspaceAbsolutePath: string,
): string[] {
  const mounts: string[] = [`${workspaceAbsolutePath}:${workspaceAbsolutePath}:rw`];
  for (const prefix of filesystem.ro) {
    mounts.push(`${prefix}:${prefix}:ro`);
  }
  for (const prefix of filesystem.rw) {
    mounts.push(`${prefix}:${prefix}:rw`);
  }
  return mounts;
}

export function buildEnvVars(env: Record<string, string>, hostHomeDirectory: string): string[] {
  const vars: Record<string, string> = { HOME: hostHomeDirectory, ...env };
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`);
}

export function createMissingDirs(paths: string[]): void {
  for (const p of paths) {
    mkdirSync(p, { recursive: true });
  }
}

function hasStatusCode(err: unknown, statusCode: number): boolean {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    (err as { statusCode: number }).statusCode === statusCode
  );
}

export function isDockerNotFound(err: unknown): boolean {
  return hasStatusCode(err, 404);
}

function isDockerConflict(err: unknown): boolean {
  return hasStatusCode(err, 409);
}

function isDockerNotModified(err: unknown): boolean {
  return hasStatusCode(err, 304);
}

function isAlreadyStopped(err: unknown): boolean {
  return err instanceof Error && err.message.toLowerCase().includes('already stopped');
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('enoent') ||
    msg.includes('connect') ||
    msg.includes('socket')
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
      Cmd: ['sleep', 'infinity'],
      HostConfig: {
        NetworkMode: networkMode ?? 'none',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Binds: buildBindMounts(config.filesystem, workspaceAbsolutePath),
      },
      Env: buildEnvVars(config.env, process.env.HOME ?? '/root'),
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
): Promise<'running' | 'stopped' | 'not found'> {
  const container = docker.getContainer(containerName);
  try {
    const info = await container.inspect();
    return info.State.Running ? 'running' : 'stopped';
  } catch (err) {
    if (isDockerNotFound(err)) {
      return 'not found';
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
    if (isDockerNotModified(err) || isAlreadyStopped(err)) {
      // Already stopped — benign.
    } else {
      rethrowDockerDaemonError(err);
      throw err;
    }
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

export async function stopAndRemoveNetwork(docker: Dockerode, networkName: string): Promise<void> {
  const network = docker.getNetwork(networkName);
  try {
    await network.remove();
  } catch (err) {
    if (isDockerNotFound(err)) {
      return;
    }
    rethrowDockerDaemonError(err);
    throw err;
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
      await docker.createNetwork({ Name: networkName, Driver: 'bridge' });
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
      Cmd: ['run', '-c', '/etc/sing-box/config.json'],
      HostConfig: {
        NetworkMode: networkName,
        CapAdd: ['NET_ADMIN'],
        Devices: [
          { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' },
        ],
        Binds: [`${configPath}:/etc/sing-box/config.json:ro`],
        SecurityOpt: ['no-new-privileges:true'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=10m' },
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

export async function runCommandInContainer(
  container: Dockerode.Container,
  cmd: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: options?.cwd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const modem = (exec as unknown as { modem: DockerModem }).modem;
  modem.demuxStream(stream, stdout, stderr);

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
      reject(err);
    };
    const cleanup = (): void => {
      stream.off('end', onEnd);
      stream.off('close', onClose);
      stream.off('error', onError);
    };
    stream.on('end', onEnd);
    stream.on('close', onClose);
    stream.on('error', onError);
  });

  const info = await exec.inspect();
  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode: info.ExitCode ?? null,
  };
}

export async function installNftablesRules(docker: Dockerode, sidecarName: string): Promise<void> {
  const container = docker.getContainer(sidecarName);
  const cmds = [
    ['nft', 'add', 'table', 'inet', 'sb-guard'],
    [
      'nft',
      'add',
      'chain',
      'inet',
      'sb-guard',
      'output',
      '{',
      'type',
      'filter',
      'hook',
      'output',
      'priority',
      '0',
      ';',
      'policy',
      'accept',
      ';',
      '}',
    ],
    [
      'nft',
      'add',
      'rule',
      'inet',
      'sb-guard',
      'output',
      'oifname',
      'eth0',
      'meta',
      'mark',
      '!=',
      '0xCAFE',
      'drop',
    ],
  ];

  for (const cmd of cmds) {
    const { exitCode, stderr } = await runCommandInContainer(container, cmd);
    if (exitCode !== 0) {
      throw new Error(
        `nft command failed (exit ${String(exitCode)}): ${cmd.join(' ')} — ${stderr.trim()}`,
      );
    }
  }
}

function abortedResult(): ExecInContainerResult {
  return { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true };
}

interface OutputBuffers {
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  getStdout: () => string;
  getStderr: () => string;
}

function createOutputBuffers(
  onUpdate?: (payload: {
    content: { type: 'text'; text: string }[];
    details: { truncation?: TruncationResult | undefined };
  }) => void,
): OutputBuffers {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const rollingChunks: Buffer[] = [];
  let rollingBytes = 0;
  const maxRollingBytes = DEFAULT_MAX_BYTES * 2;

  function pushToRolling(chunk: Buffer): void {
    rollingChunks.push(chunk);
    rollingBytes += chunk.length;
    while (rollingBytes > maxRollingBytes && rollingChunks.length > 1) {
      const removed = rollingChunks.shift();
      if (removed === undefined) break;
      rollingBytes -= removed.length;
    }
  }

  function emitUpdate(): void {
    if (!onUpdate) return;
    const fullBuffer = Buffer.concat(rollingChunks);
    const fullText = fullBuffer.toString('utf-8');
    const truncation = truncateTail(fullText, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    onUpdate({
      content: [{ type: 'text', text: truncation.content || '' }],
      details: truncation.truncated ? { truncation } : {},
    });
  }

  return {
    onStdout: (chunk: Buffer): void => {
      stdoutChunks.push(chunk);
      pushToRolling(chunk);
      emitUpdate();
    },
    onStderr: (chunk: Buffer): void => {
      stderrChunks.push(chunk);
      pushToRolling(chunk);
      emitUpdate();
    },
    getStdout: (): string => Buffer.concat(stdoutChunks).toString('utf-8'),
    getStderr: (): string => Buffer.concat(stderrChunks).toString('utf-8'),
  };
}

async function waitForStream(
  stream: NodeJS.ReadableStream,
  state: { timedOut: boolean; aborted: boolean },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
      stream.off('end', onEnd);
      stream.off('close', onClose);
      stream.off('error', onError);
    };
    stream.on('end', onEnd);
    stream.on('close', onClose);
    stream.on('error', onError);
  });
}

function setupExecTimeouts(
  exec: Dockerode.Exec,
  stream: NodeJS.ReadableStream,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  state: { timedOut: boolean; aborted: boolean },
): { timer: ReturnType<typeof setTimeout> | undefined; abortHandler: (() => void) | undefined } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeout !== undefined && timeout > 0) {
    timer = setTimeout(() => {
      state.timedOut = true;
      void killExec(exec, 'SIGKILL');
      (stream as unknown as { destroy(): void }).destroy();
    }, timeout * 1000);
  }

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = (): void => {
      state.aborted = true;
      void killExec(exec, 'SIGKILL');
      (stream as unknown as { destroy(): void }).destroy();
    };
    signal.addEventListener('abort', abortHandler);
  }

  return { timer, abortHandler };
}

function teardownExecTimeouts(
  timer: ReturnType<typeof setTimeout> | undefined,
  abortHandler: (() => void) | undefined,
  signal: AbortSignal | undefined,
): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (abortHandler !== undefined && signal) {
    signal.removeEventListener('abort', abortHandler);
  }
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
    Cmd: ['sh', '-c', command],
    WorkingDir: cwd,
    AttachStdout: true,
    AttachStderr: true,
  });

  if (signal?.aborted) {
    return abortedResult();
  }

  const stream = await exec.start({ hijack: true, stdin: false });

  if (signal?.aborted) {
    await killExec(exec, 'SIGKILL');
    stream.destroy();
    return abortedResult();
  }

  const buffers = createOutputBuffers(onUpdate);
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  stdout.on('data', buffers.onStdout);
  stderr.on('data', buffers.onStderr);

  const modem = (exec as unknown as { modem: DockerModem }).modem;
  modem.demuxStream(stream, stdout, stderr);

  const state = { timedOut: false, aborted: false };
  const { timer, abortHandler } = setupExecTimeouts(exec, stream, timeout, signal, state);

  await waitForStream(stream, state);

  teardownExecTimeouts(timer, abortHandler, signal);

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

  return {
    stdout: buffers.getStdout(),
    stderr: buffers.getStderr(),
    exitCode,
    timedOut: state.timedOut,
    aborted: state.aborted,
  };
}

export async function doesImageExist(docker: Dockerode, image: string): Promise<boolean> {
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

export async function pullImage(docker: Dockerode, image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    (
      docker as unknown as {
        pull: (
          repoTag: string,
          callback: (err: Error | null, stream: NodeJS.ReadableStream) => void,
        ) => void;
      }
    ).pull(image, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      (
        docker as unknown as {
          modem: {
            followProgress: (
              stream: NodeJS.ReadableStream,
              callback: (err: Error | null, output: PullProgress[]) => void,
            ) => void;
          };
        }
      ).modem.followProgress(stream, (err, output) => {
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
