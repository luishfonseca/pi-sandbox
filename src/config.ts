import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FilesystemConfig {
  rw: string[];
  ro: string[];
}

export interface SandboxConfig {
  image: string;
  env: Record<string, string>;
  filesystem: FilesystemConfig;
}

const TOP_LEVEL_KEYS = new Set(["image", "env", "filesystem"]);
const FILESYSTEM_KEYS = new Set(["rw", "ro"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  filePath: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      console.warn(`[pi-sandbox] Unknown key "${key}" in ${filePath} — ignoring`);
    }
  }
}

function readJsonFile(filePath: string): unknown {
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content) as unknown;
}

function loadOptionalConfig(filePath: string): unknown {
  try {
    return readJsonFile(filePath);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {};
    }
    if (err instanceof SyntaxError) {
      console.warn(`[pi-sandbox] Invalid JSON in ${filePath} — treating as {}`);
      return {};
    }
    throw err;
  }
}

function loadRequiredConfig(filePath: string): unknown {
  try {
    return readJsonFile(filePath);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`Global sandbox config missing: ${filePath}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Global sandbox config is invalid JSON: ${filePath}`);
    }
    throw err;
  }
}

function extractStringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") {
      result[k] = v;
    }
  }
  return result;
}

function extractFilesystem(value: unknown, filePath: string): FilesystemConfig {
  if (!isObject(value)) {
    return { rw: [], ro: [] };
  }
  warnUnknownKeys(value, FILESYSTEM_KEYS, filePath);

  const rw = extractStringArray(value.rw);
  const ro = extractStringArray(value.ro);

  return { rw, ro };
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function mergeStringMaps(
  global: Record<string, string>,
  workspace: Record<string, string>,
): Record<string, string> {
  let result: Record<string, string> = { ...global };
  for (const [key, value] of Object.entries(workspace)) {
    if (value === "") {
      const { [key]: _removed, ...rest } = result;
      result = rest;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergeStringLists(global: string[], workspace: string[]): string[] {
  if (workspace.length > 0 && workspace[0] === "") {
    return workspace.slice(1);
  }
  return [...global, ...workspace];
}

function validatePrefix(prefix: string, context: string): void {
  if (!prefix.startsWith("/")) {
    throw new Error(`${context} prefix must be absolute: "${prefix}"`);
  }
  if (prefix.includes("*") || prefix.includes("?")) {
    throw new Error(`${context} prefix must not contain wildcards: "${prefix}"`);
  }
  if (prefix.includes("..")) {
    throw new Error(`${context} prefix must not contain "..": "${prefix}"`);
  }
  if (prefix !== "/" && prefix.endsWith("/")) {
    throw new Error(`${context} prefix must not end with "/": "${prefix}"`);
  }
}

export function validateConfig(config: SandboxConfig): void {
  if (typeof config.image !== "string" || config.image.length === 0) {
    throw new Error('Merged sandbox config must have a non-empty "image" string');
  }

  for (const prefix of config.filesystem.rw) {
    validatePrefix(prefix, "filesystem.rw");
  }
  for (const prefix of config.filesystem.ro) {
    validatePrefix(prefix, "filesystem.ro");
  }
}

export function mergeConfigs(globalRaw: unknown, workspaceRaw: unknown): SandboxConfig {
  const globalObj = isObject(globalRaw) ? globalRaw : {};
  const workspaceObj = isObject(workspaceRaw) ? workspaceRaw : {};

  warnUnknownKeys(globalObj, TOP_LEVEL_KEYS, "global config");
  warnUnknownKeys(workspaceObj, TOP_LEVEL_KEYS, "workspace config");

  const globalEnv = extractStringMap(globalObj.env);
  const workspaceEnv = extractStringMap(workspaceObj.env);

  const globalFs = extractFilesystem(globalObj.filesystem, "global config#filesystem");
  const workspaceFs = extractFilesystem(workspaceObj.filesystem, "workspace config#filesystem");

  const image =
    typeof workspaceObj.image === "string" && workspaceObj.image.length > 0
      ? workspaceObj.image
      : typeof globalObj.image === "string"
        ? globalObj.image
        : "";

  return {
    image,
    env: mergeStringMaps(globalEnv, workspaceEnv),
    filesystem: {
      rw: mergeStringLists(globalFs.rw, workspaceFs.rw),
      ro: mergeStringLists(globalFs.ro, workspaceFs.ro),
    },
  };
}

export function loadConfig(workspacePath: string): SandboxConfig {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME environment variable is not set");
  }
  const globalPath = join(home, ".pi", "sandbox.json");
  const workspaceConfigPath = join(workspacePath, "sandbox.json");

  const globalRaw = loadRequiredConfig(globalPath);
  const workspaceRaw = loadOptionalConfig(workspaceConfigPath);

  const merged = mergeConfigs(globalRaw, workspaceRaw);
  validateConfig(merged);
  return merged;
}
