# Implementation Session: Three-Layer Deepmerge Config

## Branch
`feature/deepmerge-config-3layer` — spec changes are committed. Do **not** rewrite spec; implement the changes in `src/` and `tests/`.

## What Changed in Spec

The config system was redesigned. Read these spec files first:
- `spec/DESIGN.md` §3.1–§3.3 (Source of Truth, Schema, Merge Rules)
- `spec/DESIGN_EXTENSION.network-sidecar.md` §2.1–§2.3 (Network merge rules, `sidecarVersion`)

### New Semantics

**Three layers (low → high priority):**
1. Package defaults: `sandbox-default.json` (in package root, next to `package.json`)
2. Global config: `~/.pi/sandbox.json` (optional)
3. Workspace config: `${cwd}/sandbox.json` (optional)

**Merge rules:**
1. `deepmerge.all([defaults, global, workspace])` with **default settings** — no custom hooks.
   - Objects deep-merge recursively.
   - Arrays concatenate left-to-right.
2. Post-merge recursive walk:
   - **Object key with `null` value** → delete the key entirely.
   - **Array containing `null`** → truncate at the **last** `null`, keep everything after it. If `null` is the last element, result is `[]`.
3. Normalization for missing optional keys:
   - missing `env` → `{}`
   - missing `filesystem` → `{rw: [], ro: []}`
   - missing `network` → `{}` (disabled)

**Examples:**
- `{rw: ["/a"]} + {rw: ["/b"]} → {rw: ["/a", "/b"]}`
- `{rw: ["/a"]} + {rw: [null, "/b"]} → {rw: ["/a", null, "/b"]} → {rw: ["/b"]}`
- `{rw: ["/a"]} + {rw: [null]} → {rw: ["/a", null]} → {rw: []}`
- `{rw: ["/a", null]} + {rw: ["/b"]} → {rw: ["/a", null, "/b"]} → {rw: ["/b"]}`
- `{image: "alpine"} + {image: null} → {}` (key deleted)
- `{env: {A: "1"}} + {env: {A: null}} → {env: {}}` (key A removed)
- `{network: {domains: ["x"]}} + {network: null} → {}` (key deleted, then normalized to `{}`)

**`sidecarVersion`:**
- Replaces `sidecarImage`. Value is a version tag/digest string.
- Full image ref is always `ghcr.io/sagernet/sing-box:{sidecarVersion}`.
- No global-only enforcement needed; it's just a config key like any other.

**Warnings:**
- Neither global nor workspace config is required. Warn if both missing.
- Invalid JSON in optional files → treat as `{}` with warning.
- Unknown keys in any layer → warning per file.

## Files to Modify

### `package.json`
Add dependency: `deepmerge` (latest stable).

### `src/config.ts`
**Major rewrite.** The current `mergeConfigs` function implements two-layer hand-rolled merge. Replace with:

1. `loadDefaultsConfig()` — read `sandbox-default.json` from package directory. Resolve via `import.meta.url` or `__dirname`. Must throw if file missing or invalid JSON.
2. `loadOptionalConfig(path)` — read a file, return `{}` on ENOENT, warn on invalid JSON.
3. `mergeConfigs(defaults, global, workspace)` — use `deepmerge.all([defaults, global, workspace])` with **default options** (no custom hooks). Then post-process:
   - Recursive walk: delete object keys with `null` values
   - Recursive walk: for each array, find last `null`, if found replace with slice after it
   - Then normalization (fill missing optional keys)
   - Return `{config, warnings}`
4. Remove obsolete helpers: `mergeStringMaps`, `mergeStringLists`, `resolveImage`, `resolveSidecarImage`, `mergeNetwork` (or keep only `extractNetwork` for validation).
5. Update `loadConfig()` to load three layers and call new `mergeConfigs()`.
6. Update `validateConfig()`:
   - `image` must be non-empty string
   - `sidecarVersion` is optional string (was `sidecarImage`)
   - No `env` `null` values (already filtered by merge)

### `src/network.ts`
1. `hasNetworkPolicy()`: change from `config.network !== undefined && Object.keys(config.network).length > 0` to `Object.keys(config.network).length > 0` (network is always `{}` after normalization).
2. `extractNetwork()`: The current function returns `config: undefined` for `{}` input. With normalization, `{}` is the "disabled" state and should be preserved (not converted to `undefined`). Review whether `extractNetwork` needs changes or if normalization handles it.

### `src/docker.ts` / `src/start-container.ts`
Search for `sidecarImage` usage. Replace with `sidecarVersion` → construct full image ref `ghcr.io/sagernet/sing-box:${config.sidecarVersion}`. Default version if missing: `v1.12.0`.

### `tests/config.test.ts`
**Major rewrite.** Replace all tests that assume:
- Two-layer merge
- `env` deletion via `""` → now `null`
- `filesystem` discard via `""` prefix → now `[null]` sentinel
- Global config being required

New tests needed:
- Three-layer merge: defaults + global + workspace
- `null` deletes key (object context)
- Array truncation at last `null`
- Array concat when no `null`
- Normalization fills missing optional keys
- Both global and workspace missing → warning, uses defaults only
- `sidecarVersion` passes through

### `tests/network.test.ts`
Update `hasNetworkPolicy` tests for new semantics.

### `sandbox-default.json`
Already exists with `{"image": ""}`. This file is loaded at runtime. Ensure the loader resolves it correctly from the package directory.

## Rules to Follow

- **Spec over tests.** For behavioral questions, read the spec files first.
- **Fail fast.** Invalid values in `sandbox-default.json` throw immediately.
- **No hardcoded defaults in source.** The only default values live in `sandbox-default.json`.
- **Keep warnings.** The existing warning system (unknown keys, invalid JSON, etc.) must still work.

## Edge Cases

- `null` anywhere in an array triggers truncation at the **last** one. Multiple `null`s in one array: `["/a", null, "/b", null, "/c"] → ["/c"]`.
- `[]` in source array: `{rw: ["/a"]} + {rw: []} → {rw: ["/a"]}` (concat with empty → identity, no null → no truncation).
- `[null]` in source array: `{rw: ["/a"]} + {rw: [null]} → {rw: []}`.
