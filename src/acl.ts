import { homedir } from "node:os";
import { resolve } from "node:path";
import type { FilesystemConfig } from "./config.js";

export type AccessOperation = "read" | "write";

export interface AccessResult {
  allowed: boolean;
  reason?: string;
}

export function resolvePath(path: string, workspaceAbsolutePath: string): string {
  let expanded = path;

  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = resolve(homedir(), expanded.slice(2));
  }

  const resolved = resolve(workspaceAbsolutePath, expanded);

  if (resolved !== "/" && resolved.endsWith("/")) {
    return resolved.slice(0, -1);
  }
  return resolved;
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
        reason: `Path outside workspace: ${resolvedPath}`,
      };
    }
  }

  if (operation === "read") {
    return { allowed: true };
  }

  if (bestLevel === "ro") {
    return {
      allowed: false,
      reason: `Read-only path: ${resolvedPath}`,
    };
  }

  return { allowed: true };
}
