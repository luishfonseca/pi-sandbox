export interface NetworkConfig {
  domains?: string[];
  cidrs?: string[];
  denyCidrs?: string[];
}

function validateDomainLabels(d: string): void {
  const labels = d.split('.');
  if (labels.some((l) => l.length === 0)) {
    throw new Error(`Invalid domain: empty label: ${d}`);
  }
  if (labels.some((l) => l.length > 63)) {
    throw new Error(`Invalid domain: label exceeds 63 octets: ${d}`);
  }
  if (d.length > 253) {
    throw new Error(`Invalid domain: total length exceeds 253 octets: ${d}`);
  }
}

export function canonicalizeDomain(domain: string): { type: 'exact' | 'wildcard'; value: string } {
  let d = domain.toLowerCase();
  if (d.endsWith('.')) d = d.slice(0, -1);

  if (d === '*') throw new Error(`Invalid domain: bare "*" is not allowed`);

  if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) {
    throw new Error(`Invalid domain: IP literals are not allowed: ${domain}`);
  }

  if (d.includes('*')) {
    if (!d.startsWith('*.')) {
      throw new Error(`Invalid domain: wildcard must be "*.example.com", got ${domain}`);
    }
    const rest = d.slice(2);
    if (rest.includes('*')) {
      throw new Error(`Invalid domain: embedded wildcard not allowed: ${domain}`);
    }
    validateDomainLabels(rest);
    return { type: 'wildcard', value: '.' + rest };
  }

  validateDomainLabels(d);
  return { type: 'exact', value: d };
}

export function normalizeCidr(cidr: string): string {
  const [ipPart, prefixPart] = cidr.split('/');
  if (!ipPart) throw new Error(`Invalid CIDR: ${cidr}`);

  const parts = ipPart.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }

  let prefix: number;
  if (prefixPart === undefined) {
    prefix = 32;
  } else {
    prefix = Number(prefixPart);
    if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
      throw new Error(`Invalid CIDR prefix: ${cidr}`);
    }
  }

  return `${parts.join('.')}/${String(prefix)}`;
}

const NETWORK_KEYS = new Set(['domains', 'cidrs', 'denyCidrs']);

const PRIVATE_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
];

export function extractNetwork(
  value: unknown,
  context: string,
): { config?: NetworkConfig | undefined; warnings: string[] } {
  if (value === undefined) {
    return { warnings: [] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`network in ${context} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const warnings: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!NETWORK_KEYS.has(key)) {
      warnings.push(`[pi-sandbox] Unknown key "${key}" in ${context}#network — ignoring`);
    }
  }

  const validKeys = Object.keys(obj).filter((k) => NETWORK_KEYS.has(k));
  if (validKeys.length === 0) {
    return { config: undefined, warnings };
  }

  const result: NetworkConfig = {};

  if (obj.domains !== undefined) {
    if (!Array.isArray(obj.domains))
      throw new Error(`network.domains in ${context} must be an array`);
    const domains: string[] = [];
    for (const d of obj.domains) {
      if (typeof d !== 'string' || d.length === 0) {
        throw new Error(`network.domains in ${context} must be an array of non-empty strings`);
      }
      canonicalizeDomain(d);
      domains.push(d.toLowerCase().replace(/\.$/, ''));
    }
    result.domains = domains;
  }

  if (obj.cidrs !== undefined) {
    if (!Array.isArray(obj.cidrs)) throw new Error(`network.cidrs in ${context} must be an array`);
    result.cidrs = obj.cidrs.map((c) => normalizeCidr(String(c)));
  }

  if (obj.denyCidrs !== undefined) {
    if (!Array.isArray(obj.denyCidrs))
      throw new Error(`network.denyCidrs in ${context} must be an array`);
    result.denyCidrs = obj.denyCidrs.map((c) => normalizeCidr(String(c)));
  }

  return { config: result, warnings };
}

export function generateSingBoxConfig(network: NetworkConfig): unknown {
  const domains = network.domains ?? [];
  const cidrs = network.cidrs ?? [];
  const denyCidrs = network.denyCidrs ?? [];

  const exactDomains: string[] = [];
  const wildcardDomains: string[] = [];

  for (const d of domains) {
    const canonical = canonicalizeDomain(d);
    if (canonical.type === 'exact') {
      exactDomains.push(canonical.value);
    } else {
      wildcardDomains.push(canonical.value);
    }
  }

  wildcardDomains.sort((a, b) => b.length - a.length);

  const cidrEntries = [
    ...PRIVATE_CIDRS.map((c) => ({ cidr: c, deny: true as const })),
    { cidr: '::/0', deny: true as const },
    ...denyCidrs.map((c) => ({ cidr: c, deny: true as const })),
    ...cidrs.map((c) => ({ cidr: c, deny: false as const })),
  ];
  cidrEntries.sort((a, b) => {
    const pa = Number(a.cidr.split('/')[1]);
    const pb = Number(b.cidr.split('/')[1]);
    if (pb !== pa) return pb - pa;
    return a.deny === b.deny ? 0 : a.deny ? -1 : 1;
  });

  const dnsRules: unknown[] = [];
  for (const d of exactDomains) {
    dnsRules.push({ domain: d, action: 'route', server: 'upstream' });
  }
  for (const d of wildcardDomains) {
    dnsRules.push({ domain_suffix: d, action: 'route', server: 'upstream' });
  }
  dnsRules.push({ action: 'reject' });

  const routeRules: unknown[] = [
    { inbound: ['tun-in'], action: 'sniff' },
    { port: [53], action: 'hijack-dns' },
  ];

  for (const entry of cidrEntries) {
    if (entry.deny) {
      routeRules.push({ ip_cidr: [entry.cidr], action: 'reject' });
    } else {
      routeRules.push({ ip_cidr: [entry.cidr], action: 'route', outbound: 'direct' });
    }
  }

  for (const d of exactDomains) {
    routeRules.push({ domain: d, action: 'route', outbound: 'direct' });
  }
  for (const d of wildcardDomains) {
    routeRules.push({ domain_suffix: d, action: 'route', outbound: 'direct' });
  }
  routeRules.push({ action: 'reject' });

  return {
    log: { level: 'warn' },
    dns: {
      servers: [{ tag: 'upstream', type: 'udp', server: '1.1.1.1' }],
      rules: dnsRules,
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'sb-tun0',
        address: ['198.18.0.1/30'],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: 'system',
        sniff: true,
        sniff_override_destination: true,
      },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: {
      rules: routeRules,
      auto_detect_interface: true,
      default_domain_resolver: 'upstream',
    },
  };
}

export function hasNetworkPolicy(config: { network?: NetworkConfig }): boolean {
  return config.network !== undefined && Object.keys(config.network).length > 0;
}

export function checkBuiltInDenyOverlaps(network: NetworkConfig): string[] {
  const warnings: string[] = [];
  const builtInSet = new Set(PRIVATE_CIDRS);
  for (const cidr of network.cidrs ?? []) {
    if (builtInSet.has(cidr)) {
      warnings.push(
        `[pi-sandbox] CIDR "${cidr}" in network.cidrs matches a built-in private-range deny rule. ` +
          `Because built-in denies win ties at the same prefix length, this allow will be blocked. ` +
          `Use a more specific prefix (e.g. "${cidr.replace(/\/\d+$/, '/32')}") if you need to allow a specific host.`,
      );
    }
  }
  return warnings;
}
