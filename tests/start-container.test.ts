import assert from "node:assert";
import { describe, it } from "node:test";
import type Dockerode from "dockerode";
import { createSandboxState } from "../src/state.js";
import { startSandboxContainer } from "../src/start-container.js";
import type { SandboxConfig } from "../src/config.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-sandbox-start-test-"));
}

const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };

describe("startSandboxContainer", () => {
  it("returns ready and sets container when image exists", async () => {
    const state = createSandboxState();
    const mockContainer = { id: "c1" } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(true),
        ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
        pullImageFn: () => Promise.resolve(),
      },
      config,
      tmpDir,
      "pi-sandbox-test",
      tmpDir,
    );

    assert.strictEqual(result.kind, "ready");
    assert.strictEqual(result.configStaleness, false);
    assert.strictEqual(state.container, mockContainer);
    assert.strictEqual(state.pull.isPulling, false);
  });

  it("writes config hash when container is created", async () => {
    const state = createSandboxState();
    const mockContainer = { id: "c1" } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(true),
        ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
        pullImageFn: () => Promise.resolve(),
      },
      config,
      tmpDir,
      "pi-sandbox-test",
      tmpDir,
    );

    assert.strictEqual(existsSync(join(tmpDir, "config-hash")), true);
    const stored = readFileSync(join(tmpDir, "config-hash"), "utf-8");
    assert.strictEqual(stored.length, 16);
  });

  it("returns configStaleness true when reusing container with different config", async () => {
    const state = createSandboxState();
    const mockContainer = { id: "c1" } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    // Pre-seed a different hash
    writeFileSync(join(tmpDir, "config-hash"), "oldhash123456789");

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(true),
        ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: false }),
        pullImageFn: () => Promise.resolve(),
      },
      config,
      tmpDir,
      "pi-sandbox-test",
      tmpDir,
    );

    assert.strictEqual(result.kind, "ready");
    assert.strictEqual(result.configStaleness, true);
    assert.strictEqual(state.container, mockContainer);
  });

  it("returns pulling when image is missing and later sets container on success", async () => {
    const state = createSandboxState();
    const mockContainer = { id: "c1" } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(false),
        ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
        pullImageFn: () => Promise.resolve(),
      },
      config,
      tmpDir,
      "pi-sandbox-test",
      tmpDir,
    );

    assert.strictEqual(result.kind, "pulling");
    assert.strictEqual(state.pull.isPulling, true);
    assert.strictEqual(state.pull.error, undefined);
    assert.strictEqual(state.container, undefined);

    const done = result.done;
    const outcome = await done;
    assert.strictEqual(outcome.kind, "ready");
    assert.strictEqual(state.container, mockContainer);
    assert.strictEqual(state.pull.isPulling, false);
  });

  it("returns pulling and later sets pull error on failure", async () => {
    const state = createSandboxState();
    const tmpDir = makeTempDir();

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(false),
        ensureContainerFn: () => Promise.resolve({ container: {} as Dockerode.Container, created: true }),
        pullImageFn: () => Promise.reject(new Error("network timeout")),
      },
      config,
      tmpDir,
      "pi-sandbox-test",
      tmpDir,
    );

    assert.strictEqual(result.kind, "pulling");
    assert.strictEqual(state.pull.isPulling, true);

    const done = result.done;
    const outcome = await done;
    assert.strictEqual(outcome.kind, "error");
    assert.strictEqual(outcome.message, "network timeout");
    assert.strictEqual(state.pull.error, "network timeout");
    assert.strictEqual(state.pull.isPulling, false);
    assert.strictEqual(state.container, undefined);
  });

  it("writes hash when stored hash is missing for reused container", async () => {
    const state = createSandboxState();
    const mockContainer = { id: "c1" } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(true),
        ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: false }),
        pullImageFn: () => Promise.resolve(),
      },
      config,
      tmpDir,
      "pi-sandbox-test",
      tmpDir,
    );

    assert.strictEqual(result.kind, "ready");
    assert.strictEqual(result.configStaleness, false);
    assert.strictEqual(existsSync(join(tmpDir, "config-hash")), true);
  });
});
