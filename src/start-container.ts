import type { SandboxConfig } from './config.js';
import {
  ensureContainer,
  ensureNetwork,
  ensureSidecarContainer,
  installNftablesRules,
  pullImage,
} from './docker.js';
import {
  computeConfigHash,
  computeNetworkName,
  computeSidecarName,
  readStoredConfigHash,
  writeConfigHash,
} from './lifecycle.js';
import { generateSingBoxConfig, hasNetworkPolicy } from './network.js';
import type { SandboxState } from './state.js';
import type Dockerode from 'dockerode';
import { writeFileSync } from 'node:fs';

const SIDECAR_IMAGE_BASE = 'ghcr.io/sagernet/sing-box';

function resolveSidecarImage(sidecarVersion: string | undefined): string {
  if (sidecarVersion === undefined) {
    throw new Error(
      'sidecarVersion is required when network policy is active but is undefined. ' +
        'Set it in sandbox-default.json, ~/.pi/sandbox.json, or workspace sandbox.json.',
    );
  }
  return `${SIDECAR_IMAGE_BASE}:${sidecarVersion}`;
}

export type StartSandboxResult =
  | { kind: 'ready'; configStaleness: boolean }
  | { kind: 'pulling'; done: Promise<{ kind: 'ready' } | { kind: 'error'; message: string }> };

export interface StartSandboxDependencies {
  docker: Dockerode;
  doesImageExistFn: (docker: Dockerode, image: string) => Promise<boolean>;
  ensureContainerFn: typeof ensureContainer;
  pullImageFn: typeof pullImage;
  ensureNetworkFn?: typeof ensureNetwork;
  ensureSidecarContainerFn?: typeof ensureSidecarContainer;
  installNftablesRulesFn?: typeof installNftablesRules;
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
  const activeNetwork = hasNetworkPolicy(cfg);

  const imagesToCheck = [cfg.image];
  if (activeNetwork) {
    imagesToCheck.push(resolveSidecarImage(cfg.sidecarVersion));
  }

  const imageExists = await Promise.all(
    imagesToCheck.map((img) => deps.doesImageExistFn(deps.docker, img)),
  );
  const allImagesExist = imageExists.every(Boolean);

  if (!allImagesExist) {
    state.pull.isPulling = true;
    state.pull.error = undefined;

    const done = (async (): Promise<{ kind: 'ready' } | { kind: 'error'; message: string }> => {
      try {
        for (const img of imagesToCheck) {
          const exists = await deps.doesImageExistFn(deps.docker, img);
          if (!exists) {
            await deps.pullImageFn(deps.docker, img);
          }
        }

        const { container: runningContainer } = await createContainers(
          deps,
          cfg,
          workspacePath,
          containerName,
          stateDir,
        );
        writeConfigHash(stateDir, configHash);
        state.container = runningContainer;
        state.pull.isPulling = false;
        return { kind: 'ready' as const };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state.pull.error = msg;
        state.pull.isPulling = false;
        return { kind: 'error' as const, message: msg };
      }
    })();

    return { kind: 'pulling', done };
  }

  const { container: runningContainer, created } = await createContainers(
    deps,
    cfg,
    workspacePath,
    containerName,
    stateDir,
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
  return { kind: 'ready', configStaleness };
}

async function createContainers(
  deps: StartSandboxDependencies,
  cfg: SandboxConfig,
  workspacePath: string,
  containerName: string,
  stateDir: string,
): Promise<{ container: Dockerode.Container; created: boolean }> {
  const activeNetwork = hasNetworkPolicy(cfg);

  if (!activeNetwork) {
    return deps.ensureContainerFn(deps.docker, cfg, workspacePath, containerName);
  }

  const sidecarName = computeSidecarName(workspacePath);
  const networkName = computeNetworkName(workspacePath);
  const sidecarImage = resolveSidecarImage(cfg.sidecarVersion);
  const configPath = `${stateDir}/sing-box-config.json`;

  const ensureNetworkFn = deps.ensureNetworkFn ?? ensureNetwork;
  const ensureSidecarFn = deps.ensureSidecarContainerFn ?? ensureSidecarContainer;

  await ensureNetworkFn(deps.docker, networkName);

  const singBoxConfig = generateSingBoxConfig(cfg.network);
  writeFileSync(configPath, JSON.stringify(singBoxConfig, null, 2));

  await ensureSidecarFn(deps.docker, sidecarImage, sidecarName, networkName, configPath);

  const installNftFn = deps.installNftablesRulesFn ?? installNftablesRules;
  await installNftFn(deps.docker, sidecarName);

  return deps.ensureContainerFn(
    deps.docker,
    cfg,
    workspacePath,
    containerName,
    `container:${sidecarName}`,
  );
}
