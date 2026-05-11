import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeContainerName,
  computeConfigHash,
  getStateDir,
  acquireSessionRef,
  releaseSessionRef,
  readStoredConfigHash,
  writeConfigHash,
  deleteConfigHash,
  countLeakedRefs,
  resetState,
} from "../src/lifecycle.js";
import type { SandboxConfig } from "../src/config.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-sandbox-lifecycle-test-"));
}

describe("computeContainerName", () => {
  it("returns a consistent name for the same workspace path", () => {
    const name1 = computeContainerName("/home/user/project");
    const name2 = computeContainerName("/home/user/project");
    assert.strictEqual(name1, name2);
    assert.ok(name1.startsWith("pi-sandbox-"));
    assert.strictEqual(name1.length, "pi-sandbox-".length + 16);
  });

  it("returns different names for different workspace paths", () => {
    const name1 = computeContainerName("/home/user/project-a");
    const name2 = computeContainerName("/home/user/project-b");
    assert.notStrictEqual(name1, name2);
  });
});

describe("computeConfigHash", () => {
  it("returns a consistent hash for the same config", () => {
    const config: SandboxConfig = {
      image: "alpine",
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const hash1 = computeConfigHash(config);
    const hash2 = computeConfigHash(config);
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 16);
  });

  it("returns different hashes for different configs", () => {
    const config1: SandboxConfig = {
      image: "alpine",
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    const config2: SandboxConfig = {
      image: "ubuntu",
      env: {},
      filesystem: { rw: [], ro: [] },
    };
    assert.notStrictEqual(computeConfigHash(config1), computeConfigHash(config2));
  });
});

describe("getStateDir", () => {
  it("appends .sandbox to session dir", () => {
    assert.strictEqual(getStateDir("/tmp/sessions"), "/tmp/sessions/.sandbox");
  });
});

describe("acquireSessionRef", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the sessions directory and a file for the session", () => {
    const stateDir = `${tmpDir}/.sandbox`;
    acquireSessionRef(stateDir, "session-a");
    assert.strictEqual(existsSync(`${stateDir}/sessions/session-a`), true);
  });

  it("is idempotent for the same session", () => {
    const stateDir = `${tmpDir}/.sandbox`;
    acquireSessionRef(stateDir, "session-a");
    acquireSessionRef(stateDir, "session-a");
    assert.strictEqual(existsSync(`${stateDir}/sessions/session-a`), true);
  });
});

describe("releaseSessionRef", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the session file and returns true when empty", () => {
    const stateDir = `${tmpDir}/.sandbox`;
    acquireSessionRef(stateDir, "session-a");
    const isEmpty = releaseSessionRef(stateDir, "session-a");
    assert.strictEqual(isEmpty, true);
    assert.strictEqual(existsSync(`${stateDir}/sessions/session-a`), false);
  });

  it("returns false when other refs remain", () => {
    const stateDir = `${tmpDir}/.sandbox`;
    acquireSessionRef(stateDir, "session-a");
    acquireSessionRef(stateDir, "session-b");
    const isEmpty = releaseSessionRef(stateDir, "session-a");
    assert.strictEqual(isEmpty, false);
    assert.strictEqual(existsSync(`${stateDir}/sessions/session-b`), true);
  });

  it("returns true when the session file is missing", () => {
    const stateDir = `${tmpDir}/.sandbox`;
    const isEmpty = releaseSessionRef(stateDir, "session-a");
    assert.strictEqual(isEmpty, true);
  });
});

describe("readStoredConfigHash", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the stored hash", () => {
    writeFileSync(`${tmpDir}/config-hash`, "abc123");
    assert.strictEqual(readStoredConfigHash(tmpDir), "abc123");
  });

  it("returns undefined when the file is missing", () => {
    assert.strictEqual(readStoredConfigHash(tmpDir), undefined);
  });
});

describe("writeConfigHash", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the hash to the state directory", () => {
    writeConfigHash(tmpDir, "hash123");
    assert.strictEqual(readFileSync(`${tmpDir}/config-hash`, "utf-8"), "hash123");
  });
});

describe("deleteConfigHash", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the config hash file", () => {
    writeFileSync(`${tmpDir}/config-hash`, "hash123");
    deleteConfigHash(tmpDir);
    assert.strictEqual(existsSync(`${tmpDir}/config-hash`), false);
  });

  it("does not throw when the file is missing", () => {
    deleteConfigHash(tmpDir);
    assert.strictEqual(existsSync(`${tmpDir}/config-hash`), false);
  });
});

describe("countLeakedRefs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the number of session reference files", () => {
    const stateDir = `${tmpDir}/.sandbox`;
    acquireSessionRef(stateDir, "a");
    acquireSessionRef(stateDir, "b");
    assert.strictEqual(countLeakedRefs(stateDir), 2);
  });

  it("returns 0 when there are no refs", () => {
    assert.strictEqual(countLeakedRefs(`${tmpDir}/.sandbox`), 0);
  });
});

describe("resetState", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes all session refs and config hash", () => {
    const stateDir = `${tmpDir}/.sandbox`;
    acquireSessionRef(stateDir, "a");
    acquireSessionRef(stateDir, "b");
    writeConfigHash(stateDir, "hash");
    resetState(stateDir);
    assert.strictEqual(existsSync(`${stateDir}/config-hash`), false);
    assert.strictEqual(existsSync(`${stateDir}/sessions`), false);
    assert.strictEqual(existsSync(stateDir), false);
  });

  it("does not throw when state is missing", () => {
    resetState(`${tmpDir}/.sandbox`);
  });
});
