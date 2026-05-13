import { isNodeError } from './acl.js';
import { type NetworkConfig, checkBuiltInDenyOverlaps, extractNetwork } from './network.js';
import { expandTilde } from './path.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FilesystemConfig {
  rw: string[];
  ro: string[];
}

export interface SandboxConfig {
  image: string;
  sidecarImage?: string;
  env: Record<string, string>;
  filesystem: FilesystemConfig;
  network?: NetworkConfig;
}

const TOP_LEVEL_KEYS = new Set(['image', 'env', 'filesystem', 'network', 'sidecarImage']);
const FILESYSTEM_KEYS = new Set(['rw', 'ro']);

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

function loadOptionalConfig(filePath: string): { data: unknown; warnings: string[] } {
  try {
    return { data: readJsonFile(filePath), warnings: [] };
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { data: {}, warnings: [] };
    }
    if (err instanceof SyntaxError) {
      return {
        data: {},
        warnings: [`[pi-sandbox] Invalid JSON in ${filePath} — treating as {}`],
      };
    }
    throw err;
  }
}

function loadRequiredConfig(filePath: string): unknown {
  try {
    return readJsonFile(filePath);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Global sandbox config missing: ${filePath}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Global sandbox config is invalid JSON: ${filePath}`);
    }
    throw err;
  }
}

function extractStringMap(value: unknown, context: string): Record<string, string> {
  if (!isObject(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new Error(`env value for "${k}" in ${context} must be a string, got ${typeof v}`);
    }
    result[k] = v;
  }
  return result;
}

function extractFilesystem(
  value: unknown,
  filePath: string,
): { config: FilesystemConfig; warnings: string[] } {
  if (!isObject(value)) {
    return { config: { rw: [], ro: [] }, warnings: [] };
  }
  const warnings = collectUnknownKeyWarnings(value, FILESYSTEM_KEYS, filePath);

  const rw = extractStringArray(value.rw).map(expandTilde);
  const ro = extractStringArray(value.ro).map(expandTilde);

  return { config: { rw, ro }, warnings };
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function mergeStringMaps(
  global: Record<string, string>,
  workspace: Record<string, string>,
): Record<string, string> {
  let result: Record<string, string> = { ...global };
  for (const [key, value] of Object.entries(workspace)) {
    if (value === '') {
      const { [key]: _removed, ...rest } = result;
      result = rest;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergeStringLists(global: string[], workspace: string[]): string[] {
  if (workspace.length > 0 && workspace[0] === '') {
    return workspace.slice(1);
  }
  return [...global, ...workspace];
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
    config.sidecarImage !== undefined &&
    (typeof config.sidecarImage !== 'string' || config.sidecarImage.length === 0)
  ) {
    throw new Error(`sidecarImage must be a non-empty string`);
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

function resolveImage(
  workspaceObj: Record<string, unknown>,
  globalObj: Record<string, unknown>,
): string {
  return typeof workspaceObj.image === 'string' && workspaceObj.image.length > 0
    ? workspaceObj.image
    : typeof globalObj.image === 'string'
      ? globalObj.image
      : '';
}

function resolveSidecarImage(globalObj: Record<string, unknown>): string | undefined {
  return typeof globalObj.sidecarImage === 'string' && globalObj.sidecarImage.length > 0
    ? globalObj.sidecarImage
    : undefined;
}

function mergeNetwork(
  workspaceObj: Record<string, unknown>,
  globalObj: Record<string, unknown>,
): { config?: NetworkConfig | undefined; warnings: string[] } {
  const globalNetwork = extractNetwork(globalObj.network, 'global config');
  const workspaceNetwork = extractNetwork(workspaceObj.network, 'workspace config');
  const warnings = [...globalNetwork.warnings, ...workspaceNetwork.warnings];

  let config: NetworkConfig | undefined;
  if (workspaceObj.network !== undefined) {
    config = workspaceNetwork.config;
  } else if (globalObj.network !== undefined) {
    config = globalNetwork.config;
  }

  if (config !== undefined) {
    warnings.push(...checkBuiltInDenyOverlaps(config));
  }

  return { config, warnings };
}

export function mergeConfigs(
  globalRaw: unknown,
  workspaceRaw: unknown,
): { config: SandboxConfig; warnings: string[] } {
  const globalObj = isObject(globalRaw) ? globalRaw : {};
  const workspaceObj = isObject(workspaceRaw) ? workspaceRaw : {};

  const warnings: string[] = [];
  warnings.push(...collectUnknownKeyWarnings(globalObj, TOP_LEVEL_KEYS, 'global config'));
  warnings.push(...collectUnknownKeyWarnings(workspaceObj, TOP_LEVEL_KEYS, 'workspace config'));

  const globalEnv = extractStringMap(globalObj.env, 'global config');
  const workspaceEnv = extractStringMap(workspaceObj.env, 'workspace config');

  const globalFs = extractFilesystem(globalObj.filesystem, 'global config#filesystem');
  const workspaceFs = extractFilesystem(workspaceObj.filesystem, 'workspace config#filesystem');
  warnings.push(...globalFs.warnings, ...workspaceFs.warnings);

  const networkResult = mergeNetwork(workspaceObj, globalObj);
  warnings.push(...networkResult.warnings);

  if (workspaceObj.sidecarImage !== undefined) {
    warnings.push(
      '[pi-sandbox] sidecarImage in workspace config is ignored; set it in global config only',
    );
  }

  const result: SandboxConfig = {
    image: resolveImage(workspaceObj, globalObj),
    env: mergeStringMaps(globalEnv, workspaceEnv),
    filesystem: {
      rw: mergeStringLists(globalFs.config.rw, workspaceFs.config.rw),
      ro: mergeStringLists(globalFs.config.ro, workspaceFs.config.ro),
    },
  };

  const sidecarImage = resolveSidecarImage(globalObj);
  if (sidecarImage !== undefined) {
    result.sidecarImage = sidecarImage;
  }
  if (networkResult.config !== undefined) {
    result.network = networkResult.config;
  }

  return { config: result, warnings };
}

export function loadConfig(workspacePath: string): { config: SandboxConfig; warnings: string[] } {
  const globalPath = join(homedir(), '.pi', 'sandbox.json');
  const workspaceConfigPath = join(workspacePath, 'sandbox.json');

  const globalRaw = loadRequiredConfig(globalPath);
  const { data: workspaceRaw, warnings: workspaceWarnings } =
    loadOptionalConfig(workspaceConfigPath);

  const { config: merged, warnings: mergeWarnings } = mergeConfigs(globalRaw, workspaceRaw);
  validateConfig(merged);
  return { config: merged, warnings: [...workspaceWarnings, ...mergeWarnings] };
}
