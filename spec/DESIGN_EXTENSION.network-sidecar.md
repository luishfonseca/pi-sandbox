# Design Extension: Network Egress Sidecar (proxyjail)

**Target:** Replaces `DESIGN.md §7` "Network isolation" row, removes `DESIGN.md §9` extension point 1, and modifies `DESIGN.md §5.3`, `§6.1`, and `§8`.  
**Concern:** Per-domain egress filtering via a **proxyjail** sidecar container plus **nsproxy** wrapping, replacing `HostConfig.NetworkMode: "none"`.  
**External spec:** All proxyjail internals — DNS proxy semantics, SOCKS5 gate behavior, policy schema, IP cache, failure modes, and rootless host prerequisites — are specified in [`sidecar/DESIGN.md`](sidecar/DESIGN.md). This extension documents only the pi-sandbox integration contract.

---

## 1. Overview

When a network policy is declared in the merged config, the extension runs **two** containers per workspace:

1. **proxyjail sidecar** (`pi-sandbox-{hash}-egress`) — Runs the proxyjail image. Shares its network namespace with the app sandbox. Provides DNS proxy (`:53`) and SOCKS5 gate (`:1080`). See [`sidecar/DESIGN.md`](sidecar/DESIGN.md) §2–§4 for sidecar internals.
2. **App sandbox** (`pi-sandbox-{hash}`) — Unchanged from v1 except:
   - `NetworkMode` is `container:<egress-name>`.
   - `--device /dev/net/tun` is attached.
   - Every `bash` command is wrapped with `nsproxy` so traffic is forced through the sidecar.

If no network policy is declared, the extension behaves exactly as before: a single app container with `HostConfig.NetworkMode: "none"`.

The sidecar is the source of truth for runtime policy state where observable; proxyjail v1 does not expose a runtime policy API, so `/sandbox-status` reports the locally configured policy that was injected at container creation time.

---

## 2. Configuration

### 2.1 Schema Addition

The top-level `SandboxConfig` gains an optional `network` field:

```typescript
interface NetworkConfig {
  domains?: string[];   // FQDNs and wildcard domains (e.g. "*.example.com")
  cidrs?: string[];     // IPv4 CIDR blocks always permitted (e.g. "192.0.2.0/24")
  denyCidrs?: string[]; // IPv4 CIDR blocks always denied (e.g. "10.0.0.0/8")
}

interface SandboxConfig {
  image: string;
  env?: Record<string, string>;
  filesystem?: { rw?: string[]; ro?: string[] };
  network?: NetworkConfig | {};   // {} treated as "none"
}
```

**Validation rules:**
- `network`, when present and non-empty, MUST be an object.
- `network.domains`, if present, MUST be an array of non-empty strings.
- `network.cidrs`, if present, MUST be an array of strings that each parse as a valid IPv4 CIDR block. Single IPs MUST be normalized to `"x.x.x.x/32"`.
- `network.denyCidrs`, if present, MUST be an array of strings that each parse as a valid IPv4 CIDR block. Single IPs MUST be normalized to `"x.x.x.x/32"`.
- Unknown keys inside `network` MUST be ignored with a warning.

No other keys (e.g. `mode`, `sidecarImage`) are accepted under `network`.

### 2.2 Merge Rules

The `network` field follows scalar replacement semantics (like `image`), not list-append semantics (like `filesystem`):

| Global `network` | Workspace `network` | Effective |
|---|---|---|
| absent | absent | `none` |
| present | absent | use global |
| absent | `{}` (empty object) | `none` |
| absent | present (non-empty) | use workspace |
| present | `{}` | `none` (explicit override) |
| present | present (non-empty) | use workspace (replaces global) |

**Rationale:** Network policy is a cohesive security boundary. Full replacement keeps the model simple and auditable.

### 2.3 Backwards Compatibility

If the merged config has no `network` key, the extension creates **one** container with `HostConfig.NetworkMode: "none"`, exactly as in v1. Existing `sandbox.json` files without a `network` section require no changes.

### 2.4 Policy Translation

The extension translates `NetworkConfig` into proxyjail's `PROXYJAIL_POLICY_JSON` format (schema defined in [`sidecar/DESIGN.md`](sidecar/DESIGN.md) §3.1):

```json
{
  "allow_domains": [ /* network.domains */ ],
  "allow_cidrs":  [ /* network.cidrs, normalized */ ],
  "deny_cidrs":   [ /* network.denyCidrs, normalized */ ]
}
```

- Every item in `domains` is passed verbatim to `allow_domains`.
- Every item in `cidrs` is validated as an IPv4 CIDR and normalized (`/32` for bare IPs), then passed to `allow_cidrs`.
- Every item in `denyCidrs` is validated as an IPv4 CIDR and normalized (`/32` for bare IPs), then passed to `deny_cidrs`.

If all arrays are empty after translation, the emitted policy is `{"allow_domains":[],"allow_cidrs":[],"deny_cidrs":[]}`, which results in deny-all.

---

## 3. Container Model

### 3.1 Naming

| Container | Name |
|---|---|
| proxyjail sidecar | `pi-sandbox-{workspaceHash}-egress` |
| App sandbox | `pi-sandbox-{workspaceHash}` |

`workspaceHash` is unchanged from `DESIGN_EXTENSION.workspace-scoped.md` §2.1.

### 3.2 proxyjail Sidecar Specification

**Image:** Hardcoded to `proxyjail:latest`. Pulled lazily using the same async-pull logic as the app sandbox image.

**Capabilities:** No extra capabilities. proxyjail does **not** require `CAP_NET_ADMIN`.

**Command:** Uses the image default entrypoint.

**Environment variables:**
- `PROXYJAIL_POLICY_JSON=<JSON.stringify(translatedPolicy)>` (from §2.4)
- `PROXYJAIL_SOCKS5_ADDR=:1080` (hardcoded)
- `PROXYJAIL_DNS_ADDR=:53` (hardcoded)
- `PROXYJAIL_UPSTREAM_DNS=tcp://1.1.1.1:53` (hardcoded)

**No bind mounts** are attached to the sidecar for v1.

**No port publishing** is required.

### 3.3 App Sandbox Specification

When network policy is active:

- `HostConfig.NetworkMode` is set to `"container:pi-sandbox-{workspaceHash}-egress"`.
- `HostConfig.Devices` includes `/dev/net/tun`.
- `HostConfig.CapDrop: ["ALL"]` and `SecurityOpt: ["no-new-privileges:true"]` remain unchanged.  
  *(Rationale: `nsproxy` creates its inner namespace via `unshare(CLONE_NEWUSER | CLONE_NEWNET)`, which does not require capabilities when the host permits unprivileged user namespaces. See [`sidecar/DESIGN.md`](sidecar/DESIGN.md) §8.2.)*
- The `nsproxy` binary MUST be available inside the container at a well-known path (see §3.5).
- All other properties (bind mounts, env, working dir) are unchanged from `DESIGN.md §5.3`.

When network policy is `none`:

- `HostConfig.NetworkMode` is `"none"` (unchanged from v1).
- No `nsproxy` binary is required.

### 3.4 nsproxy Wrapping

When network policy is active, every `bash` command is executed via `docker exec` with `nsproxy` as the prefix:

```bash
nsproxy -s 127.0.0.1 -p 1080 -d tcp://127.0.0.1:53 sh -c "<command>"
```

- `127.0.0.1:1080` is the sidecar SOCKS5 proxy.
- `tcp://127.0.0.1:53` is the sidecar DNS proxy.
- `sh -c` is used because the sandbox image may not have `bash` at `/bin/bash`.

**Precondition:** The `nsproxy` binary exists at `/usr/local/bin/nsproxy` (or another documented path) inside the app container.

**Postcondition:** The command runs in a fresh network namespace created by `nsproxy`. All TCP/UDP traffic is routed through the TUN device to the nsproxy parent process, which forwards via SOCKS5 to the proxyjail sidecar. DNS queries are redirected to the sidecar's DNS proxy. See [`sidecar/DESIGN.md`](sidecar/DESIGN.md) §2.2 for the full data flow.

**Timeout and cancellation:** The `docker exec` process runs `nsproxy`. On timeout or abort signal, the extension kills the `docker exec` process (and therefore the `nsproxy` parent). The child command namespace is torn down automatically.

### 3.5 nsproxy Binary Provisioning

The extension resolves a statically-linked `nsproxy` binary on the host and bind-mounts it read-only into the app container.

**Host path resolution:**
1. Let `extensionDir` be the directory containing the pi-sandbox extension source (`path.dirname(new URL(import.meta.url).pathname)` or equivalent).
2. Candidate host path: `${extensionDir}/bin/nsproxy`.
3. If the file does not exist or is not executable, session start MUST fail with:
   `"nsproxy binary not found at ${candidatePath}. Install the static nsproxy binary before enabling network policy."`

**Bind mount:**
- Host path: resolved candidate above.
- Container path: `/usr/local/bin/nsproxy`.
- Mode: `ro`.

The mount is appended to the bind-mount list in `HostConfig.Binds` when the app sandbox container is created.

### 3.6 Lifecycle Ordering

**Creation** (first `bash` tool call, inside lifecycle mutex):
1. Ensure proxyjail sidecar exists and is running. Create/start if absent.
2. Ensure app sandbox exists and is running. Create/start if absent, using the sidecar's network namespace and with `/dev/net/tun` attached.
3. Write config hash to state dir.

**Destruction** (last session ends, inside lifecycle mutex):
1. Stop and remove app sandbox.
2. Stop and remove proxyjail sidecar.

**Rationale:** The app container references the sidecar's network namespace. Stopping the app first avoids Docker errors.

### 3.7 Failure Mode

If the proxyjail sidecar or app sandbox fails to start (e.g. missing `/dev/net/tun` on the host, host blocks unprivileged user namespaces, image pull failure, invalid policy JSON), the extension **fails fast** with an explicit error. There is **no** fallback to `NetworkMode: "none"`. The user must either fix the environment or remove the `network` config.

Specific rootless failure messages are documented in [`sidecar/DESIGN.md`](sidecar/DESIGN.md) §8.2.

---

## 4. Policy Semantics

### 4.1 Static Policy

The policy is set **once** at sidecar container creation time via `PROXYJAIL_POLICY_JSON`. proxyjail parses it on startup. There is **no** runtime hot-reload or HTTP API in v1.

There is **no** runtime Pi command to update the policy. To change allowed domains, the user edits `sandbox.json` and runs `/sandbox-reset`.

### 4.2 Config Staleness

The effective config hash covers the entire merged config including `network`. If the user changes network policy, the stored hash diverges from the current hash, triggering the existing staleness warning: `"Sandbox config has changed. Run /sandbox-reset to recreate."`.

### 4.3 Policy Examples

**Example 1 — Deny-all (default-deny, no egress):**
```json
{ "network": {} }
```
Wait — `{}` means "none" (no sidecar). To express deny-all with the sidecar active:
```json
{ "network": { "domains": [], "cidrs": [] } }
```
Result: Sidecar runs but rejects all DNS queries with `REFUSED` and denies all SOCKS5 connects.

**Example 2 — Allowlist with deny CIDR override:**
```json
{
  "network": {
    "domains": ["*.example.test"],
    "cidrs": ["192.0.2.0/24"],
    "denyCidrs": ["192.0.2.128/25"]
  }
}
```
Result: `*.example.test` resolves and reaches the resolved IPs; direct connects to `192.0.2.0/24` are allowed; but `192.0.2.128/25` is denied because `deny_cidrs` is evaluated first.

**Example 3 — Explicitly disabled (override global):**
```json
{ "network": {} }
```
Result: No sidecar created. App container uses `NetworkMode: "none"`.

---

## 5. /sandbox-status Integration

### 5.1 Network Reporting

When `--no-sandbox` is not active, `/sandbox-status` MUST report network state.

**If the merged config has no `network` key (or `{}`):**
```
Network: none
```

**If network policy is active:**
```
Network:
  allow: *.example.test, 192.0.2.0/24
  deny: 192.0.2.128/25
```

**Field sources:**
- `allow`: Comma-separated list of `domains` and `cidrs` from the locally configured policy that was injected at container creation, or `"(none)"` if empty.
- `deny`: Comma-separated list of `denyCidrs` from the locally configured policy, or `"(none)"` if empty.

*(Rationale: proxyjail v1 does not expose a runtime policy API. The extension reports the policy it last pushed to the sidecar via `PROXYJAIL_POLICY_JSON`.)*

### 5.2 Status Report Field Additions

The report from `DESIGN.md §8.4` gains one new top-level field:

| Field | Source | Description |
|---|---|---|
| `network` | Local config / container status | `none`, or structured health/policy summary |

All other fields remain unchanged.

---

## 6. Security Properties Update

Replace the `DESIGN.md §7` "Network isolation" row with:

| Property | Mechanism | Guarantee |
|---|---|---|
| Network isolation | proxyjail sidecar + nsproxy inner namespace | Default-deny at DNS and TCP layers. App container has `CapDrop: ALL`; no `NET_ADMIN` required anywhere. DNS and TCP egress are gated by the sidecar. |

Add to `DESIGN.md §7` "Known limitations":

- proxyjail relies on the host permitting unprivileged user namespaces and the presence of `/dev/net/tun`. Environments that block `unshare(CLONE_NEWUSER \| CLONE_NEWNET)` or lack the TUN device cannot use network policy. See [`sidecar/DESIGN.md`](sidecar/DESIGN.md) §8.2 for the full prerequisite checklist.
- Policy is static per container lifetime. Runtime policy changes require `/sandbox-reset`.
- proxyjail v1 does not support a configurable default action; the default is always deny.

---

## 7. Non-Goals and Forbidden Patterns

- **Do not** expose `mode`, `sidecarImage`, `PROXYJAIL_SOCKS5_ADDR`, `PROXYJAIL_DNS_ADDR`, `PROXYJAIL_UPSTREAM_DNS`, or other proxyjail tuning knobs in `sandbox.json`.
- **Do not** implement a Pi command for runtime policy updates (e.g. `/network-allow`).
- **Do not** share the proxyjail sidecar across different workspaces.
- **Do not** fallback to `NetworkMode: "none"` when the sidecar fails to start. Fail fast.
- **Do not** enable proxyjail EXTENSION POINT features (IPv6 CIDR static allowlisting, AAAA record caching / IPv6 egress via DNS cache, TTL cache eviction, UDP ASSOCIATE, observability exports) in v1.
- **Do not** support Windows natively (unchanged from v1).

---

## 8. Integration

1. **Replace** `DESIGN.md §7` "Network isolation" row with §6 above.
2. **Remove** `DESIGN.md §9` extension point 1:
   > ~~1. **Egress sidecar / per-domain filtering.** Replace `HostConfig.NetworkMode: "none"` with a bridge network + sidecar.~~
3. **Modify** `DESIGN.md §5.3`:
   - When network policy is active, `HostConfig.NetworkMode` is `"container:pi-sandbox-{workspaceHash}-egress"` and `/dev/net/tun` is attached.
   - When network policy is `none`, `HostConfig.NetworkMode` is `"none"`.
4. **Modify** `DESIGN.md §8.4` to include the `network` field described in §5.2 above.
5. **Modify** `DESIGN.md §3.2` to add the `network` field to the `SandboxConfig` schema.
6. **Modify** `DESIGN.md §3.3` to document the `network` merge rules in §2.2 above.
