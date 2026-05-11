import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, mergeConfigs, validateConfig } from "../src/config.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-sandbox-config-test-"));
}

describe("mergeConfigs", () => {
  it("uses global image when workspace image is missing", () => {
    const result = mergeConfigs({ image: "alpine" }, {});
    assert.strictEqual(result.image, "alpine");
  });

  it("uses workspace image when present", () => {
    const result = mergeConfigs({ image: "alpine" }, { image: "ubuntu" });
    assert.strictEqual(result.image, "ubuntu");
  });

  it("defaults to empty image when both missing", () => {
    const result = mergeConfigs({}, {});
    assert.strictEqual(result.image, "");
  });

  it("merges env with workspace overriding global", () => {
    const result = mergeConfigs(
      { env: { A: "1", B: "2" } },
      { env: { B: "3", C: "4" } },
    );
    assert.deepStrictEqual(result.env, { A: "1", B: "3", C: "4" });
  });

  it("removes env var when workspace value is empty string", () => {
    const result = mergeConfigs(
      { env: { A: "1", B: "2" } },
      { env: { B: "" } },
    );
    assert.deepStrictEqual(result.env, { A: "1" });
  });

  it("appends filesystem lists", () => {
    const result = mergeConfigs(
      { filesystem: { rw: ["/a"], ro: ["/b"] } },
      { filesystem: { rw: ["/c"], ro: ["/d"] } },
    );
    assert.deepStrictEqual(result.filesystem.rw, ["/a", "/c"]);
    assert.deepStrictEqual(result.filesystem.ro, ["/b", "/d"]);
  });

  it("discards global lists when workspace list starts with empty string", () => {
    const result = mergeConfigs(
      { filesystem: { rw: ["/a"], ro: ["/b"] } },
      { filesystem: { rw: ["", "/c"], ro: ["", "/d"] } },
    );
    assert.deepStrictEqual(result.filesystem.rw, ["/c"]);
    assert.deepStrictEqual(result.filesystem.ro, ["/d"]);
  });

  it("ignores unknown keys without throwing", () => {
    const result = mergeConfigs({ unknown: "value" }, { alsoUnknown: 123 });
    assert.strictEqual(result.image, "");
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

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.image, "workspace");
    assert.deepStrictEqual(config.env, { A: "1" });
    assert.deepStrictEqual(config.filesystem.rw, ["/tmp"]);
  });

  it("treats missing workspace config as empty", () => {
    const globalPath = join(tmpDir, ".pi");
    writeFileSync(join(globalPath, "sandbox.json"), JSON.stringify({ image: "global" }));
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.image, "global");
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
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.image, "global");
  });
});
