import type Dockerode from "dockerode";
import type { SandboxConfig } from "./config.js";

export interface SandboxState {
  workspaceAbsolutePath: string | undefined;
  container: Dockerode.Container | undefined;
  config: SandboxConfig | undefined;
  pull: {
    isPulling: boolean;
    error: string | undefined;
  };
}

export function createSandboxState(): SandboxState {
  return {
    workspaceAbsolutePath: undefined,
    container: undefined,
    config: undefined,
    pull: { isPulling: false, error: undefined },
  };
}

/**
 * Simple async mutex that serializes critical sections.
 * Even if a previous holder rejects, the queue continues.
 */
export class Mutex {
  private promise: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: (() => void) | undefined;
    const newPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.promise;
    this.promise = prev.then(() => newPromise, () => newPromise);
    await prev;
    if (release === undefined) {
      throw new Error("Mutex release callback was not initialized");
    }
    return release;
  }
}
