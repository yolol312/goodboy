// GOOD fixture. The prototype-pollution defect is fixed: setByPath() rejects any
// path segment that is a dangerous key (__proto__/constructor/prototype) and
// uses Object.create(null) / hasOwnProperty so an untrusted dotted path can
// never reach Object.prototype. A body of { "__proto__.polluted": true } is
// dropped and pollutes nothing.
//
// A review probe should find NO prototype-pollution issue.

export interface Settings {
  theme?: string;
  locale?: string;
  [key: string]: unknown;
}

const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  if (parts.some((seg) => DANGEROUS.has(seg))) return; // reject the whole path
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (
      !Object.prototype.hasOwnProperty.call(node, seg) ||
      typeof node[seg] !== 'object' ||
      node[seg] === null
    ) {
      node[seg] = Object.create(null) as Record<string, unknown>;
    }
    node = node[seg] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/** Merge an untrusted, already-parsed JSON body (flat dotted keys) into target. */
export function mergeBody(target: Settings, body: unknown): Settings {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [path, value] of Object.entries(body as Record<string, unknown>)) {
      setByPath(target as Record<string, unknown>, path, value);
    }
  }
  return target;
}

/** Convenience: parse a raw JSON string and merge it into settings. */
export function applyJson(target: Settings, raw: string): Settings {
  const body = JSON.parse(raw);
  return mergeBody(target, body);
}
