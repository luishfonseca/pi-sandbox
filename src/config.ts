import { isNodeError } from './acl.js';
import { type NetworkConfig, extractNetwork } from './network.js';
import { expandTilde } from './path.js';
import deepmerge from 'deepmerge';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FilesystemConfig {
  rw: string[];
  ro: string[];
}

export interface SandboxConfig {
  image: string;
  sidecarVersion?: string;
  env: Record<string, string>;
  filesystem: FilesystemConfig;
  network: NetworkConfig;
}

const TOP_LEVEL_KEYS = new Set(['image', 'env', 'filesystem', 'network', 'sidecarVersion']);
const FILESYSTEM_KEYS = new Set(['rw', 'ro']);
const NETWORK_KEYS = new Set(['domains', 'cidrs', 'denyCidrs']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectUnknownKeyWarnings(
  obj: Record<string, unknown>,
  known: Set<string>,
  filePath: string,
): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      warnings.push(`[pi-sandbox] Unknown key "${key}" in ${filePath} — ignoring`);
    }
  }
  return warnings;
}

function readJsonFile(filePath: string): unknown {
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as unknown;
}

export function loadDefaultsConfig(): unknown {
  const packageDir = dirname(fileURLToPath(import.meta.url));
  const defaultsPath = join(packageDir, '..', 'sandbox-default.json');
  try {
    return readJsonFile(defaultsPath);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Package defaults config missing: ${defaultsPath}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Package defaults config is invalid JSON: ${defaultsPath}`);
    }
    throw err;
  }
}

export function loadOptionalConfig(filePath: string): {
  data: unknown;
  warnings: string[];
  missing: boolean;
} {
  try {
    return { data: readJsonFile(filePath), warnings: [], missing: false };
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { data: {}, warnings: [], missing: true };
    }
    if (err instanceof SyntaxError) {
      return {
        data: {},
        warnings: [`[pi-sandbox] Invalid JSON in ${filePath} — treating as {}`],
        missing: false,
      };
    }
    throw err;
  }
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function extractFilesystemMerged(value: unknown): {
  config: FilesystemConfig;
  warnings: string[];
} {
  if (!isObject(value)) {
    return { config: { rw: [], ro: [] }, warnings: [] };
  }
  const warnings = collectUnknownKeyWarnings(value, FILESYSTEM_KEYS, 'merged config#filesystem');
  const rw = extractStringArray(value.rw).map(expandTilde);
  const ro = extractStringArray(value.ro).map(expandTilde);
  return { config: { rw, ro }, warnings };
}

function processNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    const lastNullIndex = arr.reduce<number>((acc, item, idx) => (item === null ? idx : acc), -1);
    if (lastNullIndex !== -1) {
      return arr.slice(lastNullIndex + 1).map(processNulls);
    }
    return arr.map(processNulls);
  }
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === null) continue;
      result[key] = processNulls(val);
    }
    return result;
  }
  return value;
}

function normalizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  if (!('env' in result)) result.env = {};
  if (!('filesystem' in result)) result.filesystem = { rw: [], ro: [] };
  if (!('network' in result)) result.network = {};
  return result;
}

function validatePrefix(prefix: string, context: string): void {
  if (!prefix.startsWith('/')) {
    throw new Error(`${context} prefix must be absolute: "${prefix}"`);
  }
  if (prefix.includes('*') || prefix.includes('?')) {
    throw new Error(`${context} prefix must not contain wildcards: "${prefix}"`);
  }
  if (prefix.includes('..')) {
    throw new Error(`${context} prefix must not contain "..": "${prefix}"`);
  }
  if (prefix !== '/' && prefix.endsWith('/')) {
    throw new Error(`${context} prefix must not end with "/": "${prefix}"`);
  }
}

export interface AugmentResult {
  config: SandboxConfig;
  augmented: boolean;
  warning?: string;
}

export function augmentConfigWithPiDir(config: SandboxConfig): AugmentResult {
  const piDir = process.env.PI_PACKAGE_DIR;
  if (!piDir || piDir.trim().length === 0) {
    return {
      config,
      augmented: false,
      warning:
        'PI_PACKAGE_DIR is not set; the model will not be able to read pi documentation inside the sandbox.',
    };
  }
  if (config.filesystem.ro.includes(piDir)) {
    return { config, augmented: false };
  }
  return {
    config: {
      ...config,
      filesystem: {
        ...config.filesystem,
        ro: [...config.filesystem.ro, piDir],
      },
    },
    augmented: true,
  };
}

export function validateConfig(config: SandboxConfig): void {
  if (typeof config.image !== 'string' || config.image.length === 0) {
    throw new Error(`Merged sandbox config must have a non-empty "image" string`);
  }

  if (
    config.sidecarVersion !== undefined &&
    (typeof config.sidecarVersion !== 'string' || config.sidecarVersion.length === 0)
  ) {
    throw new Error(`sidecarVersion must be a non-empty string`);
  }

  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value !== 'string') {
      throw new Error(`env value for "${key}" must be a string, got ${typeof value}`);
    }
  }

  for (const prefix of config.filesystem.rw) {
    validatePrefix(prefix, 'filesystem.rw');
  }
  for (const prefix of config.filesystem.ro) {
    validatePrefix(prefix, 'filesystem.ro');
  }
}

export function mergeConfigs(
  defaultsRaw: unknown,
  globalRaw: unknown,
  workspaceRaw: unknown,
): { config: SandboxConfig; warnings: string[] } {
  const warnings: string[] = [];

  for (const [raw, label] of [
    [defaultsRaw, 'package defaults'],
    [globalRaw, 'global config'],
    [workspaceRaw, 'workspace config'],
  ] as const) {
    const obj = isObject(raw) ? raw : {};
    warnings.push(...collectUnknownKeyWarnings(obj, TOP_LEVEL_KEYS, label));
    if (isObject(obj.network)) {
      warnings.push(...collectUnknownKeyWarnings(obj.network, NETWORK_KEYS, `${label}#network`));
    }
  }

  const merged = deepmerge.all([
    isObject(defaultsRaw) ? defaultsRaw : {},
    isObject(globalRaw) ? globalRaw : {},
    isObject(workspaceRaw) ? workspaceRaw : {},
  ]) as Record<string, unknown>;

  const postProcessed = processNulls(merged) as Record<string, unknown>;
  const normalized = normalizeConfig(postProcessed);

  const { config: filesystem, warnings: fsWarnings } = extractFilesystemMerged(
    normalized.filesystem,
  );
  warnings.push(...fsWarnings);

  const envObj = isObject(normalized.env) ? normalized.env : {};
  for (const [key, value] of Object.entries(envObj)) {
    if (typeof value !== 'string') {
      throw new Error(
        `env value for "${key}" in merged config must be a string, got ${typeof value}`,
      );
    }
  }
  const env = envObj as Record<string, string>;

  const config: SandboxConfig = {
    image: typeof normalized.image === 'string' ? normalized.image : '',
    env,
    filesystem,
    network: isObject(normalized.network) ? normalized.network : {},
  };

  if (normalized.sidecarVersion !== undefined) {
    config.sidecarVersion =
      typeof normalized.sidecarVersion === 'string' ? normalized.sidecarVersion : '';
  }

  return { config, warnings };
}

export function loadConfig(workspacePath: string): {
  config: SandboxConfig;
  warnings: string[];
} {
  const defaultsRaw = loadDefaultsConfig();

  const globalPath = join(homedir(), '.pi', 'sandbox.json');
  const {
    data: globalRaw,
    warnings: globalWarnings,
    missing: globalMissing,
  } = loadOptionalConfig(globalPath);

  const workspaceConfigPath = join(workspacePath, 'sandbox.json');
  const {
    data: workspaceRaw,
    warnings: workspaceWarnings,
    missing: workspaceMissing,
  } = loadOptionalConfig(workspaceConfigPath);

  const { config: merged, warnings: mergeWarnings } = mergeConfigs(
    defaultsRaw,
    globalRaw,
    workspaceRaw,
  );

  const networkResult = extractNetwork(merged.network, 'merged config');
  merged.network = networkResult.config ?? {};
  mergeWarnings.push(...networkResult.warnings);

  validateConfig(merged);

  const warnings = [...globalWarnings, ...workspaceWarnings, ...mergeWarnings];
  if (globalMissing && workspaceMissing) {
    warnings.push(
      '[pi-sandbox] No sandbox.json found in workspace or ~/.pi. Using package defaults only.',
    );
  }

  return { config: merged, warnings };
}
