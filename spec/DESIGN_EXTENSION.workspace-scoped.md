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

**Precondition:** None. The handler runs even if Docker is unreachable.  
**Postcondition:** The workspace path and effective configuration are resolved. The extension is ready to intercept tool calls.

```
1. Resolve workspaceAbsolutePath ← fs.realpathSync(ctx.cwd).
2. Compute stateDir from ctx.sessionManager.getSessionDir() (§2.2).
3. Load and validate the merged config.
```

**Note:** `session_start` does not create the container, start the container, or acquire a session reference. Those actions happen on the first `bash` tool call (§2.4.1).

#### 2.4.1 Lazy Connection

The first `bash` tool call in any session triggers connection to the workspace-scoped container. The extension serializes container operations per workspace.

**Connection rules:**
- If the container already exists and is running, it is reused.
- If the container exists but is stopped, it is started.
- If the container does not exist, it is created and started.
- After creation, the current config hash is written to `${stateDir}/config-hash`.

**Session reference.** The session reference file is written on the first `bash` tool call, making the session a refcounted container user. `session_start` never touches refcount state.

**Image pull.** If the configured image is not present locally:
1. An asynchronous pull begins.
2. The `bash` call that triggered the pull receives an error result indicating the pull is in progress.
3. Subsequent `bash` calls made while the pull is active receive the same in-progress error.
4. When the pull completes, the container is created automatically.
5. If the pull fails, the failure message is retained. Subsequent `bash` calls receive an error result containing that message until `/sandbox-reset` is run.

**Config staleness.** When reusing an existing container, the extension compares the stored config hash with the current effective hash.
- **Match:** No action.
- **Mismatch:** A warning notification is emitted. The container is **not** recreated automatically. See §2.6.

**Race safety.** If two sessions in the same workspace both trigger connection concurrently, one succeeds in creating or starting the container; the other sees the healthy container and reuses it.

### 2.5 Session Shutdown

**Triggered by:** `session_shutdown` event.  
**Postcondition:** The session's reference file is removed (if it exists). If no references remain, the container is stopped and removed.

**Precondition guard:** If `session_start` did not run in this extension instance, the handler returns immediately.

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

**Idempotency:** Deleting a missing reference file is a no-op.

**Crash safety:** If a session crashes without emitting `session_shutdown`, its reference file leaks. The container will never be automatically cleaned up for that workspace. This is accepted for v1; the user can run `/sandbox-reset` to force removal.

### 2.6 Config Staleness Detection

When a `bash` call triggers lazy connection and reuses an existing container, `startSandboxContainer` compares the stored config hash with the current effective config hash.

- **Match:** No action.
- **Mismatch:** Emit a warning notification. Do **not** stop or recreate the container automatically. Recreation is triggered by the `/sandbox-reset` command (§2.7).

The staleness state is reported by `/sandbox-status`.

> **Rationale:** Automatic recreation would race with other active sessions. A manual command lets the user decide when to interrupt running work.

### 2.7 `/sandbox-reset` Command

**Registered as:** `pi.registerCommand("sandbox-reset", { ... })`  
**Description:** Force-stop and remove the workspace sandbox container, clearing all refcount state. Users may run `/sandbox-status` before `/sandbox-reset` to inspect the current container, refcount, and config state. The container is recreated lazily on the next `bash` tool call, not inline during the reset command.

**Handler behavior:**

```
1. Compute containerName from workspaceAbsolutePath (§2.1).
2. Compute stateDir from ctx.sessionManager.getSessionDir() (§2.2).
3. Count stale reference files:
   stale = readdirSync(`${stateDir}/sessions/`).length
4. Stop and remove the container named containerName (force: true).
5. Clear in-memory container reference and pull state.
6. Delete `${stateDir}/config-hash`.
7. Delete all files in `${stateDir}/sessions/`.
8. Notify the user:
    "Reset sandbox container. Removed {stale} stale session reference(s)."
```

**Error conditions:**
- Container does not exist or is already removed → continue, do not fail.
- `stateDir` does not exist → nothing to reset; notify "No sandbox state found."
- Docker daemon unreachable → throw / surface error to user.

**Postcondition:**
- The previous container (if any) has been stopped and removed.
- All refcount state (`${stateDir}/sessions/*` and `${stateDir}/config-hash`) has been deleted.
- A fresh container will be created lazily on the next `bash` tool call from any session in this workspace.
- If the effective config is unavailable because `session_start` has not yet run in this extension instance, state is cleared but no container is recreated.

---

## 3. Examples

### 3.1 Single session lifecycle

```
Session A starts in /home/user/project
  containerName = pi-sandbox-a1b2c3d4e5f67890
  Loads config; warns if stored config-hash is stale.
Session A calls bash
  Acquires session reference.
  Container does not exist → creates and starts it; writes config-hash.
Session A ends
  Deletes reference file.
  Sessions dir is empty → stops and removes container.
```

### 3.2 Concurrent sessions in same workspace

```
Session A starts
  Loads config.
Session B starts (same workspace)
  Loads config.
Session A calls bash
  Acquires reference file A.
  Container does not exist → creates and starts it; writes config-hash.
Session B calls bash
  Acquires reference file B.
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
  Loads config.
Session A calls bash
  Creates container, writes hash(C1) to config-hash.
User edits sandbox.json → config C2
Session B starts (same workspace)
  Loads config C2.
  Reads stored config-hash: hash(C1).
  Current configHash: hash(C2).
  Mismatch → emits warning:
    "Sandbox config has changed. Run /sandbox-reset to recreate."
Session B calls bash
  Container already running → reuses it.
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

> **8. `/sandbox-reset` command.** A registered command that force-stops and removes the workspace sandbox container, clearing all refcount state. The container is recreated lazily on the next `bash` tool call. It is also used to recover from stale reference files after a crash. Specified in [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.7.

Update DESIGN.md §7 "Filesystem hygiene" row with the "After" column from §5 above.
