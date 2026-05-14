# Design Extension: Network Egress Sidecar (sing-box)

**Target:** Replaces `DESIGN.md Sec. 7` "Network isolation" row, removes `DESIGN.md Sec. 9` extension point 1, and modifies `DESIGN.md Sec. 5.3`, `Sec. 6.1`, and `Sec. 8`.  
**Concern:** Per-domain egress filtering via a **sing-box** sidecar container, replacing `HostConfig.NetworkMode: "none"`.

---

## 1. Overview

When a network policy is declared in the merged config, the extension runs **two** containers per workspace, plus **one external Docker bridge network** per workspace:

1. **External bridge network** (`pi-sandbox-{hash}-net`) — A standard Docker bridge network. Only the workspace's sidecar joins it. Provides the sidecar with internet upstream.
2. **sing-box sidecar** (`pi-sandbox-{hash}-egress`) — Runs the official `ghcr.io/sagernet/sing-box` image. Joins the workspace's external bridge network. Creates a TUN interface inside its network namespace with `auto_route: true` to intercept all egress traffic. Provides transparent DNS hijacking. Policy is expressed entirely through a generated sing-box JSON configuration file.
3. **App sandbox** (`pi-sandbox-{hash}`) — Unchanged from v1 except:
   - `NetworkMode` is `container:<sidecar-name>` (shares the sidecar's network namespace).
   - All outbound TCP/UDP traffic is transparently routed through the TUN interface into sing-box; **no** proxy environment variables or application cooperation are required.
   - DNS queries are hijacked at the TUN layer; **no** `--dns` flag is required.
   - Domain-based filtering relies on protocol sniffing (TLS SNI, HTTP Host header). Raw TCP connections without recoverable domain information are filtered by CIDR rules only.

If no network policy is declared, the extension behaves exactly as before: a single app container with `HostConfig.NetworkMode: "none"`.

The sidecar is the source of truth for runtime policy state where observable; sing-box does not expose a runtime policy API in this configuration, so `/sandbox-status` reports the locally configured policy that was injected at container creation time.

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
  sidecarVersion?: string;        // sing-box version tag or digest (default: v1.12.0)
  env?: Record<string, string>;
  filesystem?: { rw?: string[]; ro?: string[] };
  network?: NetworkConfig;        // Normalized to {} when absent or deleted by null
}
```

**Validation rules:**
- `network`, when present and non-empty, MUST be an object.
- `network.domains`, if present, MUST be an array of non-empty strings.
  - Each entry is canonicalized by lowercasing and stripping one trailing root dot.
  - Accepted forms: exact hostname (`example.com`) or suffix wildcard (`*.example.com`).
  - Rejected forms: bare `*`, `*example.com` (missing dot), `foo.*.example.com` (embedded wildcard), IP literals, empty labels, labels over 63 octets, total name over 253 octets.
  - `*.example.com` is translated to `domain_suffix: ".example.com"` and matches any subdomain but **not** the apex `example.com`.
- `network.cidrs`, if present, MUST be an array of strings that each parse as a valid IPv4 CIDR block. Single IPs MUST be normalized to `"x.x.x.x/32"`.
- `network.denyCidrs`, if present, MUST be an array of strings that each parse as a valid IPv4 CIDR block. Single IPs MUST be normalized to `"x.x.x.x/32"`.
- `sidecarVersion`, if present, MUST be a non-empty string. Any value valid as a Docker image tag or digest suffix is accepted. The full image reference is always `ghcr.io/sagernet/sing-box:{sidecarVersion}`.
- Unknown keys inside `network` MUST be ignored with a warning.

### 2.2 Merge Rules

The `network` field follows the standard three-layer merge rules in DESIGN.md §3.3. It is an object and is recursively merged like any other config key.

To explicitly disable an inherited network policy, set `"network": null` in the workspace (or global) config. This deletes the `network` key; normalization then fills it with `{}`, resulting in `NetworkMode: "none"`.

To replace a lower-layer array entirely (e.g. to discard global `domains` and use only workspace `domains`), use the array sentinel:
`"domains": [null, "workspace.only"]`

**Rationale:** Network policy is a cohesive security boundary, but deep-merging still applies. `null` is the uniform delete sentinel for all keys.

### 2.3 Backwards Compatibility

If the merged config has no `network` key (absent in all layers, or deleted via `null`), normalization fills it with `{}`, and the extension creates **one** container with `HostConfig.NetworkMode: "none"`, exactly as in v1. Existing `sandbox.json` files without a `network` section require no changes.

If the global config declares `network` and the workspace config omits the key, the global policy is used. To explicitly disable an inherited global network policy, the workspace MUST set `"network": null`.

### 2.4 Policy Translation

The extension translates `NetworkConfig` into a sing-box JSON configuration file. The generated configuration MUST be syntactically valid for the sing-box version being run. The following structural invariants MUST be present:

**Log:**
```json
{ "log": { "level": "warn" } }
```

**DNS servers:**
- One upstream resolver tagged `upstream` (`type`: `udp`, `server`: `1.1.1.1`, `routing_mark`: `51966`).
  - *Rationale:* The DNS server MUST set `routing_mark` so that its own upstream queries (to `1.1.1.1`) are tagged with the sidecar mark and therefore permitted by the nftables output rule on `eth0`.

**DNS rules (evaluated top-to-bottom):**
1. For each allowed exact domain: a `domain` matcher with `"action": "route", "server": "upstream"`.
2. For each allowed wildcard domain, sorted by suffix length descending: a `domain_suffix` matcher with the leading-dot suffix (e.g. `.example.com`) and `"action": "route", "server": "upstream"`.
3. A final rule with `"action": "reject"` (default-deny for DNS; sing-box replies with `REFUSED`).

**Inbounds:**
- One `tun` inbound with:
  - `interface_name`: `"sb-tun0"`
  - `address`: `["198.18.0.1/30"]`
    - *Rationale:* `198.18.0.0/15` is TEST-NET-2 (RFC 2544), reserved for benchmarking and non-routable on the internet. It is guaranteed free of collision with Docker bridge subnets (`172.16.0.0/12`, `192.168.0.0/16`) and RFC 1918 private ranges that may be in use on the host. sing-box requires an explicit TUN address; there is no default.
  - `mtu`: `9000`
  - `auto_route`: `true`
  - `strict_route`: `true`
  - `stack`: `"system"`
  - `sniff`: `true`
  - `sniff_override_destination`: `true`

**Outbounds:**
- `direct` (tag: `direct`, `routing_mark`: `51966`).
  - *Rationale:* Every packet sing-box emits to the real internet MUST carry the mark `0xCAFE` (decimal `51966`). The nftables output rule in the shared network namespace drops any packet leaving via `eth0` that lacks this mark. Because the app has `CapDrop: ALL`, it cannot forge `SO_MARK`, so it cannot bypass the filter.

**Route rules (evaluated top-to-bottom):**
1. `"inbound": ["tun-in"], "action": "sniff"` — enable protocol sniffing (TLS SNI, HTTP Host header) on TUN connections. This rule **must** precede all matchers that depend on sniffed metadata because sing-box evaluates rules in pre-match before connection data is available; when it hits the `sniff` action it pauses, reads the initial bytes, then resumes matching with enriched metadata.
2. `"port": [53], "action": "hijack-dns"` — redirect UDP/TCP port-53 traffic into the sing-box DNS module. Port matching works in pre-match; `protocol: dns` does not (it requires sniffing, which happens after pre-match).
3. For each CIDR from `network.denyCidrs` and `network.cidrs`, sorted by prefix length descending (most specific first), with `denyCidrs` ordered before `cidrs` at the same prefix length: an `ip_cidr` rule. If the CIDR is from `denyCidrs`, `"action": "reject"`. If from `cidrs`, `"outbound": "direct"`.
4. For each allowed exact domain: a `domain` matcher with `"outbound": "direct"`.
5. For each allowed wildcard domain, sorted by suffix length descending: a `domain_suffix` matcher with the leading-dot suffix and `"outbound": "direct"`.
6. A final rule with `"action": "reject"` (default-deny for all other traffic).

**Route options:**
- `"auto_detect_interface": true`
- `"default_domain_resolver": "upstream"`

**Precondition:** `network.domains`, `network.cidrs`, and `network.denyCidrs` are validated and normalized per Sec. 2.1.

**Postcondition:** The generated JSON is syntactically valid sing-box configuration and expresses a default-deny policy with explicit allowlist exceptions.

If all arrays are empty after translation, the emitted policy is deny-all: DNS queries are rejected (sing-box replies `REFUSED`) and all TCP/UDP connections are rejected.

---

## 3. Container Model

### 3.1 Naming

| Resource | Name |
|---|---|
| External bridge network | `pi-sandbox-{workspaceHash}-net` |
| sing-box sidecar | `pi-sandbox-{workspaceHash}-egress` |
| App sandbox | `pi-sandbox-{workspaceHash}` |

`workspaceHash` is unchanged from `DESIGN_EXTENSION.workspace-scoped.md` Sec. 2.1.

### 3.2 External Bridge Network

When network policy is active, the extension ensures a Docker network named **`pi-sandbox-{workspaceHash}-net`** exists:

```bash
docker network create pi-sandbox-{workspaceHash}-net
```

- This is a **standard** Docker bridge network (not `--internal`). It provides the sidecar with a route to the internet.
- The network name includes `workspaceHash` so each workspace gets its own isolated L2 domain. Sidecars from different workspaces cannot reach each other.
- If the network already exists, creation is idempotent.
- The network is **not** removed on session teardown; it is left for reuse.

### 3.3 sing-box Sidecar Specification

**Image:** The effective sidecar image is `ghcr.io/sagernet/sing-box:{sidecarVersion}`. Pulled lazily using the same async-pull logic as the app sandbox image. The project test suite MUST include a test that generates a sing-box config from a representative `NetworkConfig` and validates it with `sing-box check -c` using the matching pinned sidecar image version, to catch schema drift (e.g. the `predefined` server type and `protocol: dns` matchers that existed in earlier drafts are invalid in v1.12).

**Capabilities:** `NET_ADMIN` MUST be added. The sidecar MUST be started with `--device /dev/net/tun` so sing-box can create and configure the TUN interface.

**Command:** `run -c /etc/sing-box/config.json`

**Network:** The sidecar joins **only** `pi-sandbox-{workspaceHash}-net`.

**Bind mounts:**
- Host path: the generated sing-box config file (written to the extension's state directory).
- Container path: `/etc/sing-box/config.json`.
- Mode: `ro`.

**No port publishing** is required.

**Post-start hook:** After the sidecar container is running, the extension MUST execute a one-shot `docker exec` into the sidecar to install an nftables rule in the shared network namespace. The sing-box image sets `ENTRYPOINT ["sing-box"]`, so the exec MUST override the entrypoint (e.g. `--entrypoint nft`) to run the `nft` binary directly:

```bash
nft add table inet sb-guard
nft add chain inet sb-guard output { type filter hook output priority 0 \; policy accept \; }
nft add rule inet sb-guard output oifname "eth0" meta mark != 0xCAFE drop
```

- `inet` family covers both IPv4 and IPv6.
- `oifname "eth0"` matches only the Docker bridge interface.
- `meta mark != 0xCAFE drop` drops every packet that is not tagged with the sidecar's `routing_mark`.
- The rule is installed **once** after creation. If the sidecar is restarted, the rule is recreated because the network namespace is recreated.
- The official sing-box image is Alpine-based and already contains the `nftables` package (`nft` binary at `/usr/sbin/nft`). No custom image is required.

**Precondition:** The sidecar is running and has `NET_ADMIN`.

**Postcondition:** Any packet leaving `eth0` from the shared namespace without mark `0xCAFE` is dropped at the output hook.

### 3.4 App Sandbox Specification

When network policy is active:

- `HostConfig.NetworkMode` is set to `"container:pi-sandbox-{workspaceHash}-egress"`.
- `HostConfig.CapDrop: ["ALL"]` and `SecurityOpt: ["no-new-privileges:true"]` remain unchanged.
- **No** proxy environment variables are injected.
- **No** `--dns` flag is set.
- **No** extra devices or capabilities are required.
- All other properties (bind mounts, env, working dir) are unchanged from `DESIGN.md Sec. 5.3`.

**Rationale for shared netns:** The app must be in the same network namespace as the sidecar so that the TUN interface and its routing rules are visible to the app. Because the app has `CapDrop: ALL`, it cannot modify routes, iptables/nftables, interfaces, or socket marks. It can observe the TUN and the internet-facing bridge interface, but it cannot remove the more-specific routes that sing-box installs, nor can it forge the `SO_MARK` required to bypass the nftables output rule.

When network policy is `none`:

- `HostConfig.NetworkMode` is `"none"` (unchanged from v1).

### 3.5 Sidecar Health

Before every `bash` command, the extension SHOULD verify via `docker inspect` that the sidecar container exists and `.State.Running` is `true`. If not, the extension SHOULD surface a warning in `/sandbox-status` and MAY return an error to the user:
> `"Egress sidecar is not running. Run /sandbox-reset to recreate the sandbox."`

There is **no** persistent event stream, sidecar death monitor, or automatic killing of the app container. The nftables rule provides the fail-closed guarantee; if the sidecar stops, its network namespace (and therefore the nftables rule) is destroyed along with the TUN interface, and the app container loses all egress paths.

### 3.6 Lifecycle Ordering

**Creation** (first `bash` tool call, inside lifecycle mutex):
1. Ensure `pi-sandbox-{workspaceHash}-net` exists (create if absent).
2. Generate sing-box config JSON from merged `network` config and write to state dir.
3. Ensure sing-box sidecar exists and is running on `pi-sandbox-{workspaceHash}-net`. Create/start if absent, mounting the generated config.
4. Install the nftables output rule in the sidecar (Sec. 3.3). This step is idempotent; running the `nft add` commands against an existing table/chain is a benign no-op.
5. Ensure app sandbox exists and is running with `NetworkMode: container:<sidecar>`. Create/start if absent.
6. Write config hash to state dir.

**Destruction** (last session ends or `/sandbox-reset`, inside lifecycle mutex):
1. Stop and remove app sandbox.
2. Stop and remove sing-box sidecar.
3. Remove `pi-sandbox-{workspaceHash}-net`.

**Rationale:** The app container references the sidecar by name in `NetworkMode`. Docker resolves this name to a container ID at creation time. If the sidecar is removed and recreated, the app must also be recreated to attach to the new container's network namespace.

### 3.7 Failure Mode

If the sing-box sidecar or app sandbox fails to start (e.g. image pull failure, invalid generated config, Docker daemon unreachable, `NET_ADMIN` unavailable), the extension **fails fast** with an explicit error. There is **no** fallback to `NetworkMode: "none"`. The user must either fix the environment or remove the `network` config.

---

## 4. Policy Semantics

### 4.1 Static Policy

The policy is set **once** at sidecar container creation time via the generated sing-box config file. sing-box parses it on startup. There is **no** runtime hot-reload or HTTP API in v1.

There is **no** runtime Pi command to update the policy. To change allowed domains, the user edits `sandbox.json` and runs `/sandbox-reset`.

### 4.2 Config Staleness

The effective config hash covers the entire merged config including `network`. If the user changes network policy, the stored hash diverges from the current hash, triggering the existing staleness warning: `"Sandbox config has changed. Run /sandbox-reset to recreate."`.

### 4.3 Policy Examples

**Example 1 -- Deny-all (default-deny, no egress):**
```json
{ "network": { "domains": [], "cidrs": [] } }
```
Result: Sidecar runs but rejects all DNS queries and denies all TCP/UDP connections.

**Example 2 -- Allowlist with deny CIDR override:**
```json
{
  "network": {
    "domains": ["*.example.test"],
    "cidrs": ["192.0.2.0/24"],
    "denyCidrs": ["192.0.2.128/25"]
  }
}
```
Result: `*.example.test` resolves and reaches the destination; direct connections to `192.0.2.0/24` are allowed; but connections to `192.0.2.128/25` are denied because `denyCidrs` rules are evaluated before `cidrs` rules.

**Example 3 -- Explicitly disabled (override global):**
```json
{ "network": null }
```
Result: `network` key deleted; normalized to `{}`. No sidecar created. App container uses `NetworkMode: "none"`.

---

## 5. /sandbox-status Integration

### 5.1 Network Reporting

When `--no-sandbox` is not active, `/sandbox-status` MUST report network state.

**If the merged config has no `network` key (or `network` is `{}` after normalization):**
```
Network: none
```

**If network policy is active:**
```
Network:
  allow: *.example.test, 192.0.2.0/24
  deny: 192.0.2.128/25
  sidecar: running
```

**Field sources:**
- `allow`: Comma-separated list of `domains` and `cidrs` from the locally configured policy that was injected at container creation, or `"(none)"` if empty.
- `deny`: Comma-separated list of `denyCidrs` from the locally configured policy, or `"(none)"` if empty.
- `sidecar`: `running`, `stopped`, or `not found` based on a lightweight `docker inspect` of `pi-sandbox-{workspaceHash}-egress`.

*(Rationale: sing-box does not expose a runtime policy API in this configuration. The extension reports the policy it last pushed to the sidecar via the generated config file.)*

### 5.2 Status Report Field Additions

The report from `DESIGN.md Sec. 8.4` gains one new top-level field:

| Field | Source | Description |
|---|---|---|
| `network` | Local config / container status | `none`, or structured health/policy summary |

All other fields remain unchanged.

---

## 6. Security Properties Update

Replace the `DESIGN.md Sec. 7` "Network isolation" row with:

| Property | Mechanism | Guarantee |
|---|---|---|
| Network isolation | sing-box sidecar + TUN + shared netns + per-workspace bridge + nftables mark filter | Default-deny at DNS and TCP/UDP layers. App container has `CapDrop: ALL`; no extra capabilities required. All egress traffic is transparently intercepted by sing-box routing rules. The nftables output rule drops any unmarked packet on `eth0`; because only sing-box can set the mark (`SO_MARK` requires `CAP_NET_ADMIN`), the app cannot bypass the filter even if the TUN interface or routes are modified. If the sidecar is destroyed, its network namespace is destroyed and the app loses all egress paths. |

Add to `DESIGN.md Sec. 7` "Known limitations":

- Domain-based filtering relies on protocol sniffing (TLS SNI, HTTP Host header). Raw TCP connections without recoverable domain information are filtered by CIDR rules only. If such a connection targets an IP that is not covered by any `cidrs` or `denyCidrs` rule, it is rejected.
- CIDR rules are evaluated before domain rules. An allowed domain that resolves to an IP within a `denyCidrs` entry is blocked.
- The app shares the sidecar's network namespace and can therefore observe the presence of the internet-facing bridge interface. It cannot modify routes, interfaces, nftables rules, or socket marks because of `CapDrop: ALL`, so it cannot bypass the filter while the sidecar is healthy or after it dies.
- `strict_route: true` forces all traffic through the TUN interface, including traffic to the Docker bridge subnet. Without it, more-specific connected routes for the bridge subnet would bypass sing-box.
- Policy is static per container lifetime. Runtime policy changes require `/sandbox-reset`.
- sing-box v1 configuration does not support a configurable default action; the default is always deny.

---

## 7. Non-Goals and Forbidden Patterns

- **Do not** expose `mode`, `tunAddress`, `fakeIpRange`, `upstreamDns`, `routing_mark`, or other sing-box tuning knobs in `sandbox.json`.
- **Do not** implement a Pi command for runtime policy updates (e.g. `/network-allow`).
- **Do not** share the sing-box sidecar across different workspaces.
- **Do not** fallback to `NetworkMode: "none"` when the sidecar fails to start. Fail fast.
- **Do not** implement runtime sidecar health auto-recovery (e.g., restarting sing-box and reconnecting the app). Require explicit `/sandbox-reset`.
- **Do not** implement a persistent sidecar death monitor or automatic app-kill on sidecar failure. The nftables rule is the single fail-closed mechanism.

**EXTENSION POINT:** A future revision may add a Clash API health check (e.g., `GET /` with a bearer token) to `isSidecarHealthy`, replacing the coarse `docker inspect` check. This requires injecting an API secret into the generated sing-box config and is deferred until needed.
- **Do not** support Windows natively (unchanged from v1).

---

## 8. Integration

1. **Replace** `DESIGN.md Sec. 7` "Network isolation" row with Sec. 6 above.
2. **Remove** `DESIGN.md Sec. 9` extension point 1:
   > ~~1. **Egress sidecar / per-domain filtering.** Replace `HostConfig.NetworkMode: "none"` with a bridge network + sidecar.~~
3. **Modify** `DESIGN.md Sec. 5.3`:
   - When network policy is active, `HostConfig.NetworkMode` is `"container:pi-sandbox-{workspaceHash}-egress"`.
   - When network policy is `none`, `HostConfig.NetworkMode` is `"none"`.
4. **Modify** `DESIGN.md Sec. 8.4` to include the `network` field described in Sec. 5.2 above.
5. **Modify** `DESIGN.md Sec. 3.2` to add the `network` field to the `SandboxConfig` schema.
6. **Modify** `DESIGN.md Sec. 3.3` to document the `network` merge rules in Sec. 2.2 above.
7. **Modify** `DESIGN.md Sec. 2` to scope the egress-sidecar/DNS-proxy/IP-layer-filtering non-goals to "v1 default behavior when `network` config is absent or `{}`." When `network` is configured per this extension, these non-goals no longer apply.
