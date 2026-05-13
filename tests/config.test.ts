import {
  augmentConfigWithPiDir,
  loadConfig,
  loadDefaultsConfig,
  loadOptionalConfig,
  mergeConfigs,
  validateConfig,
} from '../src/config.js';
import type { SandboxConfig } from '../src/config.js';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-sandbox-config-test-'));
}

function makeBaseConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    image: 'alpine',
    env: {},
    filesystem: { rw: [], ro: [] },
    network: {},
    ...overrides,
  };
}

describe('mergeConfigs', () => {
  it('uses workspace image over global over defaults', () => {
    const { config } = mergeConfigs(
      { image: 'default' },
      { image: 'global' },
      { image: 'workspace' },
    );
    assert.strictEqual(config.image, 'workspace');
  });

  it('falls back to global when workspace omits image', () => {
    const { config } = mergeConfigs({ image: 'default' }, { image: 'global' }, {});
    assert.strictEqual(config.image, 'global');
  });

  it('falls back to defaults when global and workspace omit image', () => {
    const { config } = mergeConfigs({ image: 'default' }, {}, {});
    assert.strictEqual(config.image, 'default');
  });

  it('deep-merges env from all three layers', () => {
    const { config } = mergeConfigs({ env: { A: '1' } }, { env: { B: '2' } }, { env: { C: '3' } });
    assert.deepStrictEqual(config.env, { A: '1', B: '2', C: '3' });
  });

  it('workspace env overrides global and defaults', () => {
    const { config } = mergeConfigs(
      { env: { A: '1', B: '2' } },
      { env: { B: '3' } },
      { env: { A: '4' } },
    );
    assert.deepStrictEqual(config.env, { A: '4', B: '3' });
  });

  it('concatenates arrays left-to-right', () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ['/a'] } },
      { filesystem: { rw: ['/b'] } },
      { filesystem: { rw: ['/c'] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, ['/a', '/b', '/c']);
  });

  it('deletes object key when value is null', () => {
    const { config } = mergeConfigs({ image: 'alpine' }, {}, { image: null });
    assert.strictEqual(config.image, '');
  });

  it('deletes nested object key when value is null', () => {
    const { config } = mergeConfigs({ env: { A: '1' } }, {}, { env: { A: null } });
    assert.deepStrictEqual(config.env, {});
  });

  it('truncates array at last null', () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ['/a'] } },
      {},
      { filesystem: { rw: [null, '/b'] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, ['/b']);
  });

  it('empties array when null is the last element', () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ['/a'] } },
      {},
      { filesystem: { rw: [null] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, []);
  });

  it('truncates at last null when multiple nulls exist', () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ['/a'] } },
      { filesystem: { rw: [null, '/b'] } },
      { filesystem: { rw: [null, '/c'] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, ['/c']);
  });

  it('concatenates arrays when no null is present', () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ['/a'] } },
      { filesystem: { rw: [] } },
      { filesystem: { rw: ['/b'] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, ['/a', '/b']);
  });

  it('applies normalization after null processing', () => {
    const { config } = mergeConfigs({ env: { A: '1' } }, { env: { A: null } }, {});
    assert.deepStrictEqual(config.env, {});
    assert.deepStrictEqual(config.filesystem, { rw: [], ro: [] });
    assert.deepStrictEqual(config.network, {});
  });

  it('normalizes missing optional keys', () => {
    const { config } = mergeConfigs({}, {}, {});
    assert.deepStrictEqual(config.env, {});
    assert.deepStrictEqual(config.filesystem, { rw: [], ro: [] });
    assert.deepStrictEqual(config.network, {});
  });

  it('passes sidecarVersion through from defaults', () => {
    const { config } = mergeConfigs({ sidecarVersion: 'v1.0.0' }, {}, {});
    assert.strictEqual(config.sidecarVersion, 'v1.0.0');
  });

  it('workspace sidecarVersion overrides defaults', () => {
    const { config } = mergeConfigs(
      { sidecarVersion: 'v1.0.0' },
      { sidecarVersion: 'v1.1.0' },
      { sidecarVersion: 'v1.2.0' },
    );
    assert.strictEqual(config.sidecarVersion, 'v1.2.0');
  });

  it('warns for unknown top-level keys in each layer', () => {
    const { warnings } = mergeConfigs(
      { unknownDefault: 'x' },
      { unknownGlobal: 'y' },
      { unknownWorkspace: 'z' },
    );
    assert.ok(warnings.some((w) => w.includes('unknownDefault')));
    assert.ok(warnings.some((w) => w.includes('unknownGlobal')));
    assert.ok(warnings.some((w) => w.includes('unknownWorkspace')));
  });

  it('warns for unknown network keys in each layer', () => {
    const { warnings } = mergeConfigs(
      { network: { bad: 1 } },
      { network: { worse: 2 } },
      { network: { awful: 3 } },
    );
    assert.ok(warnings.some((w) => w.includes('bad')));
    assert.ok(warnings.some((w) => w.includes('worse')));
    assert.ok(warnings.some((w) => w.includes('awful')));
  });

  it('expands tilde in filesystem prefixes', () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ['~/.pi/shared'] } },
      { filesystem: { rw: ['~/global'] } },
      { filesystem: { rw: ['~/workspace'] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, [
      resolve(homedir(), '.pi/shared'),
      resolve(homedir(), 'global'),
      resolve(homedir(), 'workspace'),
    ]);
  });

  it('throws when env value is not a string', () => {
    assert.throws(() => {
      mergeConfigs({}, {}, { env: { GOPATH: ['/home/luis/go'] } });
    }, /env value for "GOPATH" in merged config must be a string, got object/);
  });

  it('throws when a nested env value is not a string', () => {
    assert.throws(() => {
      mergeConfigs({ env: { A: '1' } }, { env: { B: 2 } }, {});
    }, /env value for "B" in merged config must be a string, got number/);
  });
});

describe('validateConfig', () => {
  it('passes for valid config', () => {
    validateConfig(makeBaseConfig());
  });

  it('throws when image is missing', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ image: '' }));
    }, /non-empty "image"/);
  });

  it('throws when image is not a string', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ image: 123 as unknown as string }));
    }, /non-empty "image"/);
  });

  it('throws when env value is not a string', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ env: { GOPATH: ['/home/luis/go'] as unknown as string } }));
    }, /env value for "GOPATH" must be a string, got object/);
  });

  it('throws for non-absolute rw prefix', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ filesystem: { rw: ['relative'], ro: [] } }));
    }, /must be absolute/);
  });

  it('throws for wildcard in ro prefix', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ filesystem: { rw: [], ro: ['/etc/*'] } }));
    }, /must not contain wildcards/);
  });

  it('throws for double-dot in rw prefix', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ filesystem: { rw: ['/foo/../bar'], ro: [] } }));
    }, /must not contain "\.\."/);
  });

  it('throws for trailing slash in ro prefix', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ filesystem: { rw: [], ro: ['/etc/'] } }));
    }, /must not end with "\/"/);
  });

  it('throws when sidecarVersion is empty string', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ sidecarVersion: '' }));
    }, /sidecarVersion must be a non-empty string/);
  });

  it('allows root slash as prefix', () => {
    validateConfig(makeBaseConfig({ filesystem: { rw: ['/'], ro: [] } }));
  });

  it('allows ~ expanded to homedir', () => {
    validateConfig(
      makeBaseConfig({
        filesystem: { rw: [homedir()], ro: [resolve(homedir(), '.pi/shared')] },
      }),
    );
  });

  it('throws for ~user treated as literal non-absolute path', () => {
    assert.throws(() => {
      validateConfig(makeBaseConfig({ filesystem: { rw: ['~user/foo'], ro: [] } }));
    }, /must be absolute/);
  });
});

describe('loadDefaultsConfig', () => {
  it('reads the package defaults file', () => {
    const data = loadDefaultsConfig();
    assert.ok(isObject(data));
    assert.strictEqual(typeof data.image, 'string');
  });
});

describe('loadOptionalConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads valid JSON', () => {
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, JSON.stringify({ image: 'test' }));
    const result = loadOptionalConfig(path);
    assert.deepStrictEqual(result.data, { image: 'test' });
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.missing, false);
  });

  it('returns empty object when file is missing', () => {
    const result = loadOptionalConfig(join(tmpDir, 'missing.json'));
    assert.deepStrictEqual(result.data, {});
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.missing, true);
  });

  it('returns empty object with warning for invalid JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, 'not json');
    const result = loadOptionalConfig(path);
    assert.deepStrictEqual(result.data, {});
    assert.ok(result.warnings.some((w) => w.includes('Invalid JSON')));
    assert.strictEqual(result.missing, false);
  });
});

describe('loadConfig', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTempDir();
    const globalPath = join(tmpDir, '.pi');
    mkdirSync(globalPath, { recursive: true });
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and merges all three layers', () => {
    const globalPath = join(tmpDir, '.pi');
    writeFileSync(join(globalPath, 'sandbox.json'), JSON.stringify({ env: { A: '1' } }));
    writeFileSync(join(tmpDir, 'sandbox.json'), JSON.stringify({ filesystem: { rw: ['/tmp'] } }));

    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, 'alpine'); // from defaults
    assert.deepStrictEqual(config.env, { A: '1' });
    assert.deepStrictEqual(config.filesystem.rw, ['/tmp']);
    assert.deepStrictEqual(warnings, []);
  });

  it('treats missing workspace config as empty', () => {
    const globalPath = join(tmpDir, '.pi');
    writeFileSync(join(globalPath, 'sandbox.json'), JSON.stringify({ image: 'global' }));
    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, 'global');
    assert.deepStrictEqual(warnings, []);
  });

  it('treats missing global config as empty', () => {
    writeFileSync(join(tmpDir, 'sandbox.json'), JSON.stringify({ image: 'workspace' }));
    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, 'workspace');
    assert.deepStrictEqual(warnings, []);
  });

  it('warns when both global and workspace are missing', () => {
    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, 'alpine');
    assert.ok(warnings.some((w) => w.includes('No sandbox.json found in workspace or ~/.pi')));
  });

  it('treats invalid workspace config as empty with a warning', () => {
    const globalPath = join(tmpDir, '.pi');
    writeFileSync(join(globalPath, 'sandbox.json'), JSON.stringify({ image: 'global' }));
    writeFileSync(join(tmpDir, 'sandbox.json'), 'bad json');
    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, 'global');
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0]?.includes('Invalid JSON'));
  });

  it('treats invalid global config as empty with a warning', () => {
    const globalPath = join(tmpDir, '.pi');
    writeFileSync(join(globalPath, 'sandbox.json'), 'bad json');
    writeFileSync(join(tmpDir, 'sandbox.json'), JSON.stringify({ image: 'workspace' }));
    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, 'workspace');
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0]?.includes('Invalid JSON'));
  });

  it('throws when workspace env value is not a string', () => {
    writeFileSync(
      join(tmpDir, 'sandbox.json'),
      JSON.stringify({ env: { GOPATH: ['/home/luis/go'] } }),
    );
    assert.throws(
      () => loadConfig(tmpDir),
      /env value for "GOPATH" in merged config must be a string, got object/,
    );
  });

  it('warns for unknown keys in workspace config', () => {
    writeFileSync(
      join(tmpDir, 'sandbox.json'),
      JSON.stringify({ image: 'workspace', unknownKey: 'value' }),
    );
    const { warnings } = loadConfig(tmpDir);
    assert.ok(warnings.some((w) => w.includes('Unknown key "unknownKey"')));
  });

  it('warns for unknown keys in global config', () => {
    const globalPath = join(tmpDir, '.pi');
    writeFileSync(
      join(globalPath, 'sandbox.json'),
      JSON.stringify({ image: 'global', unknownKey: 'value' }),
    );
    const { warnings } = loadConfig(tmpDir);
    assert.ok(warnings.some((w) => w.includes('Unknown key "unknownKey"')));
  });
});

describe('augmentConfigWithPiDir', () => {
  const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

  afterEach(() => {
    if (originalPiPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiPackageDir;
    }
  });

  function makeConfig(): SandboxConfig {
    return { image: 'alpine', env: {}, filesystem: { rw: [], ro: [] }, network: {} };
  }

  it('appends PI_PACKAGE_DIR to ro when set', () => {
    process.env.PI_PACKAGE_DIR = '/nix/store/abc/pi-monorepo';
    const config = makeConfig();
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, true);
    assert.strictEqual(result.warning, undefined);
    assert.deepStrictEqual(result.config.filesystem.ro, ['/nix/store/abc/pi-monorepo']);
    // Input must not be mutated.
    assert.deepStrictEqual(config.filesystem.ro, []);
  });

  it('is idempotent when PI_PACKAGE_DIR is already in ro', () => {
    process.env.PI_PACKAGE_DIR = '/nix/store/abc/pi-monorepo';
    const config = makeConfig();
    config.filesystem.ro.push('/nix/store/abc/pi-monorepo');
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, false);
    assert.strictEqual(result.warning, undefined);
    assert.deepStrictEqual(result.config.filesystem.ro, ['/nix/store/abc/pi-monorepo']);
  });

  it('returns warning when PI_PACKAGE_DIR is not set', () => {
    delete process.env.PI_PACKAGE_DIR;
    const config = makeConfig();
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, false);
    assert.ok(result.warning?.includes('PI_PACKAGE_DIR is not set'));
    assert.deepStrictEqual(result.config.filesystem.ro, []);
  });

  it('appends invalid PI_PACKAGE_DIR verbatim; validateConfig catches it later', () => {
    process.env.PI_PACKAGE_DIR = 'relative/path';
    const config = makeConfig();
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, true);
    assert.deepStrictEqual(result.config.filesystem.ro, ['relative/path']);
    assert.throws(() => {
      validateConfig(result.config);
    }, /must be absolute/);
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
