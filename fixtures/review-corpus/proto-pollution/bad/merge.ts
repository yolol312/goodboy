// BAD fixture. Seeded prototype-pollution defect:
//   setByPath() walks a dotted key path from an untrusted parsed body and
//   assigns into nested objects WITHOUT filtering dangerous segments. A body of
//   { "__proto__.polluted": true } (or {"constructor.prototype.polluted":true})
//   walks target["__proto__"] — which IS Object.prototype — and sets `polluted`
//   on it, so EVERY object in the process gains `.polluted === true`.
//   This is the classic, JSON-survivable prototype-pollution vector (same shape
//   as a vulnerable lodash.set / qs-style param expander).
//
// Expected review finding: dimension proto-pollution, severity high.

export interface Settings {
  theme?: string;
  locale?: string;
  [key: string]: unknown;
}

/** Assign value at a dotted path, creating intermediate objects as needed. */
function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    // DEFECT: no __proto__ / constructor / prototype guard on `seg`.
    if (typeof node[seg] !== 'object' || node[seg] === null) {
      node[seg] = {};
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
