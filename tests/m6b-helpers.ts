// Shared by tests/m6b-*.test.ts (track M, M6b; plan §19): files in a temp project, a sandbox dir with a local file,
// and the column and table fixtures of the `sandbox-data` grammar tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Col, Refusal, Table } from '../lib/sandbox-data';

/** `p` written with `text`, its parent dirs made; returns `p`. */
export function put(p: string, text = 'x'): string {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** `root/.goodboy/sandbox/` with a compose file and, unless `local` is null, a `local.json` (a string is written as it is). */
export function sandboxIn(root: string, local: unknown): void {
  mkdirSync(join(root, '.goodboy', 'sandbox'), { recursive: true });
  writeFileSync(join(root, '.goodboy', 'sandbox', 'compose.yml'), 'services: {}\n');
  if (local !== null) writeFileSync(join(root, '.goodboy', 'sandbox', 'local.json'), typeof local === 'string' ? local : JSON.stringify(local));
}

export const col = (name: string, type: string, cls: Col['cls'], pk = 0): Col => ({ name, type, cls, nullable: true, pk, fk: false });

export const isRefusal = (v: unknown): v is Refusal => typeof v === 'object' && v !== null && 'reason' in v;

/** The `users` table of the grammar tests: one of each column kind. */
export const usersTable: Table = {
  name: 'users',
  ref: '"public"."users"',
  cols: [col('id', 'integer', 'numeric', 1), col('name', 'text', 'text'), col('status', 'text', 'text'), col('created', 'timestamp without time zone', 'temporal'), col('active', 'boolean', 'bool'), col('uid', 'uuid', 'uuid')],
};
