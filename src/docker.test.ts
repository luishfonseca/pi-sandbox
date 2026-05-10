import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import Dockerode from "dockerode";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBindMounts,
  buildEnvVars,
  createMissingDirs,
  ensureContainer,
  execInContainer,
  doesImageExist,
  pullImage,
} from "./docker.js";
import type { FilesystemConfig, SandboxConfig } from "./config.js";

const IMAGE = "alpine:latest";
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
  return mkdtempSync(join(tmpdir(), "pi-sandbox-docker-test-"));
}

describe("buildBindMounts", () => {
  it("includes workspace rw and prefixes", () => {
    const fs: FilesystemConfig = { rw: ["/tmp"], ro: ["/etc"] };
    const mounts = buildBindMounts(fs, "/workspace");
    assert.deepStrictEqual(mounts, [
      "/workspace:/workspace:rw",
      "/etc:/etc:ro",
      "/tmp:/tmp:rw",
    ]);
  });
});

describe("buildEnvVars", () => {
  it("includes HOME and custom vars", () => {
    const vars = buildEnvVars({ FOO: "bar" }, "/home/user");
    assert.ok(vars.includes("HOME=/home/user"));
    assert.ok(vars.includes("FOO=bar"));
  });
});

describe("createMissingDirs", () => {
  it("creates directories that do not exist", () => {
    const tmp = makeTempDir();
    const target = join(tmp, "a", "b");
    createMissingDirs([target]);
    assert.strictEqual(existsSync(target), true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describeIntegration("ensureContainer integration", () => {
  let containerName: string;

  beforeEach(() => {
    containerName = `pi-sandbox-test-${Date.now().toString()}`;
  });

  afterEach(async () => {
    await removeContainer(containerName);
  });

  it("creates and starts a new container", async () => {
    const tmp = makeTempDir();
    const config: SandboxConfig = {
      image: IMAGE,
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const container = await ensureContainer(docker, config, tmp, containerName);
    const info = await container.inspect();
    assert.strictEqual(info.State.Running, true);
    assert.strictEqual(info.Name, `/${containerName}`);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reuses an existing running container", async () => {
    const tmp = makeTempDir();
    const config: SandboxConfig = {
      image: IMAGE,
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const first = await ensureContainer(docker, config, tmp, containerName);
    const second = await ensureContainer(docker, config, tmp, containerName);
    const secondInfo = await second.inspect();
    assert.strictEqual(first.id, secondInfo.Id);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts a stopped container", async () => {
    const tmp = makeTempDir();
    const config: SandboxConfig = {
      image: IMAGE,
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const container = await ensureContainer(docker, config, tmp, containerName);
    await container.stop({ t: 1 });
    const restarted = await ensureContainer(docker, config, tmp, containerName);
    const info = await restarted.inspect();
    assert.strictEqual(info.State.Running, true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("doesImageExist", () => {
  it("returns true when image exists", async () => {
    const docker = {
      getImage: () => ({
        inspect: () => Promise.resolve({}),
      }),
    } as unknown as Dockerode;
    assert.strictEqual(await doesImageExist(docker, "alpine"), true);
  });

  it("returns false when image is not found", async () => {
    const docker = {
      getImage: () => ({
        inspect: () => Promise.reject(Object.assign(new Error("not found"), { statusCode: 404 })),
      }),
    } as unknown as Dockerode;
    assert.strictEqual(await doesImageExist(docker, "alpine"), false);
  });

  it("throws on unexpected errors", async () => {
    const docker = {
      getImage: () => ({
        inspect: () => Promise.reject(new Error("boom")),
      }),
    } as unknown as Dockerode;
    await assert.rejects(() => doesImageExist(docker, "alpine"), /boom/);
  });
});

describe("pullImage", () => {
  it("resolves when pull succeeds", async () => {
    const docker = {
      pull: (_image: string, callback: (err: null, stream: unknown) => void) => {
        callback(null, {});
      },
      modem: {
        followProgress: (_stream: unknown, callback: (err: null, output: unknown[]) => void) => {
          callback(null, [{ status: "Downloaded newer image" }]);
        },
      },
    } as unknown as Dockerode;
    await pullImage(docker, "alpine");
  });

  it("rejects when pull fails", async () => {
    const docker = {
      pull: (_image: string, callback: (err: Error, _stream: unknown) => void) => {
        callback(new Error("pull failed"), {});
      },
      modem: {},
    } as unknown as Dockerode;
    await assert.rejects(() => pullImage(docker, "alpine"), /pull failed/);
  });

  it("rejects when followProgress fails", async () => {
    const docker = {
      pull: (_image: string, callback: (err: null, stream: unknown) => void) => {
        callback(null, {});
      },
      modem: {
        followProgress: (_stream: unknown, callback: (err: Error) => void) => {
          callback(new Error("progress failed"));
        },
      },
    } as unknown as Dockerode;
    await assert.rejects(() => pullImage(docker, "alpine"), /progress failed/);
  });

  it("rejects when stream contains error objects", async () => {
    const docker = {
      pull: (_image: string, callback: (err: null, stream: unknown) => void) => {
        callback(null, {});
      },
      modem: {
        followProgress: (_stream: unknown, callback: (err: null, output: unknown[]) => void) => {
          callback(null, [{ status: "Pulling" }, { error: "manifest unknown" }]);
        },
      },
    } as unknown as Dockerode;
    await assert.rejects(() => pullImage(docker, "alpine"), /manifest unknown/);
  });
});

describeIntegration("execInContainer integration", () => {
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
    container = await ensureContainer(docker, config, tmp, containerName);
  });

  afterEach(async () => {
    await removeContainer(containerName);
  });

  it("returns stdout and exit code 0", async () => {
    const result = await execInContainer(container, "echo hello");
    assert.strictEqual(result.stdout.trim(), "hello");
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.exitCode, 0);
  });

  it("returns stderr and non-zero exit code", async () => {
    const result = await execInContainer(container, "echo error >&2; exit 42");
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr.trim(), "error");
    assert.strictEqual(result.exitCode, 42);
  });

  it("runs in provided cwd", async () => {
    const result = await execInContainer(container, "pwd", "/tmp");
    assert.strictEqual(result.stdout.trim(), "/tmp");
  });
});
