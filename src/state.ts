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
  fatalError?: string;
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
 *
 * IMPORTANT: This is a single-process, in-memory lock. It is NOT used to
 * coordinate between multiple Pi sessions (which are separate processes). In
 * this project the mutex serializes container-lifecycle operations
 * (create/start/stop/remove) that touch shared mutable state
 * (`SandboxState.container`, Docker, and the on-disk refcount state). It
 * prevents races when multiple concurrent `bash` tool calls in the SAME
 * session/process both try to start the same workspace-scoped container.
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
