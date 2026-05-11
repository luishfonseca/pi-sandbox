# Design Extension: Symlink Resolution in Filesystem Guard

Extends [DESIGN.md §4.2](DESIGN.md#42-path-resolution). Replaces the `UNDERSPECIFIED: Symlink traversal` paragraph.

## 1. Overview

The Filesystem Guard resolves symlinks on the host filesystem before ACL rule evaluation. This closes the bypass where a symlink inside the workspace targets a sensitive path outside the workspace.

**Scope:** This extension affects only the Guard (`read`, `write`, `edit` interception). It does **not** change container bind mounts, container working-directory resolution, or path display in error messages.

**Conflict resolution:** If a symlink resolves to a path that is blocked by the ACL, the call is blocked with the resolved path in the reason string. The symlink source path is never disclosed in block reasons.

---

## 2. Specification

### 2.1 Precondition

`path` is a string after tilde expansion and relative-to-absolute conversion per DESIGN.md §4.2 steps 1–2.

### 2.2 Postcondition

`resolvedPath` is the canonical absolute path with all symlinks in existing parent components resolved. It contains no trailing `/` except root `/`.

### 2.3 Algorithm

Define `resolve(path: string): string` as:

1. Attempt `fs.realpathSync(path, { encoding: 'utf8' })`.
2. On success, return the result.
3. On `ENOENT`:
   - If `path` is `/` or has no parent, throw the original `ENOENT`.
   - Let `parent = path.dirname(path)`.
   - Return `path.join(resolve(parent), path.basename(path))`.
4. On any other error (`EACCES`, `ENOTDIR`, `ELOOP`, etc.), throw immediately.

**Invariant:** `resolve` never returns a path containing a symlink in any existing directory component.

**Precondition (tool-specific):**
- `read` and `edit` target an existing file or directory. If `resolve` encounters `ENOENT` at the leaf, the symlink is broken and falls back to the literal path (§3.4).
- `write` is the only intercepted tool that may create a new file or directory. Therefore, the `ENOENT` recursion in step 3 is the expected path for `write` calls targeting a non-existent leaf.

### 2.4 Error Mapping

Errors from `resolve` that reach the Guard surface are mapped to block responses:

| Error | Block Reason |
|---|---|
| `ENOENT` (after full recursion) | `"Path outside workspace: {originalPath}"` |
| `EACCES` | `"Permission denied resolving path: {originalPath}"` |
| `ELOOP` | `"Symlink loop detected: {originalPath}"` |
| `ENOTDIR` | `"Not a directory in path: {originalPath}"` |

> **Rationale:** `originalPath` (the pre-resolution string) is used in the block reason to avoid leaking symlink targets. The resolved path is used only for ACL evaluation.

---

## 3. Examples

### 3.1 Happy Path — Symlink inside workspace to allowed external path

```
Workspace: /home/user/ws
Filesystem: { "rw": ["/tmp/shared"] }
Filesystem: /home/user/ws/link -> /tmp/shared

Input:   write("./link/file.txt", "...")
Resolved: /tmp/shared/file.txt
ACL:     ALLOW (matches /tmp/shared)
Result:  Native write executes.
```

### 3.2 Blocked Bypass — Symlink inside workspace to disallowed external path

```
Workspace: /home/user/ws
Filesystem: none declared outside workspace
Filesystem: /home/user/ws/secret -> /etc/shadow

Input:   read("./secret")
Resolved: /etc/shadow
ACL:     BLOCK — reason: "Path outside workspace: ./secret"
Result:  Tool does not execute.
```

### 3.3 Write Through Symlink Parent

> Only `write` can target a non-existent path; `read` and `edit` would have failed at the native tool with `ENOENT`.

```
Filesystem: /foo -> /bar (symlink)
Nothing else exists under /bar.

Input:   write("/foo/baz/x", "...")
Resolve("/foo/baz/x"):
  realpathSync("/foo/baz/x") -> ENOENT
  parent "/foo/baz" -> ENOENT
  parent "/foo" -> "/bar"
  return "/bar/baz/x"
Resolved: /bar/baz/x
ACL:     Evaluated against /bar/baz/x.
```

### 3.4 Edge Case — Broken Symlink

```
Filesystem: /home/user/ws/broken -> /nonexistent/target

Input:   read("./broken")
Resolve("/home/user/ws/broken"):
  realpathSync -> ENOENT (target does not exist)
  parent "/home/user/ws" -> "/home/user/ws"
  return "/home/user/ws/broken"
ACL:     ALLOW (path is inside workspace)
Result:  Native read executes; returns ENOENT from native tool.
```

> **Note:** A broken symlink inside the workspace is treated as its literal path because the symlink target does not exist and therefore cannot be traversed. The native tool will surface the `ENOENT`.

### 3.5 Edge Case — Symlink Loop

```
Filesystem: /a -> /b, /b -> /a

Input:   read("/a/file")
Resolve("/a/file"):
  realpathSync -> ELOOP
Result:  BLOCK — reason: "Symlink loop detected: /a/file"
```

---

## 4. Non-Goals and Forbidden Patterns

- **Do not** resolve symlinks inside the container mount builder (DESIGN.md §5.3). Bind mounts continue to use the config prefixes literally.
- **Do not** cache or memoize symlink resolution results across tool calls.
- **Do not** resolve symlinks for the `--no-sandbox` code path.
- **Do not** attempt to detect time-of-check to time-of-use (TOCTOU) races; we rely on `realpathSync` atomicity.
- **Do not** expose resolved symlink targets in error messages to the LLM.
- **Do not** recurse into mount points or filesystem boundaries specially; `realpathSync` handles this.

---

## 5. Security Properties Update

| Property | Before | After |
|---|---|---|
| Symlink bypass in Guard | Accepted limitation | Closed |
| Information leakage via error | N/A | Block reasons use original path, not resolved target |

Symlink resolution is reported as `enabled` in `/sandbox-status`.

---

## 6. Integration

Insert `resolve(path)` between DESIGN.md §4.2 step 3 (normalize) and §4.3 step 1 (collect matching prefixes). The remainder of §4.3–4.5 is unchanged.
