import type Dockerode from "dockerode";
import type { SandboxState } from "./state.js";
import type { SandboxConfig } from "./config.js";
import {
  computeConfigHash,
  readStoredConfigHash,
  writeConfigHash,
} from "./lifecycle.js";
import { ensureContainer, pullImage } from "./docker.js";

export type StartSandboxResult =
  | { kind: "ready"; configStaleness: boolean }
  | { kind: "pulling"; done: Promise<{ kind: "ready" } | { kind: "error"; message: string }> };

export interface StartSandboxDependencies {
  docker: Dockerode;
  doesImageExistFn: (docker: Dockerode, image: string) => Promise<boolean>;
  ensureContainerFn: typeof ensureContainer;
  pullImageFn: typeof pullImage;
}

export async function startSandboxContainer(
  state: SandboxState,
  deps: StartSandboxDependencies,
  cfg: SandboxConfig,
  workspacePath: string,
  containerName: string,
  stateDir: string,
): Promise<StartSandboxResult> {
  const configHash = computeConfigHash(cfg);

  const imageExists = await deps.doesImageExistFn(deps.docker, cfg.image);
  if (!imageExists) {
    state.pull.isPulling = true;
    state.pull.error = undefined;

    const done = deps
      .pullImageFn(deps.docker, cfg.image)
      .then(async () => {
        const { container: runningContainer } = await deps.ensureContainerFn(
          deps.docker,
          cfg,
          workspacePath,
          containerName,
        );
        writeConfigHash(stateDir, configHash);
        state.container = runningContainer;
        state.pull.isPulling = false;
        return { kind: "ready" as const };
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        state.pull.error = msg;
        state.pull.isPulling = false;
        return { kind: "error" as const, message: msg };
      });

    return { kind: "pulling", done };
  }

  const { container: runningContainer, created } = await deps.ensureContainerFn(
    deps.docker,
    cfg,
    workspacePath,
    containerName,
  );

  let configStaleness = false;
  if (created) {
    writeConfigHash(stateDir, configHash);
  } else {
    const storedHash = readStoredConfigHash(stateDir);
    if (storedHash === undefined) {
      writeConfigHash(stateDir, configHash);
    }
    configStaleness = storedHash !== undefined && storedHash !== configHash;
  }

  state.container = runningContainer;
  return { kind: "ready", configStaleness };
}
