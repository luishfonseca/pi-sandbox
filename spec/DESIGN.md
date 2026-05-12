# pi-sandbox Design Document

## 1. Overview

pi-sandbox is a Pi extension that intercepts `bash`, `read`, `write`, and `edit` tool calls and routes them through two coordinated enforcement layers:

1. **Filesystem Guard** — Intercepts `read`/`write`/`edit` on the host, evaluates every path against an ACL, and blocks disallowed calls before they execute.
2. **Containerized Bash** — Overrides `bash` to execute inside a Docker container. The container sees only the workspace and explicitly allowed paths. Network access is disabled by default.

Both layers are driven by a single policy declared in `sandbox.json` in the workspace root.

The extension registers a `--no-sandbox` CLI flag. When this flag is set, the extension becomes transparent: it does not start a container, does not enforce filesystem ACLs, and delegates `bash` calls to the built-in native `bash` tool. From the user's perspective, the extension is indistinguishable from not being installed.

**Critical path:** The system must ensure a sandbox container is running for the current workspace, enforce the declared ACL on every intercepted tool call, and share the container across sessions in the same workspace. The container is stopped and removed when the last session ends. Everything else is an extension point.

---

## 2. Non-Goals and Negative Constraints

The system MUST NOT:

- Modify system prompts, model behavior, or conversation context. The LLM sees the same paths as on the host; no `/workspace` translation is performed.
- Protect secrets that are already inside the workspace (e.g., `.env` files). The LLM may read any file the ACL permits.
- Encrypt, scan, or introspect file contents. Enforcement is purely path-based.
- Run as root or modify Docker daemon configuration. It is a client of the existing Docker socket.
- Support Windows natively. The implementation MAY assume a POSIX host.
- Rewrite or proxy `read`/`write`/`edit` into the container. These tools execute on the host filesystem after ACL checks.
- Cache or log intercepted tool calls beyond the current session.
- Implement devcontainer semantics. pi-sandbox does not read `devcontainer.json`.
- Modify host-level iptables, nftables, or routing rules.
- Execute `bash` tool calls on the host filesystem when sandbox mode is active.
- Translate, rewrite, or remap paths between host and container representations for `read`/`write`/`edit`.
- Automatically restart failed containers or implement a background health-check polling loop.
- Implement an egress sidecar, DNS proxy, or IP-layer filtering. Network isolation uses `--network none` in v1.

---

## 3. Configuration

### 3.1 Source of Truth

The extension reads two files and merges them into a single effective configuration:

1. **Global config:** `~/.pi/sandbox.json` (required). If the file is missing or invalid JSON, session start MUST fail with an explicit error.
2. **Workspace config:** `sandbox.json` in the workspace root (`process.cwd()` at session start). If missing or invalid JSON, treated as `{}` with a warning.

The merged configuration follows the schema in §3.2.

### 3.2 Schema

```typescript
interface SandboxConfig {
  image: string;              // Docker image for the sandbox container. REQUIRED.
  env?: Record<string, string>; // Environment variables injected into the container.
                                 // Overrides image defaults; other image env vars are preserved.
  filesystem?: {
    rw?: string[];  // Path prefixes allowed read-write for tool calls and bind-mounted rw
    ro?: string[];  // Path prefixes allowed read-only for tool calls and bind-mounted ro
  };
}
```

**Validation rules:**
- `image` MUST be present and a non-empty string in the merged config.
- All `filesystem` prefixes MUST be absolute paths, contain no `*`, `?`, or `..`, and not end with `/` (except root `/`).
- Unknown keys MUST be ignored with a warning.

**No hardcoded defaults.** If `rw` or `ro` is absent after merging, it is empty (`[]`).

### 3.3 Config Merge Rules

The global config and workspace config share the schema in §3.2. They are merged field-by-field with the following rules:

- **Scalars (`image`)** — the workspace value wins if present; otherwise the global value is used.
- **Records (`env`)** — merge the two objects. Workspace keys override global keys. If a workspace key has an empty string value (`""`), the environment variable is removed from the effective config even if it was present globally.
- **Lists (`filesystem.rw` and `filesystem.ro`)** — append workspace entries to global entries. If the workspace list begins with an empty string (`""`), discard the global list entirely and keep only the workspace entries that follow the empty string.
- **Unknown keys** — ignored with a warning from each file independently.

### 3.4 CLI Flag

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--no-sandbox` | `boolean` | `false` | When `true`, the extension does not start a container, does not intercept `read`/`write`/`edit` tool calls, and delegates `bash` to the native built-in tool. |

**Behavior:**
- `session_start` handler returns immediately; no container is created.
- `tool_call` handler returns `undefined` immediately; no ACL checks run.
- `bash` tool delegates to `createBashTool(localCwd).execute(...)`.

This makes the extension fully transparent and indistinguishable from an unloaded state.

---

## 4. Filesystem Guard

### 4.1 Tool Interception Contract

**Preconditions for every intercepted call:**
1. The extension is loaded and the session is active.
2. The tool name is `read`, `write`, or `edit`.
3. The tool arguments include a `path` string.

**Postconditions:**
- If allowed: the native tool executes normally and its result is returned unmodified. Native tool errors are forwarded unmodified.
- If blocked: the tool does not execute. The extension returns `{ block: true, reason: string }`.

**Error condition:** If `path` is not a string, return `{ block: true, reason: "Missing or invalid path argument" }`.

**Invariant:** The `edit` tool is evaluated as `write` for ACL purposes.

### 4.2 Path Resolution

**Precondition:** `path` is a string.

**Transformation:**
1. Expand `~` to `os.homedir()`. `~username` is unsupported and treated as a literal path segment.
2. Resolve relative paths against `workspaceAbsolutePath` (captured at session start).
3. Normalize with `path.resolve`.
4. Strip trailing `/` except for root `/`.

**Postcondition:** `resolvedPath` is an absolute string with no trailing `/` (except root `/`).

**Symlink traversal.** See [DESIGN_EXTENSION.symlinks.md](DESIGN_EXTENSION.symlinks.md).

**UNDERSPECIFIED: macOS case sensitivity.** Path comparison is case-sensitive on all platforms for v1.

### 4.3 Rule Evaluation

For a given resolved absolute path and operation (`read` or `write`):

1. **Collect matching prefixes.** A prefix matches if the path equals the prefix or is nested under it (`prefix === '/' || path === prefix || path.startsWith(prefix + '/')`).

2. **Map matching prefixes to effective levels.**
   - `ro` → `ro`
   - `rw` → `rw`

3. **Determine the effective access level.** The longest matching prefix wins. Ties break to the most restrictive (`ro` > `rw`).

4. **Enforce.**
   - `read` requires `ro` or `rw`.
   - `write` (including `edit`) requires `rw`.

5. **Default fallback.** If no rule matches:
   - Path is inside workspace → `rw`.
   - Path is outside workspace → `none`.

### 4.4 Block Response Format

```json
{
  "block": true,
  "reason": "Path outside workspace: /etc/shadow"
}
```

Reason prefixes:
- `"Path outside workspace: {path}"` — default fallback outside workspace
- `"Read-only path: {path}"` — effective level `ro` on write/edit
- `"Missing or invalid path argument"`

### 4.5 Examples

**Example 1 — Workspace read (happy path):**
```
Input:   read("./src/main.ts")
Workspace: /home/user/projects/myapp
Resolved: /home/user/projects/myapp/src/main.ts
Result:  ALLOW
```

**Example 2 — Blocked by default:**
```
Input:   read("/etc/shadow")
Result:  BLOCK — reason: "Path outside workspace: /etc/shadow"
```

**Example 3 — Specificity override:**
Config:
```json
{ "filesystem": { "ro": ["/etc"], "rw": ["/etc/ssl/certs"] } }
```
```
Input:   read("/etc/ssl/certs/ca.crt")
Result:  ALLOW   (rw is longer than ro)
Input:   write("/etc/ssl/certs/ca.crt", "...")
Result:  ALLOW   (rw is longer than ro)
Input:   write("/etc/passwd", "...")
Result:  BLOCK — reason: "Read-only path: /etc/passwd"
```

**Example 4 — Edit treated as write:**
```
Input:   edit("/etc/passwd", { edits: [...] })
Result:  BLOCK — reason: "Path outside workspace: /etc/passwd"
```

---

## 5. Containerized Bash

### 5.1 Bash Tool Contract

The full behavioral specification for the overridden `bash` tool — including the tool override contract, parameter schema, fallback semantics, execution semantics (timeout, cancellation, real-time streaming), error conditions, output truncation, and examples — is specified in [DESIGN_EXTENSION.bash-contract.md](DESIGN_EXTENSION.bash-contract.md).

### 5.2 Container Naming

The container name is derived from the workspace path so that all sessions in the same workspace share one container. See [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.1 for the naming scheme and §2.4 for lifecycle details.



### 5.3 Container Filesystem

The container is created with bind mounts derived from the `filesystem` config plus the workspace.

**Mount rules:**
- Workspace directory → bind-mounted read-write at `workspaceAbsolutePath`.
- Every `ro` prefix → bind-mounted read-only.
- Every `rw` prefix → bind-mounted read-write.
- No other host paths are visible.

**Negative constraints:**
- Missing mount sources: if an `ro` or `rw` path does not exist, the extension creates an empty directory at that path before `docker.createContainer`.

---

## 6. Container Lifecycle

### 6.1 Session Start

**Precondition:** Docker daemon is reachable.  
**Postcondition:** The sandbox container is running (or image pull is in progress), and the current session is registered as a user of the workspace-scoped container.

**Config augmentation.** Before the container is created, the merged `filesystem` configuration MAY be augmented at runtime with the Pi package directory so that the model can read pi documentation paths referenced in the system prompt. See [DESIGN_EXTENSION.pi-docs-access.md](DESIGN_EXTENSION.pi-docs-access.md).

The full session start algorithm — including container naming, refcount acquisition, config hash computation, and staleness detection — is specified in [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.

### 6.2 Session Shutdown

**Triggered by:** `session_shutdown` event.  
**Postcondition:** The session's reference file is removed. If no references remain, the container is stopped and removed.

See [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.5 for the shutdown algorithm and §2.7 for the `/sandbox-reset` recovery command.

---

## 7. Security Properties

| Property | Mechanism | Guarantee |
|---|---|---|
| Workspace isolation | Filesystem Guard + bind mounts | Host files outside project are blocked for `read`/`write`/`edit` and invisible to `bash` |
| Network isolation | `HostConfig.NetworkMode: "none"` | No network access from sandbox |
| Process isolation | Docker container | Host PID namespace not shared |
| Privilege dropping | `HostConfig.CapDrop: ["ALL"]`, `HostConfig.SecurityOpt: ["no-new-privileges:true"]` | Container cannot escalate privileges |
| Filesystem hygiene | Workspace-scoped container with refcount | Shared across sessions in same workspace; automatic cleanup when last session ends |
| Syscall filtering | Docker default seccomp profile | ~50 dangerous syscalls blocked by default |

**Known limitations (accepted for v1):**
- Symlinks are not resolved before ACL checks. A symlink to `/etc/shadow` inside the workspace is treated as a workspace path. See [DESIGN_EXTENSION.symlinks.md](DESIGN_EXTENSION.symlinks.md) for the resolution extension.
- Network is fully disabled (`HostConfig.NetworkMode: "none"`). There is no per-domain egress filtering.

---

## 8. /sandbox-status Command

### 8.1 Overview

The extension registers a `/sandbox-status` command that displays a read-only summary of the sandbox state for the current workspace. It aggregates information from the configuration (§3), filesystem rules (§4), container runtime (§5–§6), and security settings (§7).

### 8.2 Command Registration

**Registered as:** `pi.registerCommand("sandbox-status", { ... })`  
**Description:** Display the current sandbox state for the workspace.

### 8.3 Handler Behavior

**Precondition:** None. The command MAY be invoked at any time.  
**Postcondition:** A status report is presented to the user via `ctx.ui.notify`.

```
1. If --no-sandbox is active:
   Notify: "Sandbox status: disabled (--no-sandbox is set)."
   Return.

2. Compute workspacePath ← fs.realpathSync(ctx.cwd).
3. Compute containerName ← computeContainerName(workspacePath) (§5.2).
4. Compute stateDir ← getStateDir(ctx.sessionManager.getSessionDir()) (§6.2).
5. Load effective config:
   a. { config: loadedConfig } ← loadConfig(ctx.cwd) (§3.3).
   b. augmentConfigWithPiDir(loadedConfig) (§6.1).
6. Compute configHash ← computeConfigHash(loadedConfig)
   ([DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.3).
7. Read storedHash ← readStoredConfigHash(stateDir) if stateDir exists.
8. Query Docker for container named containerName:
   - If found and running: status = "running"
   - If found but not running: status = "stopped"
   - If not found: status = "not found"
   - If Docker unreachable: surface error.
9. Read sessionRefs ← list of filenames in `${stateDir}/sessions/` if directory exists.
10. Assemble and notify status report.
```

### 8.4 Status Report Fields

The report MUST include:

| Field | Source | Description |
|---|---|---|
| `mode` | `--no-sandbox` flag | `sandboxed` or `disabled` |
| `workspace` | `ctx.cwd` | Absolute workspace path |
| `containerName` | §5.2 | Derived container name |
| `containerStatus` | Docker inspect | `running`, `stopped`, or `not found` |
| `image` | Merged config (§3.2) | Effective Docker image |
| `configHash` | [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.3 | Current effective config hash |
| `configStaleness` | [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.6 | `current`, `stale`, or `unknown` |
| `filesystem.rw` | Merged config (§3.2) | Read-write path prefixes |
| `filesystem.ro` | Merged config (§3.2) | Read-only path prefixes |
| `sessions.active` | §6.2 | Count of active session reference files |
| `sessions.ids` | §6.2 | List of active session IDs (up to 10) |

The report MUST NOT include:
- Environment variable values (only keys, to avoid leaking secrets).
- Contents of blocked tool calls (the Guard does not retain history).

### 8.5 Examples

**Example 1 — Active sandbox:**
```
Input:  /sandbox-status
Output (notified):
  Sandbox status:
  Workspace: /home/user/project
  Container: pi-sandbox-a1b2c3d4 (running)
  Image: ubuntu:22.04
  Config hash: 7f8e9d2a (current)
  Filesystem:
    rw: /home/user/project, /tmp/shared
    ro: /nix/store/…/pi-monorepo
  Sessions: 2 active (abc123, def456)
```

**Example 2 — Stale config:**
```
Input:  /sandbox-status
Output:
  Config hash: 7f8e9d2a (stale — running container was created with a1b2c3d4)
```

**Example 3 — Disabled:**
```
Input:  /sandbox-status
Output: "Sandbox status: disabled (--no-sandbox is set)."
```

**Example 4 — No state:**
```
Input:  /sandbox-status
Output:
  Container: pi-sandbox-a1b2c3d4 (not found)
  Sessions: 0 active
  Config hash: 7f8e9d2a (unknown)
```

---

## 9. Extension Points

The following are explicitly deferred. v1 MUST compile and run without them.

1. **Egress sidecar / per-domain filtering.** Replace `HostConfig.NetworkMode: "none"` with a bridge network + sidecar.
2. **Cache persistence.** Named volumes for package managers.
3. **Symlink resolution.** Call `fs.realpathSync` before ACL evaluation. Specified in [DESIGN_EXTENSION.symlinks.md](DESIGN_EXTENSION.symlinks.md).
4. **Mask / downgrade mounts.** VFS-level enforcement of read-only restrictions inside read-write trees.
5. **Custom capabilities.** `capabilities: string[]` in config.
6. **Config reload.** Recreate container when `sandbox.json` changes and user calls /reload.
7. **`/sandbox-reset` command.** A registered command that force-stops and removes the workspace sandbox container, clearing all refcount state. This recreates the container with the latest config on the next session start. It is also used to recover from stale reference files after a crash. Specified in [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md) §2.7.

---

## 10. Related Work

- [Pi bubblewrap sandbox example](https://github.com/marioech/pi-coding-agent/tree/main/examples/extensions/sandbox)
- [Pi protected-paths example](https://github.com/marioech/pi-coding-agent/tree/main/examples/extensions/protected-paths.ts)
- [Pi permission-gate example](https://github.com/marioech/pi-coding-agent/tree/main/examples/extensions/permission-gate.ts)
- [Pi tool-override example](https://github.com/marioech/pi-coding-agent/tree/main/examples/extensions/tool-override.ts)
- [Docker Engine API](https://docs.docker.com/reference/api/engine)
- [dockerode](https://github.com/apocas/dockerode)
