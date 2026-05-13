import type { SandboxConfig } from '../src/config.js';
import { startSandboxContainer } from '../src/start-container.js';
import { createSandboxState } from '../src/state.js';
import type Dockerode from 'dockerode';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-sandbox-start-test-'));
}

const config: SandboxConfig = {
  image: 'alpine',
  env: {},
  filesystem: { rw: [], ro: [] },
  network: {},
};

describe('startSandboxContainer', () => {
  it('returns ready and sets container when image exists', async () => {
    const state = createSandboxState();
    const mockContainer = { id: 'c1' } as unknown as Dockerode.Container;
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
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(result.kind, 'ready');
    assert.strictEqual(result.configStaleness, false);
    assert.strictEqual(state.container, mockContainer);
    assert.strictEqual(state.pull.isPulling, false);
  });

  it('writes config hash when container is created', async () => {
    const state = createSandboxState();
    const mockContainer = { id: 'c1' } as unknown as Dockerode.Container;
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
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(existsSync(join(tmpDir, 'config-hash')), true);
    const stored = readFileSync(join(tmpDir, 'config-hash'), 'utf-8');
    assert.strictEqual(stored.length, 16);
  });

  it('returns configStaleness true when reusing container with different config', async () => {
    const state = createSandboxState();
    const mockContainer = { id: 'c1' } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    // Pre-seed a different hash
    writeFileSync(join(tmpDir, 'config-hash'), 'oldhash123456789');

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
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(result.kind, 'ready');
    assert.strictEqual(result.configStaleness, true);
    assert.strictEqual(state.container, mockContainer);
  });

  it('returns pulling when image is missing and later sets container on success', async () => {
    const state = createSandboxState();
    const mockContainer = { id: 'c1' } as unknown as Dockerode.Container;
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
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(result.kind, 'pulling');
    assert.strictEqual(state.pull.isPulling, true);
    assert.strictEqual(state.pull.error, undefined);
    assert.strictEqual(state.container, undefined);

    const done = result.done;
    const outcome = await done;
    assert.strictEqual(outcome.kind, 'ready');
    assert.strictEqual(state.container, mockContainer);
    assert.strictEqual(state.pull.isPulling, false);
  });

  it('returns pulling and later sets pull error on failure', async () => {
    const state = createSandboxState();
    const tmpDir = makeTempDir();

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(false),
        ensureContainerFn: () =>
          Promise.resolve({ container: {} as Dockerode.Container, created: true }),
        pullImageFn: () => Promise.reject(new Error('network timeout')),
      },
      config,
      tmpDir,
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(result.kind, 'pulling');
    assert.strictEqual(state.pull.isPulling, true);

    const done = result.done;
    const outcome = await done;
    assert.strictEqual(outcome.kind, 'error');
    assert.strictEqual(outcome.message, 'network timeout');
    assert.strictEqual(state.pull.error, 'network timeout');
    assert.strictEqual(state.pull.isPulling, false);
    assert.strictEqual(state.container, undefined);
  });

  it('writes hash when stored hash is missing for reused container', async () => {
    const state = createSandboxState();
    const mockContainer = { id: 'c1' } as unknown as Dockerode.Container;
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
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(result.kind, 'ready');
    assert.strictEqual(result.configStaleness, false);
    assert.strictEqual(existsSync(join(tmpDir, 'config-hash')), true);
  });

  it('creates sidecar and app when network policy is active', async () => {
    const state = createSandboxState();
    const mockContainer = { id: 'c1' } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    let ensureNetworkCalled = false;
    let ensureSidecarCalled = false;
    let networkModePassed: string | undefined;

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: () => Promise.resolve(true),
        ensureContainerFn: (_docker, _cfg, _workspace, _name, networkMode) => {
          networkModePassed = networkMode;
          return Promise.resolve({ container: mockContainer, created: true });
        },
        pullImageFn: () => Promise.resolve(),
        ensureNetworkFn: () => {
          ensureNetworkCalled = true;
          return Promise.resolve();
        },
        ensureSidecarContainerFn: () => {
          ensureSidecarCalled = true;
          return Promise.resolve({
            container: { id: 's1' } as unknown as Dockerode.Container,
            created: true,
          });
        },
      },
      {
        image: 'alpine',
        env: {},
        filesystem: { rw: [], ro: [] },
        network: { domains: ['example.com'] },
      },
      tmpDir,
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(result.kind, 'ready');
    assert.strictEqual(ensureNetworkCalled, true);
    assert.strictEqual(ensureSidecarCalled, true);
    assert.ok(networkModePassed?.startsWith('container:'));
    assert.strictEqual(existsSync(join(tmpDir, 'sing-box-config.json')), true);
  });

  it('pulls sidecar image when network policy is active and sidecar image is missing', async () => {
    const state = createSandboxState();
    const mockContainer = { id: 'c1' } as unknown as Dockerode.Container;
    const tmpDir = makeTempDir();

    let sidecarImageChecked = false;

    const result = await startSandboxContainer(
      state,
      {
        docker: {} as Dockerode,
        doesImageExistFn: (_docker, image) => {
          if (image === 'ghcr.io/sagernet/sing-box:v1.12.0') {
            sidecarImageChecked = true;
            return Promise.resolve(false);
          }
          return Promise.resolve(image === 'alpine');
        },
        ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
        pullImageFn: () => Promise.resolve(),
        ensureNetworkFn: () => Promise.resolve(),
        ensureSidecarContainerFn: () =>
          Promise.resolve({
            container: { id: 's1' } as unknown as Dockerode.Container,
            created: true,
          }),
      },
      {
        image: 'alpine',
        env: {},
        filesystem: { rw: [], ro: [] },
        network: { domains: ['example.com'] },
      },
      tmpDir,
      'pi-sandbox-test',
      tmpDir,
    );

    assert.strictEqual(result.kind, 'pulling');
    assert.strictEqual(sidecarImageChecked, true);

    const outcome = await result.done;
    assert.strictEqual(outcome.kind, 'ready');
  });
});
