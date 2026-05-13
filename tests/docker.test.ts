import type { FilesystemConfig, SandboxConfig } from '../src/config.js';
import {
  buildBindMounts,
  buildEnvVars,
  createMissingDirs,
  doesImageExist,
  ensureContainer,
  execInContainer,
  pullImage,
  stopAndRemoveContainer,
} from '../src/docker.js';
import Dockerode from 'dockerode';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const IMAGE = 'alpine:latest';
const docker = new Dockerode();

async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();
const describeIntegration = dockerAvailable ? describe : describe.skip;

async function removeContainer(name: string): Promise<void> {
  try {
    const container = docker.getContainer(name);
    await container.stop({ t: 1 });
    await container.remove({ force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-sandbox-docker-test-'));
}

describe('buildBindMounts', () => {
  it('includes workspace rw and prefixes', () => {
    const fs: FilesystemConfig = { rw: ['/tmp'], ro: ['/etc'] };
    const mounts = buildBindMounts(fs, '/workspace');
    assert.deepStrictEqual(mounts, ['/workspace:/workspace:rw', '/etc:/etc:ro', '/tmp:/tmp:rw']);
  });
});

describe('buildEnvVars', () => {
  it('includes HOME and custom vars', () => {
    const vars = buildEnvVars({ FOO: 'bar' }, '/home/user');
    assert.ok(vars.includes('HOME=/home/user'));
    assert.ok(vars.includes('FOO=bar'));
  });
});

describe('createMissingDirs', () => {
  it('creates directories that do not exist', () => {
    const tmp = makeTempDir();
    const target = join(tmp, 'a', 'b');
    createMissingDirs([target]);
    assert.strictEqual(existsSync(target), true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describeIntegration('ensureContainer integration', () => {
  let containerName: string;

  beforeEach(() => {
    containerName = `pi-sandbox-test-${Date.now().toString()}`;
  });

  afterEach(async () => {
    await removeContainer(containerName);
  });

  it('creates and starts a new container', async () => {
    const tmp = makeTempDir();
    const config: SandboxConfig = {
      image: IMAGE,
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const { container } = await ensureContainer(docker, config, tmp, containerName);
    const info = await container.inspect();
    assert.strictEqual(info.State.Running, true);
    assert.strictEqual(info.Name, `/${containerName}`);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reuses an existing running container', async () => {
    const tmp = makeTempDir();
    const config: SandboxConfig = {
      image: IMAGE,
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const { container: first } = await ensureContainer(docker, config, tmp, containerName);
    const { container: second } = await ensureContainer(docker, config, tmp, containerName);
    const secondInfo = await second.inspect();
    assert.strictEqual(first.id, secondInfo.Id);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts a stopped container', async () => {
    const tmp = makeTempDir();
    const config: SandboxConfig = {
      image: IMAGE,
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const { container } = await ensureContainer(docker, config, tmp, containerName);
    await container.stop({ t: 1 });
    const { container: restarted } = await ensureContainer(docker, config, tmp, containerName);
    const info = await restarted.inspect();
    assert.strictEqual(info.State.Running, true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('doesImageExist', () => {
  it('returns true when image exists', async () => {
    const docker = {
      getImage: (): { inspect: () => Promise<Record<string, unknown>> } => ({
        inspect: () => Promise.resolve({}),
      }),
    } as unknown as Dockerode;
    assert.strictEqual(await doesImageExist(docker, 'alpine'), true);
  });

  it('returns false when image is not found', async () => {
    const docker = {
      getImage: (): { inspect: () => Promise<never> } => ({
        inspect: () => Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
      }),
    } as unknown as Dockerode;
    assert.strictEqual(await doesImageExist(docker, 'alpine'), false);
  });

  it('throws on unexpected errors', async () => {
    const docker = {
      getImage: (): { inspect: () => Promise<never> } => ({
        inspect: () => Promise.reject(new Error('boom')),
      }),
    } as unknown as Dockerode;
    await assert.rejects(() => doesImageExist(docker, 'alpine'), /boom/);
  });
});

describe('pullImage', () => {
  it('resolves when pull succeeds', async () => {
    const docker = {
      pull: (_image: string, callback: (err: null, stream: unknown) => void) => {
        callback(null, {});
      },
      modem: {
        followProgress: (_stream: unknown, callback: (err: null, output: unknown[]) => void) => {
          callback(null, [{ status: 'Downloaded newer image' }]);
        },
      },
    } as unknown as Dockerode;
    await pullImage(docker, 'alpine');
  });

  it('rejects when pull fails', async () => {
    const docker = {
      pull: (_image: string, callback: (err: Error, _stream: unknown) => void) => {
        callback(new Error('pull failed'), {});
      },
      modem: {},
    } as unknown as Dockerode;
    await assert.rejects(() => pullImage(docker, 'alpine'), /pull failed/);
  });

  it('rejects when followProgress fails', async () => {
    const docker = {
      pull: (_image: string, callback: (err: null, stream: unknown) => void) => {
        callback(null, {});
      },
      modem: {
        followProgress: (_stream: unknown, callback: (err: Error) => void) => {
          callback(new Error('progress failed'));
        },
      },
    } as unknown as Dockerode;
    await assert.rejects(() => pullImage(docker, 'alpine'), /progress failed/);
  });

  it('rejects when stream contains error objects', async () => {
    const docker = {
      pull: (_image: string, callback: (err: null, stream: unknown) => void) => {
        callback(null, {});
      },
      modem: {
        followProgress: (_stream: unknown, callback: (err: null, output: unknown[]) => void) => {
          callback(null, [{ status: 'Pulling' }, { error: 'manifest unknown' }]);
        },
      },
    } as unknown as Dockerode;
    await assert.rejects(() => pullImage(docker, 'alpine'), /manifest unknown/);
  });
});

describe('stopAndRemoveContainer', () => {
  it('resolves when container does not exist', async () => {
    const docker = {
      getContainer: (): {
        stop: () => Promise<never>;
        remove: () => Promise<never>;
      } => ({
        stop: (): Promise<never> =>
          Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
        remove: (): Promise<never> =>
          Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
      }),
    } as unknown as Dockerode;
    await stopAndRemoveContainer(docker, 'missing');
  });

  it('stops and removes an existing container', async () => {
    let stopped = false;
    let removed = false;
    const docker = {
      getContainer: (): {
        stop: () => Promise<void>;
        remove: () => Promise<void>;
      } => ({
        stop: (): Promise<void> => {
          stopped = true;
          return Promise.resolve();
        },
        remove: (): Promise<void> => {
          removed = true;
          return Promise.resolve();
        },
      }),
    } as unknown as Dockerode;
    await stopAndRemoveContainer(docker, 'existing');
    assert.strictEqual(stopped, true);
    assert.strictEqual(removed, true);
  });

  it('throws DockerDaemonUnreachableError on connection error', async () => {
    const docker = {
      getContainer: (): {
        stop: () => Promise<never>;
      } => ({
        stop: (): Promise<never> => Promise.reject(new Error('ECONNREFUSED')),
      }),
    } as unknown as Dockerode;
    await assert.rejects(() => stopAndRemoveContainer(docker, 'foo'), /Docker daemon unreachable/);
  });

  it('removes container even when stop throws a benign error', async () => {
    let removed = false;
    const docker = {
      getContainer: (): {
        stop: () => Promise<never>;
        remove: () => Promise<void>;
      } => ({
        stop: (): Promise<never> => Promise.reject(new Error('Container already stopped')),
        remove: (): Promise<void> => {
          removed = true;
          return Promise.resolve();
        },
      }),
    } as unknown as Dockerode;
    await stopAndRemoveContainer(docker, 'already-stopped');
    assert.strictEqual(removed, true);
  });
});

describe('ensureContainer name conflict', () => {
  it('reuses container when create throws 409', async () => {
    let inspectCalls = 0;
    const docker = {
      getContainer: (
        _name: string,
      ): {
        inspect: () => Promise<{ State: { Running: boolean } }>;
        start: () => Promise<void>;
      } => ({
        inspect: (): Promise<{ State: { Running: boolean } }> => {
          inspectCalls++;
          return Promise.resolve({ State: { Running: true } });
        },
        start: (): Promise<void> => Promise.resolve(),
      }),
      createContainer: (): Promise<never> =>
        Promise.reject(Object.assign(new Error('conflict'), { statusCode: 409 })),
    } as unknown as Dockerode;

    const config: SandboxConfig = {
      image: 'alpine',
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const { container } = await ensureContainer(docker, config, '/workspace', 'test-conflict');
    const info = await container.inspect();
    assert.strictEqual(info.State.Running, true);
    assert.strictEqual(inspectCalls, 2);
  });

  it('throws raw error when create 409 is followed by inspect 404', async () => {
    const docker = {
      getContainer: (
        _name: string,
      ): {
        inspect: () => Promise<never>;
        start: () => Promise<void>;
      } => ({
        inspect: (): Promise<never> =>
          Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
        start: (): Promise<void> => Promise.resolve(),
      }),
      createContainer: (): Promise<never> =>
        Promise.reject(Object.assign(new Error('conflict'), { statusCode: 409 })),
    } as unknown as Dockerode;

    const config: SandboxConfig = {
      image: 'alpine',
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    await assert.rejects(
      () => ensureContainer(docker, config, '/workspace', 'test-conflict-vanished'),
      /not found/,
    );
  });
});

describeIntegration('execInContainer integration', () => {
  let containerName: string;
  let container: Dockerode.Container;

  beforeEach(async () => {
    containerName = `pi-sandbox-exec-test-${Date.now().toString()}`;
    const tmp = makeTempDir();
    const config: SandboxConfig = {
      image: IMAGE,
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    container = (await ensureContainer(docker, config, tmp, containerName)).container;
  });

  afterEach(async () => {
    await removeContainer(containerName);
  });

  it('returns stdout and exit code 0', async () => {
    const result = await execInContainer(container, { command: 'echo hello', cwd: '/tmp' });
    assert.strictEqual(result.stdout.trim(), 'hello');
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.aborted, false);
  });

  it('returns stderr and non-zero exit code', async () => {
    const result = await execInContainer(container, {
      command: 'echo error >&2; exit 42',
      cwd: '/tmp',
    });
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr.trim(), 'error');
    assert.strictEqual(result.exitCode, 42);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.aborted, false);
  });

  it('runs in provided cwd', async () => {
    const result = await execInContainer(container, { command: 'pwd', cwd: '/tmp' });
    assert.strictEqual(result.stdout.trim(), '/tmp');
  });

  it('times out a long-running command', async () => {
    const result = await execInContainer(container, {
      command: 'sleep 10',
      cwd: '/tmp',
      timeout: 1,
    });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.exitCode, null);
  });

  it('aborts via AbortSignal', async () => {
    const controller = new AbortController();
    const promise = execInContainer(container, {
      command: 'sleep 10',
      cwd: '/tmp',
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 500);
    const result = await promise;
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.exitCode, null);
  });

  it('streams partial output via onUpdate', async () => {
    const updates: string[] = [];
    const result = await execInContainer(container, {
      command: 'for i in 1 2 3; do echo $i; done',
      cwd: '/tmp',
      onUpdate: (payload) => {
        updates.push(payload.content[0]?.text ?? '');
        return undefined;
      },
    });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(updates.length >= 1, 'expected at least one onUpdate call');
    const lastUpdate = updates.at(-1);
    assert.ok(lastUpdate?.includes('3'), 'final update should include last line');
  });
});
