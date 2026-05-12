import { resolve, dirname, basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { expandTilde } from "./path.js";
import type { FilesystemConfig } from "./config.js";

export type AccessOperation = "read" | "write";

export type DenialReason = "outside-workspace" | "read-only";

export interface AccessResult {
  allowed: boolean;
  reason?: DenialReason;
}

export function resolvePath(path: string, workspaceAbsolutePath: string): string {
  const expanded = expandTilde(path);
  const resolved = resolve(workspaceAbsolutePath, expanded);

  if (resolved !== "/" && resolved.endsWith("/")) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export function resolveSymlinks(path: string): string {
  try {
    return realpathSync(path, { encoding: "utf8" });
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      if (path === "/" || path === "") {
        throw err;
      }
      const parent = dirname(path);
      if (parent === path) {
        throw err;
      }
      return join(resolveSymlinks(parent), basename(path));
    }
    throw err;
  }
}

function prefixMatches(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(prefix + "/");
}

export function evaluateAccess(
  resolvedPath: string,
  operation: AccessOperation,
  filesystem: FilesystemConfig,
  workspaceAbsolutePath: string,
): AccessResult {
  let bestPrefix = "";
  let bestLevel: "ro" | "rw" | "none" = "none";

  const candidates = [
    ...filesystem.rw.map((prefix) => ({ prefix, level: "rw" as const })),
    ...filesystem.ro.map((prefix) => ({ prefix, level: "ro" as const })),
  ];

  for (const { prefix, level } of candidates) {
    if (prefixMatches(resolvedPath, prefix)) {
      if (prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
        bestLevel = level;
      } else if (prefix.length === bestPrefix.length && level === "ro") {
        bestLevel = "ro";
      }
    }
  }

  if (bestLevel === "none") {
    const insideWorkspace =
      resolvedPath === workspaceAbsolutePath ||
      resolvedPath.startsWith(workspaceAbsolutePath + "/");

    if (insideWorkspace) {
      bestLevel = "rw";
    } else {
      return {
        allowed: false,
        reason: "outside-workspace",
      };
    }
  }

  if (operation === "read") {
    return { allowed: true };
  }

  if (bestLevel === "ro") {
    return {
      allowed: false,
      reason: "read-only",
    };
  }

  return { allowed: true };
}
