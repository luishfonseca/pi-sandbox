import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Container } from "dockerode";
import { createSandboxExtension } from "../src/index.js";
import type { SandboxConfig } from "../src/config.js";
import { DockerDaemonUnreachableError } from "../src/docker.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-sandbox-index-test-"));
}

interface MockCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

interface MockPi extends ExtensionAPI {
  handlers: Record<string, ((event: unknown, ctx: ExtensionContext) => Promise<unknown>)[]>;
  tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[];
  commands: MockCommand[];
}

function createMockPi(): MockPi {
  const handlers: MockPi["handlers"] = {};
  const tools: MockPi["tools"] = [];
  const commands: MockPi["commands"] = [];

  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>): void {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }): void {
      tools.push(def);
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void {
      commands.push({ name, ...options });
    },
    registerFlag(_name: string, _def: unknown): void {
      // no-op
    },
    getFlag(_name: string): boolean {
      return false;
    },
    handlers,
    tools,
    commands,
  } as unknown as MockPi;

  return pi;
}

function createMockCtx(
  cwd: string,
  notifications?: { message: string; type: string }[],
  sessionDir?: string,
): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId: () => "test-session-id",
      getSessionDir: () => sessionDir ?? cwd,
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "",
    },
    ui: {
      notify: (message: string, type: string) => {
        notifications?.push({ message, type });
      },
      confirm: () => Promise.resolve(false),
      select: () => Promise.resolve(undefined),
      input: () => Promise.resolve(undefined),
      editor: () => Promise.resolve(undefined),
      setStatus: () => undefined,
      setWidget: () => undefined,
      setTitle: () => undefined,
      setEditorText: () => undefined,
      theme: {} as unknown as ExtensionContext["ui"]["theme"],
    },
    signal: undefined,
    isIdle: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    modelRegistry: {} as unknown as ExtensionContext["modelRegistry"],
    model: {} as unknown as ExtensionContext["model"],
  } as unknown as ExtensionContext;
}

function getHandler(pi: MockPi, event: string): (event: unknown, ctx: ExtensionContext) => Promise<unknown> {
  const list = pi.handlers[event];
  if (list === undefined || list.length === 0) {
    throw new Error(`Missing handler for ${event}`);
  }
  const handler = list[0];
  if (handler === undefined) {
    throw new Error(`Handler list empty for ${event}`);
  }
  return handler;
}

function getFirstTool(pi: MockPi): { name: string; execute: (...args: unknown[]) => Promise<unknown> } {
  const tool = pi.tools[0];
  if (tool === undefined) {
    throw new Error("No tools registered");
  }
  return tool;
}

function getCommandByName(pi: MockPi, name: string): MockCommand {
  const cmd = pi.commands.find((c) => c.name === name);
  if (cmd === undefined) {
    throw new Error(`Command "${name}" not registered`);
  }
  return cmd;
}

function createMockCtxWithSession(
  cwd: string,
  sessionId: string,
  notifications?: { message: string; type: string }[],
  sessionDir?: string,
): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir ?? cwd,
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "",
    },
    ui: {
      notify: (message: string, type: string) => {
        notifications?.push({ message, type });
      },
      confirm: () => Promise.resolve(false),
      select: () => Promise.resolve(undefined),
      input: () => Promise.resolve(undefined),
      editor: () => Promise.resolve(undefined),
      setStatus: () => undefined,
      setWidget: () => undefined,
      setTitle: () => undefined,
      setEditorText: () => undefined,
      theme: {} as unknown as ExtensionContext["ui"]["theme"],
    },
    signal: undefined,
    isIdle: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    modelRegistry: {} as unknown as ExtensionContext["modelRegistry"],
    model: {} as unknown as ExtensionContext["model"],
  } as unknown as ExtensionContext;
}

describe("createSandboxExtension", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    writeFileSync(join(tmpDir, "sandbox.json"), JSON.stringify({ image: "alpine" }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers session_start, tool_call, bash tool, and commands", () => {
    const pi = createMockPi();
    createSandboxExtension()(pi);
    assert.ok(pi.handlers.session_start !== undefined);
    assert.ok(pi.handlers.tool_call !== undefined);
    assert.strictEqual(pi.tools.length, 1);
    const firstTool = pi.tools[0];
    if (firstTool === undefined) {
      throw new Error("No tools registered");
    }
    assert.strictEqual(firstTool.name, "bash");
    assert.strictEqual(pi.commands.length, 2);
    assert.ok(pi.commands.some((c) => c.name === "sandbox-status"));
    assert.ok(pi.commands.some((c) => c.name === "sandbox-reset"));
  });

  it("blocks tool calls when sandbox is not initialized", async () => {
    const pi = createMockPi();
    createSandboxExtension()(pi);

    const result = await getHandler(pi, "tool_call")(
      { toolName: "read", input: { path: "./file.txt" } },
      createMockCtx(tmpDir),
    );
    assert.deepStrictEqual(result, { block: true, reason: "Sandbox not initialized" });
  });

  it("blocks read outside workspace", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const result = await getHandler(pi, "tool_call")(
      { toolName: "read", input: { path: "/etc/shadow" } },
      ctx,
    );
    assert.deepStrictEqual(result, { block: true, reason: "Path outside workspace: /etc/shadow" });
  });

  it("allows write inside workspace", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const result = await getHandler(pi, "tool_call")(
      { toolName: "write", input: { path: "./file.txt" } },
      ctx,
    );
    assert.strictEqual(result, undefined);
  });

  it("returns error from bash tool when sandbox not initialized", async () => {
    const pi = createMockPi();
    createSandboxExtension()(pi);

    const bashTool = getFirstTool(pi);
    const result = (await bashTool.execute(
      "call-1",
      { command: "echo hi" },
      undefined,
      undefined,
      createMockCtx("/tmp"),
    )) as { isError: boolean; content: { text: string }[] };
    assert.strictEqual(result.isError, true);
    const firstContent = result.content[0];
    if (firstContent === undefined) {
      throw new Error("Missing content item");
    }
    assert.ok(firstContent.text.includes("not running"));
  });

  it("executes bash command via container when ready", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
      execInContainerFn: () => Promise.resolve({ stdout: "hello", stderr: "", exitCode: 0 }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const bashTool = getFirstTool(pi);
    const result = (await bashTool.execute(
      "call-1",
      { command: "echo hello" },
      undefined,
      undefined,
      ctx,
    )) as { isError: boolean; content: { text: string }[]; details: { exitCode: number } };
    assert.strictEqual(result.isError, false);
    const firstContent = result.content[0];
    if (firstContent === undefined) {
      throw new Error("Missing content item");
    }
    assert.strictEqual(firstContent.text, "hello");
    assert.strictEqual(result.details.exitCode, 0);
  });

  it("truncates bash output exceeding 2000 lines", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const lines = 3000;
    const fullStdout = Array.from({ length: lines }, (_, i) => `line ${String(i + 1)}`).join("\n");

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
      execInContainerFn: () => Promise.resolve({ stdout: fullStdout, stderr: "", exitCode: 0 }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const bashTool = getFirstTool(pi);
    const result = (await bashTool.execute(
      "call-1",
      { command: "seq 1 3000" },
      undefined,
      undefined,
      ctx,
    )) as { isError: boolean; content: { text: string }[]; details: { stdout: string; stderr: string; exitCode: number } };
    assert.strictEqual(result.isError, false);

    const firstContent = result.content[0];
    if (firstContent === undefined) {
      throw new Error("Missing content item");
    }

    // Content should be truncated and contain the marker
    assert.ok(firstContent.text.includes("[Output truncated:"), "Expected truncation marker in content text");
    assert.ok(!firstContent.text.includes("line 1\n"), "Expected first line to be truncated from content");
    assert.ok(firstContent.text.includes("line 3000"), "Expected last line to be present in content");

    // Details should retain full untruncated output
    assert.strictEqual(result.details.stdout, fullStdout);
    assert.strictEqual(result.details.stderr, "");
    assert.strictEqual(result.details.exitCode, 0);
  });

  it("returns pull in progress error when image is missing", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();

    let pullResolve: (() => void) | undefined;
    const pullPromise = new Promise<void>((resolve) => {
      pullResolve = resolve;
    });

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(false),
      pullImageFn: () => pullPromise,
      ensureContainerFn: () => Promise.resolve({ container: {} as Container, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const bashTool = getFirstTool(pi);
    const result = (await bashTool.execute(
      "call-1",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    )) as { isError: boolean; content: { text: string }[] };
    assert.strictEqual(result.isError, true);
    const firstContent = result.content[0];
    if (firstContent === undefined) {
      throw new Error("Missing content item");
    }
    assert.ok(firstContent.text.includes("Pulling sandbox image"));

    pullResolve?.();
  });

  it("returns pull error when image pull fails", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(false),
      pullImageFn: () => Promise.reject(new Error("network timeout")),
      ensureContainerFn: () => Promise.resolve({ container: {} as Container, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const bashTool = getFirstTool(pi);
    const result = (await bashTool.execute(
      "call-1",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    )) as { isError: boolean; content: { text: string }[] };
    assert.strictEqual(result.isError, true);
    const firstContent = result.content[0];
    if (firstContent === undefined) {
      throw new Error("Missing content item");
    }
    assert.ok(firstContent.text.includes("network timeout"));
  });

  it("blocks symlink loop with mapped reason", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const linkA = join(tmpDir, "a");
    const linkB = join(tmpDir, "b");
    symlinkSync(linkB, linkA);
    symlinkSync(linkA, linkB);

    const result = await getHandler(pi, "tool_call")(
      { toolName: "read", input: { path: join(linkA, "file") } },
      ctx,
    );
    assert.deepStrictEqual(result, { block: true, reason: `Symlink loop detected: ${join(linkA, "file")}` });
  });

  it("allows broken symlink inside workspace and delegates ENOENT to native tool", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const link = join(tmpDir, "broken");
    symlinkSync("/nonexistent/target", link);

    const result = await getHandler(pi, "tool_call")(
      { toolName: "read", input: { path: join(tmpDir, "broken") } },
      ctx,
    );
    assert.strictEqual(result, undefined);
  });

  it("blocks symlink bypass to disallowed external path", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const externalDir = mkdtempSync(join(tmpdir(), "pi-sandbox-external-"));
    const link = join(tmpDir, "secret");
    symlinkSync(externalDir, link);

    const result = await getHandler(pi, "tool_call")(
      { toolName: "read", input: { path: join(tmpDir, "secret") } },
      ctx,
    );
    assert.deepStrictEqual(result, { block: true, reason: `Path outside workspace: ${join(tmpDir, "secret")}` });

    rmSync(externalDir, { recursive: true, force: true });
  });

  it("Guard allows read to path under PI_PACKAGE_DIR after augmentation", async () => {
    const originalPiDir = process.env.PI_PACKAGE_DIR;
    process.env.PI_PACKAGE_DIR = "/nix/store/abc/pi-monorepo";
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    if (originalPiDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiDir;
    }

    const result = await getHandler(pi, "tool_call")(
      { toolName: "read", input: { path: "/nix/store/abc/pi-monorepo/docs/extensions.md" } },
      ctx,
    );
    assert.strictEqual(result, undefined);
  });

  it("presents config warnings via ctx.ui.notify", async () => {
    const originalPiDir = process.env.PI_PACKAGE_DIR;
    process.env.PI_PACKAGE_DIR = "/nix/store/abc/pi-monorepo";
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const notifications: { message: string; type: string }[] = [];
    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: ["Unknown key \"foo\"", "Invalid JSON"] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir, notifications);
    await getHandler(pi, "session_start")({}, ctx);

    if (originalPiDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiDir;
    }

    assert.strictEqual(notifications.length, 2);
    assert.ok(notifications[0]?.message.includes("Unknown key"));
    assert.strictEqual(notifications[0]?.type, "warning");
    assert.ok(notifications[1]?.message.includes("Invalid JSON"));
    assert.strictEqual(notifications[1]?.type, "warning");
  });

  it("presents warning notification when PI_PACKAGE_DIR is not set", async () => {
    const originalPiDir = process.env.PI_PACKAGE_DIR;
    delete process.env.PI_PACKAGE_DIR;
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const notifications: { message: string; type: string }[] = [];
    const ctx = createMockCtx(tmpDir, notifications);
    await getHandler(pi, "session_start")({}, ctx);

    if (originalPiDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiDir;
    }

    assert.strictEqual(notifications.length, 1);
    assert.ok(notifications[0]?.message.includes("PI_PACKAGE_DIR is not set"));
    assert.strictEqual(notifications[0]?.type, "warning");
  });

  it("writes session ref file on session_start", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const refFile = join(tmpDir, ".sandbox", "sessions", "test-session-id");
    assert.strictEqual(existsSync(refFile), true);
  });

  it("stops container on session_shutdown when last ref is removed", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    let stoppedContainerName: string | undefined;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
      stopAndRemoveContainerFn: (_docker, name): Promise<void> => {
        stoppedContainerName = name;
        return Promise.resolve();
      },
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);
    await getHandler(pi, "session_shutdown")({}, ctx);

    assert.strictEqual(stoppedContainerName !== undefined, true);
    const refFile = join(tmpDir, ".sandbox", "sessions", "test-session-id");
    assert.strictEqual(existsSync(refFile), false);
    assert.strictEqual(existsSync(join(tmpDir, ".sandbox", "config-hash")), false);
  });

  it("does not delete config hash on session_shutdown when stopAndRemoveContainer throws", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
      stopAndRemoveContainerFn: (): Promise<void> => Promise.reject(new Error("docker unreachable")),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    await assert.rejects(
      () => getHandler(pi, "session_shutdown")({}, ctx),
      /docker unreachable/,
    );

    assert.strictEqual(existsSync(join(tmpDir, ".sandbox", "config-hash")), true);
  });

  it("leaves container running on session_shutdown when other refs exist", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    let stopped = false;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
      stopAndRemoveContainerFn: (): Promise<void> => {
        stopped = true;
        return Promise.resolve();
      },
    });
    ext(pi);

    const ctxA = createMockCtxWithSession(tmpDir, "session-a");
    const ctxB = createMockCtxWithSession(tmpDir, "session-b");

    await getHandler(pi, "session_start")({}, ctxA);
    await getHandler(pi, "session_start")({}, ctxB);
    await getHandler(pi, "session_shutdown")({}, ctxA);

    assert.strictEqual(stopped, false);
    assert.strictEqual(existsSync(join(tmpDir, ".sandbox", "sessions", "session-b")), true);
  });

  it("writes config hash on first session_start", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir);
    await getHandler(pi, "session_start")({}, ctx);

    const hashFile = join(tmpDir, ".sandbox", "config-hash");
    assert.strictEqual(existsSync(hashFile), true);
    const stored = readFileSync(hashFile, "utf-8");
    assert.strictEqual(stored.length, 16);
  });

  it("emits config staleness warning when reusing container with different config", async () => {
    const config1: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const config2: SandboxConfig = { image: "ubuntu", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const notifications: { message: string; type: string }[] = [];

    const ext = createSandboxExtension({
      loadConfigFn: ((): (() => { config: SandboxConfig; warnings: string[] }) => {
        let call = 0;
        return () => {
          call++;
          return { config: call === 1 ? config1 : config2, warnings: [] };
        };
      })(),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: false }),
    });
    ext(pi);

    const ctx1 = createMockCtxWithSession(tmpDir, "session-a", notifications);
    await getHandler(pi, "session_start")({}, ctx1);

    const ctx2 = createMockCtxWithSession(tmpDir, "session-b", notifications);
    await getHandler(pi, "session_start")({}, ctx2);

    assert.ok(notifications.some((n) => n.message.includes("Sandbox config has changed")));
  });

  it("sandbox-reset stops container and clears state", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    let stoppedContainerName: string | undefined;
    const notifications: { message: string; type: string }[] = [];

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
      stopAndRemoveContainerFn: (_docker, name): Promise<void> => {
        stoppedContainerName = name;
        return Promise.resolve();
      },
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir, notifications);
    await getHandler(pi, "session_start")({}, ctx);

    // Simulate a leaked ref.
    writeFileSync(join(tmpDir, ".sandbox", "sessions", "leaked-session"), "");

    const resetCmd = getCommandByName(pi, "sandbox-reset");
    await resetCmd.handler("", ctx);

    assert.strictEqual(stoppedContainerName !== undefined, true);
    assert.strictEqual(existsSync(join(tmpDir, ".sandbox", "sessions")), false);
    assert.strictEqual(existsSync(join(tmpDir, ".sandbox")), false);
    assert.ok(notifications.some((n) => n.message.includes("Reset sandbox container")));
  });

  it("sandbox-reset notifies when no state exists", async () => {
    const pi = createMockPi();
    createSandboxExtension()(pi);

    const notifications: { message: string; type: string }[] = [];
    const ctx = createMockCtx(tmpDir, notifications);

    const resetCmd = getCommandByName(pi, "sandbox-reset");
    await resetCmd.handler("", ctx);

    assert.ok(notifications.some((n) => n.message.includes("No sandbox state found")));
  });

  it("sandbox-status reports disabled when --no-sandbox is set", async () => {
    const pi = createMockPi();
    pi.getFlag = (name: string): boolean => name === "no-sandbox";
    const notifications: { message: string; type: string }[] = [];

    const ext = createSandboxExtension();
    ext(pi);

    const ctx = createMockCtx(tmpDir, notifications);
    const statusCmd = getCommandByName(pi, "sandbox-status");
    await statusCmd.handler("", ctx);

    assert.ok(notifications.some((n) => n.message.includes("disabled (--no-sandbox is set)")));
    assert.strictEqual(notifications[0]?.type, "info");
  });

  it("sandbox-status reports active sandbox state", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: ["/tmp/shared"], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const notifications: { message: string; type: string }[] = [];

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: true }),
      getContainerStatusFn: () => Promise.resolve("running"),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir, notifications);
    await getHandler(pi, "session_start")({}, ctx);

    const statusCmd = getCommandByName(pi, "sandbox-status");
    await statusCmd.handler("", ctx);

    const notification = notifications.find((n) => n.message.startsWith("Sandbox status:"));
    assert.ok(notification !== undefined);
    assert.ok(notification.message.includes("running"));
    assert.ok(notification.message.includes("alpine"));
    assert.ok(notification.message.includes("/tmp/shared"));
    assert.ok(notification.message.includes("1 active"));

    assert.strictEqual(notification.type, "info");
  });

  it("sandbox-status reports stale config", async () => {
    const config1: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const config2: SandboxConfig = { image: "ubuntu", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();
    const mockContainer = {
      inspect: () => Promise.resolve({ State: { Running: true } }),
    } as unknown as Container;

    const notifications: { message: string; type: string }[] = [];

    const ext = createSandboxExtension({
      loadConfigFn: ((): (() => { config: SandboxConfig; warnings: string[] }) => {
        let call = 0;
        return () => {
          call++;
          return { config: call === 1 ? config1 : config2, warnings: [] };
        };
      })(),
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve({ container: mockContainer, created: false }),
      getContainerStatusFn: () => Promise.resolve("running"),
    });
    ext(pi);

    const ctx1 = createMockCtxWithSession(tmpDir, "session-a", notifications);
    await getHandler(pi, "session_start")({}, ctx1);

    const ctx2 = createMockCtxWithSession(tmpDir, "session-b", notifications);
    await getHandler(pi, "session_start")({}, ctx2);

    const statusCmd = getCommandByName(pi, "sandbox-status");
    await statusCmd.handler("", ctx2);

    const statusNotification = notifications.find((n) => n.message.startsWith("Sandbox status:"));
    assert.ok(statusNotification !== undefined);
    assert.ok(statusNotification.message.includes("stale"));
  });

  it("sandbox-status reports no container", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();

    const notifications: { message: string; type: string }[] = [];

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      getContainerStatusFn: () => Promise.resolve("not found"),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir, notifications);
    const statusCmd = getCommandByName(pi, "sandbox-status");
    await statusCmd.handler("", ctx);

    const notification = notifications.find((n) => n.message.startsWith("Sandbox status:"));
    assert.ok(notification !== undefined);
    assert.ok(notification.message.includes("not found"));
    assert.ok(notification.message.includes("0 active"));
  });

  it("sandbox-status surfaces Docker daemon unreachable", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();

    const notifications: { message: string; type: string }[] = [];

    const ext = createSandboxExtension({
      loadConfigFn: () => ({ config, warnings: [] }),
      getContainerStatusFn: () => Promise.reject(new DockerDaemonUnreachableError()),
    });
    ext(pi);

    const ctx = createMockCtx(tmpDir, notifications);
    const statusCmd = getCommandByName(pi, "sandbox-status");
    await statusCmd.handler("", ctx);

    assert.ok(notifications.some((n) => n.message === "Docker daemon unreachable"));
    assert.ok(notifications.some((n) => n.type === "error"));
  });
});
