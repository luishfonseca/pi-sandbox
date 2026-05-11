import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import type { SandboxConfig } from "./config.js";

export function computeContainerName(workspaceAbsolutePath: string): string {
  const hash = createHash("sha256").update(workspaceAbsolutePath).digest("hex").slice(0, 16);
  return `pi-sandbox-${hash}`;
}

export function computeConfigHash(config: SandboxConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

export function getStateDir(sessionDir: string): string {
  return `${sessionDir}/.sandbox`;
}

export function acquireSessionRef(stateDir: string, sessionId: string): void {
  const sessionsDir = `${stateDir}/sessions`;
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(`${sessionsDir}/${sessionId}`, "");
}

export function releaseSessionRef(stateDir: string, sessionId: string): boolean {
  const sessionFile = `${stateDir}/sessions/${sessionId}`;
  try {
    unlinkSync(sessionFile);
  } catch {
    // Ignore if missing.
  }

  try {
    const files = readdirSync(`${stateDir}/sessions`);
    return files.length === 0;
  } catch {
    return true;
  }
}

export function readStoredConfigHash(stateDir: string): string | undefined {
  try {
    return readFileSync(`${stateDir}/config-hash`, "utf-8");
  } catch {
    return undefined;
  }
}

export function writeConfigHash(stateDir: string, configHash: string): void {
  writeFileSync(`${stateDir}/config-hash`, configHash);
}

export function deleteConfigHash(stateDir: string): void {
  try {
    unlinkSync(`${stateDir}/config-hash`);
  } catch {
    // Ignore if missing.
  }
}

export function countLeakedRefs(stateDir: string): number {
  try {
    return readdirSync(`${stateDir}/sessions`).length;
  } catch {
    return 0;
  }
}

export function resetState(stateDir: string): void {
  try {
    const sessionsDir = `${stateDir}/sessions`;
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      unlinkSync(`${sessionsDir}/${file}`);
    }
    rmdirSync(sessionsDir);
  } catch {
    // Ignore if missing.
  }
  deleteConfigHash(stateDir);
  try {
    rmdirSync(stateDir);
  } catch {
    // Ignore if not empty or missing.
  }
}
