import assert from "node:assert";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { evaluateAccess, resolvePath, type AccessOperation } from "./acl.js";
import type { FilesystemConfig } from "./config.js";

const WORKSPACE = "/home/user/projects/myapp";

function assertAccess(
  path: string,
  operation: AccessOperation,
  filesystem: FilesystemConfig,
  expected: { allowed: boolean; reason?: string },
): void {
  const resolved = resolvePath(path, WORKSPACE);
  const result = evaluateAccess(resolved, operation, filesystem, WORKSPACE);
  assert.strictEqual(result.allowed, expected.allowed, `path=${path} op=${operation}`);
  assert.strictEqual(result.reason, expected.reason, `path=${path} op=${operation}`);
}

describe("resolvePath", () => {
  it("resolves absolute paths unchanged", () => {
    assert.strictEqual(resolvePath("/etc/shadow", WORKSPACE), "/etc/shadow");
  });

  it("normalizes absolute paths", () => {
    assert.strictEqual(resolvePath("/foo/../bar", WORKSPACE), "/bar");
  });

  it("resolves relative paths against workspace", () => {
    assert.strictEqual(resolvePath("./src/main.ts", WORKSPACE), resolve(WORKSPACE, "src/main.ts"));
  });

  it("expands ~ to homedir", () => {
    assert.strictEqual(resolvePath("~", WORKSPACE), homedir());
  });

  it("expands ~/foo to homedir/foo", () => {
    assert.strictEqual(resolvePath("~/foo", WORKSPACE), resolve(homedir(), "foo"));
  });

  it("treats ~user as literal path segment", () => {
    assert.strictEqual(resolvePath("~user/foo", WORKSPACE), resolve(WORKSPACE, "~user/foo"));
  });

  it("strips trailing slash except for root", () => {
    assert.strictEqual(resolvePath("/tmp/", WORKSPACE), "/tmp");
    assert.strictEqual(resolvePath("/", WORKSPACE), "/");
  });
});

describe("evaluateAccess", () => {
  it("allows read and write inside workspace by default", () => {
    assertAccess("./src/main.ts", "read", { rw: [], ro: [] }, { allowed: true });
    assertAccess("./src/main.ts", "write", { rw: [], ro: [] }, { allowed: true });
  });

  it("blocks read and write outside workspace by default", () => {
    const reason = "Path outside workspace: /etc/shadow";
    assertAccess("/etc/shadow", "read", { rw: [], ro: [] }, { allowed: false, reason });
    assertAccess("/etc/shadow", "write", { rw: [], ro: [] }, { allowed: false, reason });
  });

  it("allows rw prefix outside workspace", () => {
    assertAccess("/tmp/file", "read", { rw: ["/tmp"], ro: [] }, { allowed: true });
    assertAccess("/tmp/file", "write", { rw: ["/tmp"], ro: [] }, { allowed: true });
  });

  it("blocks write on ro prefix", () => {
    const reason = "Read-only path: /etc/passwd";
    assertAccess("/etc/passwd", "read", { rw: [], ro: ["/etc"] }, { allowed: true });
    assertAccess("/etc/passwd", "write", { rw: [], ro: ["/etc"] }, { allowed: false, reason });
  });

  it("picks longest matching prefix", () => {
    const fs: FilesystemConfig = { rw: ["/etc/ssl/certs"], ro: ["/etc"] };
    assertAccess("/etc/ssl/certs/ca.crt", "write", fs, { allowed: true });
    assertAccess("/etc/passwd", "write", fs, { allowed: false, reason: "Read-only path: /etc/passwd" });
  });

  it("breaks ties to ro", () => {
    const fs: FilesystemConfig = { rw: ["/shared"], ro: ["/shared"] };
    assertAccess("/shared/file", "read", fs, { allowed: true });
    assertAccess("/shared/file", "write", fs, { allowed: false, reason: "Read-only path: /shared/file" });
  });

  it("allows root rw to cover everything", () => {
    const fs: FilesystemConfig = { rw: ["/"], ro: [] };
    assertAccess("/anywhere", "write", fs, { allowed: true });
  });

  it("allows root ro and blocks writes", () => {
    const fs: FilesystemConfig = { rw: [], ro: ["/"] };
    assertAccess("/anywhere", "read", fs, { allowed: true });
    assertAccess("/anywhere", "write", fs, { allowed: false, reason: "Read-only path: /anywhere" });
  });
});
