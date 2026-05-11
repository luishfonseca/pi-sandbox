import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Container } from "dockerode";
import { createSandboxExtension } from "./index.js";
import type { SandboxConfig } from "./config.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-sandbox-index-test-"));
}

interface MockPi extends ExtensionAPI {
  handlers: Record<string, ((event: unknown, ctx: ExtensionContext) => Promise<unknown>)[]>;
  tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[];
}

function createMockPi(): MockPi {
  const handlers: MockPi["handlers"] = {};
  const tools: MockPi["tools"] = [];

  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>): void {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }): void {
      tools.push(def);
    },
    registerFlag(_name: string, _def: unknown): void {
      // no-op
    },
    getFlag(_name: string): boolean {
      return false;
    },
    handlers,
    tools,
  } as unknown as MockPi;

  return pi;
}

function createMockCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId: () => "test-session-id",
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "",
    },
    ui: {
      notify: () => undefined,
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

describe("createSandboxExtension", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    writeFileSync(join(tmpDir, "sandbox.json"), JSON.stringify({ image: "alpine" }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers session_start, tool_call, and bash tool", () => {
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
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve(mockContainer),
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
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve(mockContainer),
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
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve(mockContainer),
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

  it("returns pull in progress error when image is missing", async () => {
    const config: SandboxConfig = { image: "alpine", env: {}, filesystem: { rw: [], ro: [] } };
    const pi = createMockPi();

    let pullResolve: (() => void) | undefined;
    const pullPromise = new Promise<void>((resolve) => {
      pullResolve = resolve;
    });

    const ext = createSandboxExtension({
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(false),
      pullImageFn: () => pullPromise,
      ensureContainerFn: () => Promise.resolve({} as Container),
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
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(false),
      pullImageFn: () => Promise.reject(new Error("network timeout")),
      ensureContainerFn: () => Promise.resolve({} as Container),
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
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve(mockContainer),
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
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve(mockContainer),
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
      loadConfigFn: () => config,
      doesImageExistFn: () => Promise.resolve(true),
      ensureContainerFn: () => Promise.resolve(mockContainer),
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
});
