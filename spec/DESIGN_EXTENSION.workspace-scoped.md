# Design Extension: Workspace-Scoped Containers with Refcounting

Extends [DESIGN.md §5.2](DESIGN.md#52-container-naming), [§6.1](DESIGN.md#61-session-start), [§6.2](DESIGN.md#62-session-shutdown), and replaces extension point 8 in [§9](DESIGN.md#9-extension-points).

## 1. Overview

Containers are scoped to the workspace instead of the Pi session. All concurrent sessions in the same workspace share a single container. The container is automatically stopped and removed when the last session ends.

Session references are tracked with a directory-of-files refcount under the Pi session storage area. The effective config hash is stored alongside the refcount so the extension can detect when `sandbox.json` has changed relative to the running container.

**Scope:** This extension changes container naming, session start/shutdown lifecycle, and adds config-staleness detection. It does not change the Filesystem Guard, bind-mount rules, or `bash` execution semantics.

**Conflict resolution:** This extension wins over DESIGN.md §5.2–§6.2 wherever the two differ. The `session_shutdown` no-op in §6.2 is replaced by active cleanup.

---

## 2. Specification

### 2.1 Container Naming

```
workspaceHash   = sha256(workspaceAbsolutePath).slice(0, 16)
containerName   = pi-sandbox-{workspaceHash}
```

**Postcondition:** `containerName` is a valid Docker container name (alphanumeric plus `-` and `_`; max 64 characters).

### 2.2 State Directory

```
sessionDir = ctx.sessionManager.getSessionDir()
stateDir   = {sessionDir}/.sandbox/
```

Subdirectories:
- `{stateDir}/sessions/` — one empty file per active session, named after the session ID.
- `{stateDir}/config-hash` — the config hash of the running container (written at container creation).

**Precondition:** The extension may create `stateDir` and its subdirectories recursively.

This directory is read by `/sandbox-status` to report session counts and the running container's config hash.

### 2.3 Config Hash

```
configHash = sha256(JSON.stringify(mergedConfig)).slice(0, 16)
```

The hash covers the effective merged config (§3.3). It is computed during session start and compared against the stored hash when reusing a container.

### 2.4 Session Start

**Precondition:** Docker daemon is reachable.  
**Postcondition:** The sandbox container is running (or image pull is in progress), and the current session is registered as a user of that container.

```
1. Resolve workspaceAbsolutePath ← fs.realpathSync(ctx.cwd).
2. Compute containerName (§2.1) and configHash (§2.3).
3. Compute stateDir from ctx.sessionManager.getSessionDir() (§2.2).
4. Acquire session reference:
   mkdirSync(`${stateDir}/sessions/`, { recursive: true })
   writeFileSync(`${stateDir}/sessions/{sessionId}`, "")
5. Check if the Docker image exists locally.
   If missing: start async pull (same as DESIGN.md §6.1 step 6).
6. If the image exists, ensure the container is running:
   - If a container with containerName exists and is running:
     * Read `${stateDir}/config-hash`. If it differs from configHash,
       emit a warning via ctx.ui.notify:
       "Sandbox config has changed. Run /sandbox-reset to recreate."
     * Reuse the container.
   - If it exists but is stopped, start it.
   - If it does not exist, create and start it via dockerode
     (same HostConfig/Env/WorkingDir as DESIGN.md §6.1).
     After start(), write configHash to `${stateDir}/config-hash`.
7. Mark session ready.
```

**Race safety:** Two sessions starting concurrently in the same workspace both write their reference file before any container operation. If both attempt `docker.createContainer` with the same name, Docker rejects the second with a name-conflict error; the second session falls back to `container.start()` or reuse.

### 2.5 Session Shutdown

**Triggered by:** `session_shutdown` event.  
**Postcondition:** The session's reference file is removed. If no references remain, the container is stopped and removed.

```
1. Compute stateDir from ctx.sessionManager.getSessionDir() (§2.2).
2. Delete the session reference file:
   `${stateDir}/sessions/{sessionId}`
3. Read the directory `${stateDir}/sessions/`.
4. If the directory is empty (length === 0):
   - Stop the container named containerName.
   - Remove the container named containerName.
   - Delete `${stateDir}/config-hash`.
5. If the directory is not empty, leave the container running.
```

**Crash safety:** If a session crashes without emitting `session_shutdown`, its reference file leaks. The container will never be automatically cleaned up for that workspace. This is accepted for v1; the user can run `/sandbox-reset` to force removal.

### 2.6 Config Staleness Detection

When reusing a running container (§2.4 step 6), the extension compares the stored config hash with the current effective config hash.

- **Match:** No action.
- **Mismatch:** Emit a warning notification. Do **not** stop or recreate the container automatically. Recreation is triggered by the `/sandbox-reset` command (§2.7).

The staleness state is reported by `/sandbox-status`.

> **Rationale:** Automatic recreation would race with other active sessions. A manual command lets the user decide when to interrupt running work.

### 2.7 `/sandbox-reset` Command

**Registered as:** `pi.registerCommand("sandbox-reset", { ... })`  
**Description:** Force-stop and remove the workspace sandbox container, clearing all refcount state. Users may run `/sandbox-status` before `/sandbox-reset` to inspect the current container, refcount, and config state.

**Handler behavior:**

```
1. Compute containerName from workspaceAbsolutePath (§2.1).
2. Compute stateDir from ctx.sessionManager.getSessionDir() (§2.2).
3. Count stale reference files:
   stale = readdirSync(`${stateDir}/sessions/`).length
4. Stop and remove the container named containerName (force: true).
5. Delete `${stateDir}/config-hash`.
6. Delete all files in `${stateDir}/sessions/`.
7. Re-acquire a session reference for the current session.
8. Recreate and start the sandbox container with the current config.
9. Write the current config hash to `${stateDir}/config-hash`.
10. Notify the user:
    "Reset sandbox container. Removed {stale} stale session reference(s)."
```

**Error conditions:**
- Container does not exist or is already removed → continue, do not fail.
- `stateDir` does not exist → nothing to reset; notify "No sandbox state found."
- Docker daemon unreachable → throw / surface error to user.
- Container recreation fails → notify a warning, but the reset itself does not fail.

**Postcondition:**
- The previous container (if any) has been stopped and removed.
- All refcount state (`${stateDir}/sessions/*` and `${stateDir}/config-hash`) has been deleted.
- A fresh container is created and started **inline** during the command handler (not deferred to a future session start).
- The current session holds an active reference file in the recreated state directory.
- The current config hash is written to `${stateDir}/config-hash`.
- If the effective config is unavailable because `session_start` has not yet run in this extension instance, state is cleared but no container is recreated.

---

## 3. Examples

### 3.1 Single session lifecycle

```
Session A starts in /home/user/project
  containerName = pi-sandbox-a1b2c3d4e5f67890
  Writes {sessionDir}/.sandbox/sessions/{sessionId-A}
  Creates and starts container; writes config-hash.
Session A ends
  Deletes reference file.
  Sessions dir is empty → stops and removes container.
```

### 3.2 Concurrent sessions in same workspace

```
Session A starts
  Creates reference file A.
  Creates container.
Session B starts (same workspace)
  Creates reference file B.
  Container already running → reuses it.
Session A ends
  Deletes reference file A.
  Sessions dir still has B → leaves container running.
Session B ends
  Deletes reference file B.
  Sessions dir empty → stops and removes container.
```

### 3.3 Config staleness warning

```
Session A starts with config C1
  Creates container, writes hash(C1) to config-hash.
User edits sandbox.json → config C2
Session B starts (same workspace)
  Container already running.
  Reads stored config-hash: hash(C1).
  Current configHash: hash(C2).
  Mismatch → emits warning:
    "Sandbox config has changed. Run /sandbox-reset to recreate."
  Reuses the container anyway.
```

---

## 4. Non-Goals and Forbidden Patterns

- **Do not** embed `configHash` in the container name. One workspace = one container name.
- **Do not** implement idle timeout or automatic container expiration. Cleanup is strictly reference-counted.
- **Do not** stop containers on config mismatch. Warn only.
- **Do not** garbage-collect stale containers automatically. Manual `/sandbox-reset` is the escape hatch for v1.
- **Do not** share containers across different workspaces, even if the workspace paths are symlink aliases.
- **Do not** migrate running processes or state from an old container to a new one on config change.
- **Do not** read or write the refcount state when `--no-sandbox` is active.

---

## 5. Security Properties Update

| Property | Before | After |
|---|---|---|
| Filesystem hygiene | Persistent container; manual cleanup | Shared across sessions in same workspace; automatic cleanup when last session ends |
| Container sprawl | One per session | One per workspace |

---

## 6. Integration

Replace DESIGN.md §5.2 with §2.1 above.  
Replace DESIGN.md §6.1 with §2.4 above.  
Replace DESIGN.md §6.2 with §2.5 above.  
Replace extension point 8 in DESIGN.md §9 with:

> **8. `/sandbox-reset` command.** A registered command that force-stops and removes the workspace sandbox container, clearing all refcount state, and recreates a fresh container for the current session. It is also used to recover from stale reference files after a crash. Specified in [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.7.

Update DESIGN.md §7 "Filesystem hygiene" row with the "After" column from §5 above.
