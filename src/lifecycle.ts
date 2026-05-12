import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { isNodeError } from "./acl.js";
import type { SandboxConfig } from "./config.js";

export function computeContainerName(workspaceAbsolutePath: string): string {
  const hash = createHash("sha256").update(workspaceAbsolutePath).digest("hex").slice(0, 16);
  return `pi-sandbox-${hash}`;
}

export function computeSidecarName(workspaceAbsolutePath: string): string {
  return `${computeContainerName(workspaceAbsolutePath)}-egress`;
}

export function computeNetworkName(workspaceAbsolutePath: string): string {
  return `${computeContainerName(workspaceAbsolutePath)}-net`;
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

function swallowEnoent(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      throw err;
    }
  }
}

export function releaseSessionRef(stateDir: string, sessionId: string): boolean {
  const sessionFile = `${stateDir}/sessions/${sessionId}`;
  swallowEnoent(() => { unlinkSync(sessionFile); });

  try {
    const files = readdirSync(`${stateDir}/sessions`);
    return files.length === 0;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

export function readStoredConfigHash(stateDir: string): string | undefined {
  try {
    return readFileSync(`${stateDir}/config-hash`, "utf-8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export function writeConfigHash(stateDir: string, configHash: string): void {
  writeFileSync(`${stateDir}/config-hash`, configHash);
}

export function deleteConfigHash(stateDir: string): void {
  swallowEnoent(() => { unlinkSync(`${stateDir}/config-hash`); });
}

export function countStaleRefs(stateDir: string): number {
  try {
    return readdirSync(`${stateDir}/sessions`).length;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return 0;
    }
    throw err;
  }
}

export function resetState(stateDir: string): void {
  swallowEnoent(() => {
    const sessionsDir = `${stateDir}/sessions`;
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      unlinkSync(`${sessionsDir}/${file}`);
    }
    rmdirSync(sessionsDir);
  });
  deleteConfigHash(stateDir);
  try {
    rmdirSync(stateDir);
  } catch (err) {
    if (
      !(
        isNodeError(err) &&
        (err.code === "ENOENT" || err.code === "ENOTEMPTY")
      )
    ) {
      throw err;
    }
  }
}
