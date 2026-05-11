import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { evaluateAccess, resolvePath, resolveSymlinks, type AccessOperation, type DenialReason } from "../src/acl.js";
import type { FilesystemConfig } from "../src/config.js";

const WORKSPACE = "/home/user/projects/myapp";

function assertAccess(
  path: string,
  operation: AccessOperation,
  filesystem: FilesystemConfig,
  expected: { allowed: boolean; reason?: DenialReason },
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
    assertAccess("/etc/shadow", "read", { rw: [], ro: [] }, { allowed: false, reason: "outside-workspace" });
    assertAccess("/etc/shadow", "write", { rw: [], ro: [] }, { allowed: false, reason: "outside-workspace" });
  });

  it("allows rw prefix outside workspace", () => {
    assertAccess("/tmp/file", "read", { rw: ["/tmp"], ro: [] }, { allowed: true });
    assertAccess("/tmp/file", "write", { rw: ["/tmp"], ro: [] }, { allowed: true });
  });

  it("blocks write on ro prefix", () => {
    assertAccess("/etc/passwd", "read", { rw: [], ro: ["/etc"] }, { allowed: true });
    assertAccess("/etc/passwd", "write", { rw: [], ro: ["/etc"] }, { allowed: false, reason: "read-only" });
  });

  it("picks longest matching prefix", () => {
    const fs: FilesystemConfig = { rw: ["/etc/ssl/certs"], ro: ["/etc"] };
    assertAccess("/etc/ssl/certs/ca.crt", "write", fs, { allowed: true });
    assertAccess("/etc/passwd", "write", fs, { allowed: false, reason: "read-only" });
  });

  it("breaks ties to ro", () => {
    const fs: FilesystemConfig = { rw: ["/shared"], ro: ["/shared"] };
    assertAccess("/shared/file", "read", fs, { allowed: true });
    assertAccess("/shared/file", "write", fs, { allowed: false, reason: "read-only" });
  });

  it("allows root rw to cover everything", () => {
    const fs: FilesystemConfig = { rw: ["/"], ro: [] };
    assertAccess("/anywhere", "write", fs, { allowed: true });
  });

  it("allows root ro and blocks writes", () => {
    const fs: FilesystemConfig = { rw: [], ro: ["/"] };
    assertAccess("/anywhere", "read", fs, { allowed: true });
    assertAccess("/anywhere", "write", fs, { allowed: false, reason: "read-only" });
  });
});

describe("resolveSymlinks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-sandbox-symlink-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a simple symlink to a file", () => {
    const target = join(tmpDir, "target.txt");
    const link = join(tmpDir, "link.txt");
    writeFileSync(target, "hello");
    symlinkSync(target, link);
    assert.strictEqual(resolveSymlinks(link), target);
  });

  it("resolves a symlink in a parent directory", () => {
    const realDir = join(tmpDir, "real");
    const linkDir = join(tmpDir, "link");
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    const filePath = join(linkDir, "file.txt");
    assert.strictEqual(resolveSymlinks(filePath), join(realDir, "file.txt"));
  });

  it("falls back to literal path for broken symlink", () => {
    const link = join(tmpDir, "broken");
    symlinkSync("/nonexistent/target", link);
    assert.strictEqual(resolveSymlinks(link), link);
  });

  it("recursively resolves parents for non-existent leaf through symlink parent", () => {
    const realDir = join(tmpDir, "real");
    const linkDir = join(tmpDir, "link");
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    const leaf = join(linkDir, "subdir", "file.txt");
    assert.strictEqual(resolveSymlinks(leaf), join(realDir, "subdir", "file.txt"));
  });

  it("throws ELOOP for symlink loops", () => {
    const a = join(tmpDir, "a");
    const b = join(tmpDir, "b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    assert.throws(
      () => resolveSymlinks(join(a, "file")),
      (err: unknown) => err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ELOOP",
    );
  });

});

describe("evaluateAccess with symlinks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-sandbox-eval-symlink-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows access through symlink inside workspace to allowed external path", () => {
    const externalDir = join(tmpDir, "external");
    const workspaceDir = join(tmpDir, "workspace");
    mkdirSync(externalDir);
    mkdirSync(workspaceDir);
    const link = join(workspaceDir, "link");
    symlinkSync(externalDir, link);
    const resolved = resolveSymlinks(join(link, "file.txt"));
    const result = evaluateAccess(resolved, "write", { rw: [externalDir], ro: [] }, workspaceDir);
    assert.strictEqual(result.allowed, true);
  });

  it("blocks access through symlink inside workspace to disallowed external path", () => {
    const externalDir = join(tmpDir, "external");
    const workspaceDir = join(tmpDir, "workspace");
    mkdirSync(externalDir);
    mkdirSync(workspaceDir);
    const link = join(workspaceDir, "link");
    symlinkSync(externalDir, link);
    const resolved = resolveSymlinks(join(link, "file.txt"));
    const result = evaluateAccess(resolved, "write", { rw: [], ro: [] }, workspaceDir);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "outside-workspace");
  });

  it("allows broken symlink inside workspace as literal path", () => {
    const workspaceDir = join(tmpDir, "workspace");
    mkdirSync(workspaceDir);
    const link = join(workspaceDir, "broken");
    symlinkSync("/nonexistent/target", link);
    const resolved = resolveSymlinks(link);
    const result = evaluateAccess(resolved, "read", { rw: [], ro: [] }, workspaceDir);
    assert.strictEqual(result.allowed, true);
  });

  it("returns read-only denial for symlink target under ro prefix", () => {
    const workspaceDir = join(tmpDir, "workspace");
    mkdirSync(workspaceDir);
    const link = join(workspaceDir, "link");
    symlinkSync("/etc", link);
    const resolved = resolveSymlinks(join(link, "passwd"));
    const result = evaluateAccess(resolved, "write", { rw: [], ro: ["/etc"] }, workspaceDir);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "read-only");
  });
});
