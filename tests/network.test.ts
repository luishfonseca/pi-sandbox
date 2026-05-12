import assert from "node:assert";
import { describe, it } from "node:test";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeDomain,
  normalizeCidr,
  generateSingBoxConfig,
  extractNetwork,
  hasNetworkPolicy,
} from "../src/network.js";

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeIntegration = isDockerAvailable() ? describe : describe.skip;

describe("canonicalizeDomain", () => {
  it("returns exact for plain domain", () => {
    const r = canonicalizeDomain("Example.COM");
    assert.strictEqual(r.type, "exact");
    assert.strictEqual(r.value, "example.com");
  });

  it("strips trailing root dot", () => {
    const r = canonicalizeDomain("example.com.");
    assert.strictEqual(r.value, "example.com");
  });

  it("returns wildcard for *.example.com", () => {
    const r = canonicalizeDomain("*.Example.COM");
    assert.strictEqual(r.type, "wildcard");
    assert.strictEqual(r.value, ".example.com");
  });

  it("rejects bare *", () => {
    assert.throws(() => canonicalizeDomain("*"), /bare/);
  });

  it("rejects *example.com", () => {
    assert.throws(() => canonicalizeDomain("*example.com"), /wildcard must be/);
  });

  it("rejects foo.*.example.com", () => {
    assert.throws(() => canonicalizeDomain("foo.*.example.com"), /wildcard must be/);
  });

  it("rejects IP literal", () => {
    assert.throws(() => canonicalizeDomain("1.2.3.4"), /IP literals/);
  });

  it("rejects empty label", () => {
    assert.throws(() => canonicalizeDomain("example..com"), /empty label/);
  });

  it("rejects label over 63 octets", () => {
    assert.throws(() => canonicalizeDomain("a".repeat(64) + ".com"), /label exceeds 63/);
  });

  it("rejects total over 253 octets", () => {
    const labels = Array.from({ length: 5 }, () => "a".repeat(63));
    assert.throws(() => canonicalizeDomain([...labels, "com"].join(".")), /total length exceeds 253/);
  });
});

describe("normalizeCidr", () => {
  it("normalizes x.x.x.x/32", () => {
    assert.strictEqual(normalizeCidr("192.0.2.1/32"), "192.0.2.1/32");
  });

  it("adds /32 to bare IP", () => {
    assert.strictEqual(normalizeCidr("192.0.2.1"), "192.0.2.1/32");
  });

  it("rejects invalid IP", () => {
    assert.throws(() => normalizeCidr("256.0.0.1"), /Invalid CIDR/);
  });

  it("rejects invalid prefix", () => {
    assert.throws(() => normalizeCidr("192.0.2.0/33"), /Invalid CIDR prefix/);
  });
});

describe("extractNetwork", () => {
  it("returns undefined for empty object", () => {
    const r = extractNetwork({}, "test");
    assert.strictEqual(r.config, undefined);
  });

  it("extracts domains, cidrs, denyCidrs", () => {
    const r = extractNetwork({ domains: ["example.com"], cidrs: ["1.1.1.1"], denyCidrs: ["10.0.0.0/8"] }, "test");
    assert.deepStrictEqual(r.config, { domains: ["example.com"], cidrs: ["1.1.1.1/32"], denyCidrs: ["10.0.0.0/8"] });
  });

  it("warns on unknown keys", () => {
    const r = extractNetwork({ foo: "bar" }, "test");
    assert.strictEqual(r.warnings.length, 1);
    assert.ok(r.warnings[0]?.includes("Unknown key"));
  });

  it("throws on non-array domains", () => {
    assert.throws(() => extractNetwork({ domains: "example.com" }, "test"), /must be an array/);
  });

  it("throws on invalid domain", () => {
    assert.throws(() => extractNetwork({ domains: ["*"] }, "test"), /bare/);
  });

  it("throws on invalid CIDR", () => {
    assert.throws(() => extractNetwork({ cidrs: ["bad"] }, "test"), /Invalid CIDR/);
  });
});

describe("hasNetworkPolicy", () => {
  it("returns false when network is undefined", () => {
    assert.strictEqual(hasNetworkPolicy({}), false);
  });

  it("returns false when network is empty object", () => {
    assert.strictEqual(hasNetworkPolicy({ network: {} }), false);
  });

  it("returns true when network has properties", () => {
    assert.strictEqual(hasNetworkPolicy({ network: { domains: [] } }), true);
  });
});

describe("generateSingBoxConfig", () => {
  it("produces valid structure for deny-all", () => {
    const config = generateSingBoxConfig({});
    const c = config as Record<string, unknown>;
    assert.ok(c.log);
    assert.ok(c.dns);
    assert.ok(c.inbounds);
    assert.ok(c.outbounds);
    assert.ok(c.route);
  });

  it("puts sniff as first route rule", () => {
    const config = generateSingBoxConfig({}) as { route: { rules: unknown[] } };
    const first = config.route.rules[0] as Record<string, unknown>;
    assert.strictEqual(first.action, "sniff");
  });

  it("puts hijack-dns as second route rule", () => {
    const config = generateSingBoxConfig({}) as { route: { rules: unknown[] } };
    const second = config.route.rules[1] as Record<string, unknown>;
    assert.strictEqual(second.action, "hijack-dns");
  });

  it("includes exact domains in dns and route rules", () => {
    const config = generateSingBoxConfig({ domains: ["example.com"] }) as { dns: { rules: unknown[] }; route: { rules: unknown[] } };
    const dnsRule = config.dns.rules.find((r: unknown) => (r as Record<string, unknown>).domain === "example.com");
    const routeRule = config.route.rules.find((r: unknown) => (r as Record<string, unknown>).domain === "example.com");
    assert.ok(dnsRule);
    assert.ok(routeRule);
  });

  it("includes wildcard domains with leading dot", () => {
    const config = generateSingBoxConfig({ domains: ["*.example.com"] }) as { dns: { rules: unknown[] }; route: { rules: unknown[] } };
    const dnsRule = config.dns.rules.find((r: unknown) => (r as Record<string, unknown>).domain_suffix === ".example.com");
    const routeRule = config.route.rules.find((r: unknown) => (r as Record<string, unknown>).domain_suffix === ".example.com");
    assert.ok(dnsRule);
    assert.ok(routeRule);
  });

  it("sorts deny cidrs before allow cidrs at same prefix length", () => {
    const config = generateSingBoxConfig({ cidrs: ["192.0.2.0/24"], denyCidrs: ["192.0.2.0/24"] }) as { route: { rules: unknown[] } };
    const cidrRules = config.route.rules.filter((r: unknown) => (r as Record<string, unknown>).ip_cidr !== undefined);
    assert.strictEqual((cidrRules[0] as Record<string, unknown>).action, "reject");
    assert.strictEqual((cidrRules[1] as Record<string, unknown>).action, "route");
  });

  it("sorts cidrs by prefix length descending", () => {
    const config = generateSingBoxConfig({ cidrs: ["192.0.2.0/16", "192.0.2.0/24"] }) as { route: { rules: unknown[] } };
    const cidrRules = config.route.rules.filter((r: unknown) => (r as Record<string, unknown>).ip_cidr !== undefined);
    const firstPrefix = Number(((cidrRules[0] as Record<string, unknown>).ip_cidr as string[])[0]?.split("/")[1]);
    const secondPrefix = Number(((cidrRules[1] as Record<string, unknown>).ip_cidr as string[])[0]?.split("/")[1]);
    assert.strictEqual(firstPrefix, 24);
    assert.strictEqual(secondPrefix, 16);
  });
});

describeIntegration("sing-box config validation", () => {
  it("passes sing-box check for a representative config", () => {
    const config = generateSingBoxConfig({
      domains: ["example.com", "*.example.com"],
      cidrs: ["1.1.1.1/32", "192.0.2.0/24"],
      denyCidrs: ["192.0.2.128/25"],
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "singbox-check-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    try {
      execSync(
        `docker run --rm -v ${configPath}:/etc/sing-box/config.json:ro ghcr.io/sagernet/sing-box:v1.12.0 check -c /etc/sing-box/config.json`,
        { stdio: "pipe" },
      );
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`sing-box check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
