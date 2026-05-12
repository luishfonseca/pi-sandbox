import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, mergeConfigs, validateConfig, augmentConfigWithPiDir } from "../src/config.js";
import type { SandboxConfig } from "../src/config.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-sandbox-config-test-"));
}

describe("mergeConfigs", () => {
  it("uses global image when workspace image is missing", () => {
    const { config } = mergeConfigs({ image: "alpine" }, {});
    assert.strictEqual(config.image, "alpine");
  });

  it("uses workspace image when present", () => {
    const { config } = mergeConfigs({ image: "alpine" }, { image: "ubuntu" });
    assert.strictEqual(config.image, "ubuntu");
  });

  it("defaults to empty image when both missing", () => {
    const { config } = mergeConfigs({}, {});
    assert.strictEqual(config.image, "");
  });

  it("merges env with workspace overriding global", () => {
    const { config } = mergeConfigs(
      { env: { A: "1", B: "2" } },
      { env: { B: "3", C: "4" } },
    );
    assert.deepStrictEqual(config.env, { A: "1", B: "3", C: "4" });
  });

  it("removes env var when workspace value is empty string", () => {
    const { config } = mergeConfigs(
      { env: { A: "1", B: "2" } },
      { env: { B: "" } },
    );
    assert.deepStrictEqual(config.env, { A: "1" });
  });

  it("throws when global env value is not a string", () => {
    assert.throws(
      () => {
        mergeConfigs(
          { env: { GOPATH: ["/home/luis/go"] } },
          {},
        );
      },
      /env value for "GOPATH" in global config must be a string, got object/,
    );
  });

  it("throws when workspace env value is not a string", () => {
    assert.throws(
      () => {
        mergeConfigs(
          {},
          { env: { GOPATH: ["/home/luis/go"] } },
        );
      },
      /env value for "GOPATH" in workspace config must be a string, got object/,
    );
  });

  it("appends filesystem lists", () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ["/a"], ro: ["/b"] } },
      { filesystem: { rw: ["/c"], ro: ["/d"] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, ["/a", "/c"]);
    assert.deepStrictEqual(config.filesystem.ro, ["/b", "/d"]);
  });

  it("discards global lists when workspace list starts with empty string", () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ["/a"], ro: ["/b"] } },
      { filesystem: { rw: ["", "/c"], ro: ["", "/d"] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, ["/c"]);
    assert.deepStrictEqual(config.filesystem.ro, ["/d"]);
  });

  it("ignores unknown keys without throwing", () => {
    const { config, warnings } = mergeConfigs({ unknown: "value" }, { alsoUnknown: 123 });
    assert.strictEqual(config.image, "");
    assert.strictEqual(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes('Unknown key "unknown"')));
    assert.ok(warnings.some((w) => w.includes('Unknown key "alsoUnknown"')));
  });

  it("expands ~ in filesystem prefixes", () => {
    const { config } = mergeConfigs(
      { filesystem: { rw: ["~/.pi/shared"], ro: ["~"] } },
      { filesystem: { rw: ["~/workspace"], ro: [] } },
    );
    assert.deepStrictEqual(config.filesystem.rw, [resolve(homedir(), ".pi/shared"), resolve(homedir(), "workspace")]);
    assert.deepStrictEqual(config.filesystem.ro, [homedir()]);
  });

  it("uses workspace sidecarImage when present", () => {
    const { config } = mergeConfigs({ image: "alpine", sidecarImage: "global-sidecar" }, { sidecarImage: "workspace-sidecar" });
    assert.strictEqual(config.sidecarImage, "workspace-sidecar");
  });

  it("uses global sidecarImage when workspace is absent", () => {
    const { config } = mergeConfigs({ image: "alpine", sidecarImage: "global-sidecar" }, {});
    assert.strictEqual(config.sidecarImage, "global-sidecar");
  });

  it("omits sidecarImage when both missing", () => {
    const { config } = mergeConfigs({ image: "alpine" }, {});
    assert.strictEqual(config.sidecarImage, undefined);
  });

  it("replaces global network with workspace network", () => {
    const { config } = mergeConfigs(
      { image: "alpine", network: { domains: ["global.test"] } },
      { image: "alpine", network: { domains: ["workspace.test"] } },
    );
    assert.deepStrictEqual(config.network, { domains: ["workspace.test"] });
  });

  it("uses global network when workspace is absent", () => {
    const { config } = mergeConfigs(
      { image: "alpine", network: { domains: ["global.test"] } },
      {},
    );
    assert.deepStrictEqual(config.network, { domains: ["global.test"] });
  });

  it("omits network when workspace sets empty object to override global", () => {
    const { config } = mergeConfigs(
      { image: "alpine", network: { domains: ["global.test"] } },
      { image: "alpine", network: {} },
    );
    assert.strictEqual(config.network, undefined);
  });

  it("omits network when both absent", () => {
    const { config } = mergeConfigs({ image: "alpine" }, {});
    assert.strictEqual(config.network, undefined);
  });
});

describe("validateConfig", () => {
  it("passes for valid config", () => {
    validateConfig({
      image: "alpine",
      env: {},
      filesystem: { rw: ["/tmp"], ro: ["/etc"] },
    });
  });

  it("throws when image is missing", () => {
    assert.throws(
      () => {
        validateConfig({
          image: "",
          env: {},
          filesystem: { rw: [], ro: [] },
        });
      },
      /non-empty "image"/,
    );
  });

  it("throws when image is not a string", () => {
    assert.throws(
      () => {
        validateConfig({
          image: 123 as unknown as string,
          env: {},
          filesystem: { rw: [], ro: [] },
        });
      },
      /non-empty "image"/,
    );
  });

  it("throws when env value is not a string", () => {
    assert.throws(
      () => {
        validateConfig({
          image: "alpine",
          env: { GOPATH: ["/home/luis/go"] as unknown as string },
          filesystem: { rw: [], ro: [] },
        });
      },
      /env value for "GOPATH" must be a string, got object/,
    );
  });

  it("throws for non-absolute rw prefix", () => {
    assert.throws(
      () => {
        validateConfig({
          image: "alpine",
          env: {},
          filesystem: { rw: ["relative"], ro: [] },
        });
      },
      /must be absolute/,
    );
  });

  it("throws for wildcard in ro prefix", () => {
    assert.throws(
      () => {
        validateConfig({
          image: "alpine",
          env: {},
          filesystem: { rw: [], ro: ["/etc/*"] },
        });
      },
      /must not contain wildcards/,
    );
  });

  it("throws for double-dot in rw prefix", () => {
    assert.throws(
      () => {
        validateConfig({
          image: "alpine",
          env: {},
          filesystem: { rw: ["/foo/../bar"], ro: [] },
        });
      },
      /must not contain "\.\."/,
    );
  });

  it("throws for trailing slash in ro prefix", () => {
    assert.throws(
      () => {
        validateConfig({
          image: "alpine",
          env: {},
          filesystem: { rw: [], ro: ["/etc/"] },
        });
      },
      /must not end with "\/"/,
    );
  });

  it("allows root slash as prefix", () => {
    validateConfig({
      image: "alpine",
      env: {},
      filesystem: { rw: ["/"], ro: [] },
    });
  });

  it("allows ~ expanded to homedir", () => {
    validateConfig({
      image: "alpine",
      env: {},
      filesystem: { rw: [homedir()], ro: [resolve(homedir(), ".pi/shared")] },
    });
  });

  it("throws for ~user treated as literal non-absolute path", () => {
    assert.throws(
      () => {
        validateConfig({
          image: "alpine",
          env: {},
          filesystem: { rw: ["~user/foo"], ro: [] },
        });
      },
      /must be absolute/,
    );
  });
});

describe("loadConfig", () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTempDir();
    const globalPath = join(tmpDir, ".pi");
    mkdirSync(globalPath, { recursive: true });
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads global config and optional workspace config", () => {
    const globalPath = join(tmpDir, ".pi");
    writeFileSync(join(globalPath, "sandbox.json"), JSON.stringify({ image: "global", env: { A: "1" } }));
    writeFileSync(join(tmpDir, "sandbox.json"), JSON.stringify({ image: "workspace", filesystem: { rw: ["/tmp"] } }));

    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, "workspace");
    assert.deepStrictEqual(config.env, { A: "1" });
    assert.deepStrictEqual(config.filesystem.rw, ["/tmp"]);
    assert.deepStrictEqual(warnings, []);
  });

  it("treats missing workspace config as empty", () => {
    const globalPath = join(tmpDir, ".pi");
    writeFileSync(join(globalPath, "sandbox.json"), JSON.stringify({ image: "global" }));
    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, "global");
    assert.deepStrictEqual(warnings, []);
  });

  it("throws when global config is missing", () => {
    assert.throws(() => loadConfig(tmpDir), /Global sandbox config missing/);
  });

  it("throws when global config is invalid JSON", () => {
    const globalPath = join(tmpDir, ".pi");
    writeFileSync(join(globalPath, "sandbox.json"), "not json");
    assert.throws(() => loadConfig(tmpDir), /Global sandbox config is invalid JSON/);
  });

  it("treats invalid workspace config as empty with a warning", () => {
    const globalPath = join(tmpDir, ".pi");
    writeFileSync(join(globalPath, "sandbox.json"), JSON.stringify({ image: "global" }));
    writeFileSync(join(tmpDir, "sandbox.json"), "bad json");
    const { config, warnings } = loadConfig(tmpDir);
    assert.strictEqual(config.image, "global");
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0]?.includes("Invalid JSON"));
  });

  it("throws when workspace env value is not a string", () => {
    const globalPath = join(tmpDir, ".pi");
    writeFileSync(join(globalPath, "sandbox.json"), JSON.stringify({ image: "global" }));
    writeFileSync(join(tmpDir, "sandbox.json"), JSON.stringify({ image: "workspace", env: { GOPATH: ["/home/luis/go"] } }));
    assert.throws(() => loadConfig(tmpDir), /env value for "GOPATH" in workspace config must be a string, got object/);
  });
});

describe("augmentConfigWithPiDir", () => {
  const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

  afterEach(() => {
    if (originalPiPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiPackageDir;
    }
  });

  function makeConfig(): SandboxConfig {
    return { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
  }

  it("appends PI_PACKAGE_DIR to ro when set", () => {
    process.env.PI_PACKAGE_DIR = "/nix/store/abc/pi-monorepo";
    const config = makeConfig();
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, true);
    assert.strictEqual(result.warning, undefined);
    assert.deepStrictEqual(config.filesystem.ro, ["/nix/store/abc/pi-monorepo"]);
  });

  it("is idempotent when PI_PACKAGE_DIR is already in ro", () => {
    process.env.PI_PACKAGE_DIR = "/nix/store/abc/pi-monorepo";
    const config = makeConfig();
    config.filesystem.ro.push("/nix/store/abc/pi-monorepo");
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, false);
    assert.strictEqual(result.warning, undefined);
    assert.deepStrictEqual(config.filesystem.ro, ["/nix/store/abc/pi-monorepo"]);
  });

  it("returns warning when PI_PACKAGE_DIR is not set", () => {
    delete process.env.PI_PACKAGE_DIR;
    const config = makeConfig();
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, false);
    assert.ok(result.warning?.includes("PI_PACKAGE_DIR is not set"));
    assert.deepStrictEqual(config.filesystem.ro, []);
  });

  it("appends invalid PI_PACKAGE_DIR verbatim; validateConfig catches it later", () => {
    process.env.PI_PACKAGE_DIR = "relative/path";
    const config = makeConfig();
    const result = augmentConfigWithPiDir(config);
    assert.strictEqual(result.augmented, true);
    assert.deepStrictEqual(config.filesystem.ro, ["relative/path"]);
    assert.throws(() => { validateConfig(config); }, /must be absolute/);
  });
});
