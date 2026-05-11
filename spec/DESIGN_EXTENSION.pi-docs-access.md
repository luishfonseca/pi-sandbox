# Design Extension: Pi Package Directory Auto-Allow

Extends [DESIGN.md §6.1](DESIGN.md#61-session-start). Adds a config augmentation step before the delegation to `DESIGN_EXTENSION.workspace-scoped.md`.

## 1. Overview

The sandbox blocks all host paths outside the workspace by default. Pi's system prompt embeds absolute paths to its own documentation (e.g. `/nix/store/…/pi-monorepo/README.md`). When the model attempts to `read` these paths, the Filesystem Guard blocks them.

This extension closes that gap by reading `PI_PACKAGE_DIR` from the environment and injecting it into the effective config as an additional read-only prefix. Because it is injected into the same `filesystem.ro` list that drives both the Guard and the container mount builder, the normal pi-sandbox resolution rules apply unchanged.

**Scope:** This extension affects only the in-memory merged `SandboxConfig`. It does **not** rewrite the system prompt, remap paths, proxy `read`/`write`/`edit` into the container, or modify any config file on disk.

**Conflict resolution:** If the pi package directory is already present in the merged config (global or workspace `ro`), the auto-allow is idempotent.

> **Known issue:** Workspace explicit rules may make the directory `rw`; however, because the auto-allow appends a same-length `ro` prefix, DESIGN.md §4.3 tie-breaking yields `ro` (most restrictive). An explicit workspace `rw` for the entire pi directory is therefore silently overridden. See §2.2 and §3.3.

---

## 2. Specification

### 2.1 Config Augmentation

After `loadConfig()` returns the merged `SandboxConfig` and before any ACL evaluation or container creation:

1. Let `piDir = process.env.PI_PACKAGE_DIR`.
2. If `piDir` is `undefined`, empty, or contains only whitespace:
   a. If `--no-sandbox` is **not** active, present a warning notification via `ctx.ui.notify(message, "warning")` where `message` is `PI_PACKAGE_DIR is not set; the model will not be able to read pi documentation inside the sandbox.`
   b. Proceed unchanged.
3. If `piDir` is already present in `config.filesystem.ro` (exact string match), proceed unchanged.
4. Append `piDir` to `config.filesystem.ro`.

**No path resolution.** The value is used verbatim. No tilde expansion, relative-path resolution, or symlink following is performed.

**Postconditions:**
- The Guard evaluates `read` calls to pi documentation paths via the normal `evaluateAccess()` logic, because `piDir` is present in the same `filesystem.ro` list as user-configured prefixes.
- The container mount builder bind-mounts `piDir` read-only into the container via the normal `buildBindMounts()` logic.

**Invariant:** The augmentation is never written to disk. It is a runtime-only modification of the in-memory merged config.

The augmentation status (whether `PI_PACKAGE_DIR` was present and appended) is visible in `/sandbox-status`.

### 2.2 Interaction with Other Rules

Because `piDir` is appended as a flat prefix alongside all other configured prefixes, existing rules behave as follows:

| Existing config | Effective config | Result for pi docs |
|---|---|---|
| None | `ro: [piDir]` | `read` → ALLOW, `write`/`edit` → BLOCK (read-only path) |
| `ro: [piDir]` | `ro: [piDir, piDir]` | Idempotent; same as above |
| `rw: [piDir]` | `rw: [piDir], ro: [piDir]` | Specificity tie (`rw` == `ro` length); ties break to `ro`. `write` → BLOCK. |
| `rw: ["${piDir}/docs"]` | `rw: ["${piDir}/docs"], ro: [piDir]` | `docs/` is longer → `rw`. `README.md` is `ro`. |

---

## 3. Examples

### 3.1 Happy Path — Model reads pi documentation

```
Environment: PI_PACKAGE_DIR=/nix/store/…/pi-monorepo

Session start:
  config.filesystem.ro becomes ["/nix/store/…/pi-monorepo"]

Model input:  read("/nix/store/…/pi-monorepo/docs/extensions.md")
Guard ACL:    ALLOW (matches ro prefix, normal §4.3 rules)
Container:    /nix/store/…/pi-monorepo bind-mounted ro at same path
Result:       Native read executes; file returned to model.
```

### 3.2 Variable Not Set — Warning Emitted

```
Environment: PI_PACKAGE_DIR is unset

Session start:
  config unchanged
  Warning notification presented via `ctx.ui.notify`: PI_PACKAGE_DIR is not set; the model will not be able to read pi documentation inside the sandbox.

Model input:  read("/nix/store/…/pi-monorepo/README.md")
Guard ACL:    BLOCK — reason: "Path outside workspace: /nix/store/…/pi-monorepo/README.md"
Result:       Same behavior as without this extension, but the user is informed why.
```

### 3.3 Workspace Explicitly Overrides to RW

```
Environment: PI_PACKAGE_DIR=/nix/store/…/pi-monorepo
Workspace sandbox.json:
  { "filesystem": { "rw": ["/nix/store/…/pi-monorepo"] } }

Merged config before augmentation:
  ro: [], rw: ["/nix/store/…/pi-monorepo"]

After augmentation:
  ro: ["/nix/store/…/pi-monorepo"], rw: ["/nix/store/…/pi-monorepo"]

Model input:  write("/nix/store/…/pi-monorepo/hacked.txt", "...")
Guard ACL:    rw prefix is same length as ro prefix; specificity tie.
              DESIGN.md §4.3: ties break to most restrictive (ro > rw).
              BLOCK — reason: "Read-only path: /nix/store/…/pi-monorepo/hacked.txt"
```

> **Note:** The above example demonstrates that auto-appending `ro` does not silently weaken an explicit `rw`. The tie-break rule preserves the safer default. To truly make the pi directory writable, the workspace must use a longer prefix (e.g. `rw: ["/nix/store/…/pi-monorepo/docs"]`).

---

## 4. Non-Goals and Forbidden Patterns

- **Do not** rewrite, translate, or remap paths in the system prompt or tool arguments.
- **Do not** proxy `read`/`write`/`edit` into the container.
- **Do not** cache the discovered directory across sessions; re-evaluate on every `session_start`.
- **Do not** expose the discovered path to the model via UI notifications or custom messages.
- **Do not** attempt to resolve the directory via `import.meta.url`, `process.argv`, `@mariozechner/pi-coding-agent` module resolution, filesystem heuristics, or tilde expansion; `PI_PACKAGE_DIR` is the single source of truth and is used verbatim.
- **Do not** append the directory if `--no-sandbox` is active; the extension is already transparent in that mode.
- **Do not** bypass the normal ACL evaluation or mount-building logic for pi paths; pi paths must be evaluated by the same `evaluateAccess()` and `buildBindMounts()` code paths as user-configured prefixes.

---

## 5. Security Properties Update

| Property | Before | After |
|---|---|---|
| Model access to pi docs inside sandbox | BLOCKED (outside workspace) | ALLOWED read-only (when `PI_PACKAGE_DIR` is set) |
| Write access to pi docs | N/A (blocked by Guard) | Still BLOCKED (ro prefix, normal rules) |
| Path remapping risk | N/A | None — absolute paths used verbatim, normal rules apply |

---

## 6. Integration

Add the config augmentation step to DESIGN.md §6.1 before the delegation to [DESIGN_EXTENSION.workspace-scoped.md](DESIGN_EXTENSION.workspace-scoped.md). No other sections are modified.
