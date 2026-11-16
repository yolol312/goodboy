// Track M, M6b (plan §19): the grammar of `sandbox-data` (lib/sandbox-data.ts): every operation, what is refused
// and why, and that no refusal echoes what the caller wrote.

import { describe, expect, test } from 'bun:test';
import { checkCond, type Cond, parseOp, parseWhere, type Refusal } from '../lib/sandbox-data';
import { isRefusal, usersTable as users } from './m6b-helpers';

const CANARY = 'Canary-Kim-0101234567';

const where = (json: unknown): Cond => {
  const c = parseWhere(JSON.stringify(json));
  if (isRefusal(c)) throw new Error(`refused: ${JSON.stringify(c)}`);
  return c;
};
const refusal = (json: string): Refusal => {
  const c = parseWhere(json);
  if (!isRefusal(c)) throw new Error('not refused');
  return c;
};

describe('the operations', () => {
  test('schema takes no argument', () => {
    expect(parseOp(['schema'])).toEqual({ op: 'schema' });
    expect(parseOp(['schema', 'users'])).toEqual({ field: 'args', reason: 'unexpected' });
  });

  test('shape takes one <table>.<col>, with a schema in front of the table when there is one', () => {
    expect(parseOp(['shape', 'users.email'])).toEqual({ op: 'shape', table: 'users', col: 'email' });
    expect(parseOp(['shape', 'audit.log.msg'])).toEqual({ op: 'shape', table: 'audit.log', col: 'msg' });
    expect(parseOp(['shape', 'users'])).toEqual({ field: 'column', reason: 'missing' });
    expect(parseOp(['shape'])).toEqual({ field: 'table', reason: 'missing' });
    expect(parseOp(['shape', 'a.b.c.d'])).toEqual({ field: 'table', reason: 'bad-name' });
    expect(parseOp(['shape', 'users.email', 'more'])).toEqual({ field: 'args', reason: 'unexpected' });
    expect(parseOp(['shape', 'users.email', '--where', '{}'])).toEqual({ field: 'option', reason: 'unknown-option' });
  });

  test('count takes a table and an optional --where, in either spelling', () => {
    expect(parseOp(['count', 'users'])).toEqual({ op: 'count', table: 'users', where: null });
    const a = parseOp(['count', 'users', '--where', '{"col":"id","op":"not-null"}']);
    const b = parseOp(['count', 'users', '--where={"col":"id","op":"not-null"}']);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ op: 'count', table: 'users', where: { kind: 'leaf', col: 'id', op: 'not-null' } });
    expect(parseOp(['count'])).toEqual({ field: 'table', reason: 'missing' });
    expect(parseOp(['count', 'users', '--where'])).toEqual({ field: '--where', reason: 'missing' });
    expect(parseOp(['count', 'users', '--n', '3'])).toEqual({ field: 'option', reason: 'unknown-option' });
    expect(parseOp(['count', 'users', '--where', '{"col":"id","op":"not-null"}', '--where', '{}'])).toEqual({ field: '--where', reason: 'unexpected' });
  });

  test('pick needs a --where, and --n is 1 to 20 (5 when not given)', () => {
    const w = '{"col":"id","op":"not-null"}';
    expect(parseOp(['pick', 'users', '--where', w])).toMatchObject({ op: 'pick', table: 'users', n: 5 });
    expect(parseOp(['pick', 'users', '--where', w, '--n', '20'])).toMatchObject({ n: 20 });
    expect(parseOp(['pick', 'users', '--where', w, '--n=1'])).toMatchObject({ n: 1 });
    for (const n of ['0', '21', '-1', '1.5', 'x', '', '0001e1']) expect(parseOp(['pick', 'users', '--where', w, '--n', n])).toEqual({ field: '--n', reason: 'bad-number' });
    expect(parseOp(['pick', 'users'])).toEqual({ field: 'where', reason: 'missing' });
  });

  test('an unknown op and a bad table name are refused without a word of the input', () => {
    expect(parseOp([])).toEqual({ field: 'op', reason: 'unknown-op' });
    expect(parseOp(['select', CANARY])).toEqual({ field: 'op', reason: 'unknown-op' });
    for (const t of [`${CANARY}; DROP TABLE x`, "users'", 'us ers', '1users', '', 'a'.repeat(64), '"users"', 'users;--']) {
      const r = parseOp(['count', t]);
      expect(r).toEqual({ field: 'table', reason: 'bad-name' });
      expect(JSON.stringify(r)).not.toContain('DROP');
    }
  });
});

describe('the condition', () => {
  test('every leaf operator', () => {
    expect(where({ col: 'name', op: 'is-null' })).toMatchObject({ kind: 'leaf', op: 'is-null' });
    expect(where({ col: 'name', op: 'not-null' })).toMatchObject({ kind: 'leaf', op: 'not-null' });
    expect(where({ col: 'name', op: 'shape', value: 'email-like' })).toMatchObject({ op: 'shape', value: 'email-like' });
    for (const op of ['<', '>', '<=', '>=']) expect(where({ col: 'id', op, value: 5 })).toMatchObject({ op, value: 5 });
    expect(where({ col: 'created', op: '<', value: '2024-01-31' })).toMatchObject({ value: '2024-01-31' });
    expect(where({ col: 'created', op: '>=', value: '2024-01-31T10:20:30' })).toMatchObject({ value: '2024-01-31T10:20:30' });
    expect(where({ col: 'status', op: '=', value: 'ACTIVE' })).toMatchObject({ op: '=', value: 'ACTIVE' });
    expect(where({ col: 'status', op: '!=', value: 'it\'s' })).toMatchObject({ op: '!=' });
    expect(where({ col: 'id', op: '=', value: 7 })).toMatchObject({ value: 7 });
    expect(where({ col: 'active', op: '=', value: true })).toMatchObject({ value: true });
  });

  test('and and or nest within the caps', () => {
    const c = where({ and: [{ col: 'id', op: 'not-null' }, { or: [{ col: 'name', op: 'is-null' }, { col: 'status', op: '=', value: 'A' }] }] });
    expect(c).toMatchObject({ kind: 'and', items: [{ kind: 'leaf' }, { kind: 'or', items: [{ kind: 'leaf' }, { kind: 'leaf' }] }] });
    // depth 4 is the most
    let deep: unknown = { col: 'id', op: 'not-null' };
    for (let i = 0; i < 3; i++) deep = { and: [deep] };
    expect(parseWhere(JSON.stringify(deep))).toMatchObject({ kind: 'and' });
    expect(refusal(JSON.stringify({ and: [deep] }))).toMatchObject({ reason: 'too-deep' });
    // ten children at most, and twenty nodes in all
    expect(refusal(JSON.stringify({ and: Array.from({ length: 11 }, () => ({ col: 'id', op: 'not-null' })) })).reason).toBe('bad-shape');
    const many = { and: Array.from({ length: 4 }, () => ({ or: Array.from({ length: 5 }, () => ({ col: 'id', op: 'not-null' })) })) };
    expect(refusal(JSON.stringify(many)).reason).toBe('too-many-nodes');
    // a text over 4 KiB, and one that is no JSON
    expect(refusal(JSON.stringify({ col: 'id', op: '=', value: 'x'.repeat(5000) })).reason).toBe('too-large');
    expect(refusal('{"col": ').reason).toBe('bad-json');
  });

  test('the refusals name the field and a fixed reason', () => {
    expect(refusal('[]')).toEqual({ field: 'where', reason: 'bad-shape' });
    expect(refusal('{"and":[]}')).toEqual({ field: 'where.and', reason: 'bad-shape' });
    expect(refusal('{"and":[{"col":"id","op":"not-null"}],"or":[]}')).toEqual({ field: 'where.and', reason: 'bad-shape' });
    expect(refusal('{"and":[{"col":"id","op":"not-null"},{"col":"id","op":"zap"}]}')).toEqual({ field: 'where.and[1].op', reason: 'bad-op' });
    expect(refusal('{"and":[{"col":"id"}]}')).toEqual({ field: 'where.and[0].op', reason: 'missing' });
    expect(refusal('{"op":"not-null"}')).toEqual({ field: 'where.col', reason: 'missing' });
    expect(refusal('{"col":"id","op":"not-null","extra":1}')).toEqual({ field: 'where', reason: 'bad-shape' });
    expect(refusal('{"col":"id","op":"not-null","value":1}')).toEqual({ field: 'where.value', reason: 'unexpected' });
    expect(refusal('{"col":"id","op":"="}')).toEqual({ field: 'where.value', reason: 'missing' });
    expect(refusal('{"col":"id","op":"shape","value":"ssn"}')).toEqual({ field: 'where.value', reason: 'bad-value' });
    expect(refusal('{"col":"id","op":"<","value":"yesterday"}')).toEqual({ field: 'where.value', reason: 'bad-value' });
    expect(refusal('{"col":"id","op":"<","value":true}')).toEqual({ field: 'where.value', reason: 'bad-value' });
    expect(refusal('{"col":"id","op":">","value":1e30}')).toEqual({ field: 'where.value', reason: 'bad-value' });
    expect(refusal('{"col":"id","op":"=","value":null}')).toEqual({ field: 'where.value', reason: 'bad-value' });
    expect(refusal('{"col":"id","op":"=","value":{"a":1}}')).toEqual({ field: 'where.value', reason: 'bad-value' });
    expect(refusal('{"col":1,"op":"not-null"}')).toEqual({ field: 'where.col', reason: 'missing' });
  });

  test('a column name that is no identifier, and a value goodboy would not quote, are refused', () => {
    for (const c of ['id; DROP', 'a b', '"x"', 'x"y', '1x', '', 'a'.repeat(64), 'ü']) {
      expect(refusal(JSON.stringify({ col: c, op: 'not-null' })).reason).toBe('bad-name');
    }
    for (const v of ['a\\b', 'a\u0000b', 'line\nbreak', 'tab\tx', 'x'.repeat(65), '\ud800']) {
      expect(refusal(JSON.stringify({ col: 'status', op: '=', value: v })).reason).toBe('bad-value');
    }
    // 64 characters, quotes and non-ASCII letters are fine (the quote is doubled when it is written)
    expect(parseWhere(JSON.stringify({ col: 'status', op: '=', value: 'x'.repeat(64) }))).toMatchObject({ kind: 'leaf' });
    expect(parseWhere(JSON.stringify({ col: 'status', op: '=', value: '대기 O\'Neil' }))).toMatchObject({ kind: 'leaf' });
  });

  test('a date must be a real date shape', () => {
    for (const d of ['2024-13-01', '2024-00-10', '2024-02-32', '2024-1-1', '24-01-01', '2024-01-01T25:00', '2024-01-01 10:61', '2024-01-01Z']) {
      expect(refusal(JSON.stringify({ col: 'created', op: '<', value: d })).reason).toBe('bad-value');
    }
  });

  test('a date must exist on the calendar: 2024-02-30 has the shape and the database refuses it, so it is refused here', () => {
    for (const d of ['2024-02-30', '2023-02-29', '2024-04-31', '2024-06-31', '2023-11-31', '2100-02-29', '2024-02-30T10:00']) {
      expect([d, refusal(JSON.stringify({ col: 'created', op: '<', value: d })).reason]).toEqual([d, 'bad-value']);
    }
    for (const d of ['2024-02-29', '2000-02-29', '2023-02-28', '2024-04-30', '2024-12-31', '2024-02-29 23:59:59']) {
      expect(parseWhere(JSON.stringify({ col: 'created', op: '<', value: d }))).toMatchObject({ kind: 'leaf' });
    }
    // `=` on a date column takes a date only: the same check
    expect(checkCond(users, where({ col: 'created', op: '=', value: '2024-02-28' }))).toEqual({ enumCols: new Map([['created', 'where']]) });
  });

  test('no refusal echoes the value, the column or the table that was written', () => {
    const attempts = [
      JSON.stringify({ col: CANARY, op: 'not-null' }),
      JSON.stringify({ col: 'id', op: CANARY }),
      JSON.stringify({ col: 'id', op: '=', value: `${CANARY}\\` }),
      JSON.stringify({ col: 'id', op: 'shape', value: CANARY }),
      JSON.stringify({ and: [{ col: 'id', op: '<', value: CANARY }] }),
      JSON.stringify({ [CANARY]: 1 }),
      `{"col":"${CANARY}`,
    ];
    for (const a of attempts) expect(JSON.stringify(parseWhere(a))).not.toContain(CANARY);
    for (const args of [[CANARY], ['count', CANARY], ['shape', `${CANARY}.x`], ['pick', 'users', '--where', attempts[0]!], ['count', 'users', `--${CANARY}`, 'x']]) {
      expect(JSON.stringify(parseOp(args))).not.toContain(CANARY);
    }
  });
});

describe('the condition against the table', () => {
  const check = (json: unknown) => checkCond(users, where(json));

  test('a column that is not in the table is refused at its path', () => {
    expect(check({ and: [{ col: 'id', op: 'not-null' }, { col: 'nope', op: 'is-null' }] })).toEqual({ field: 'where.and[1].col', reason: 'unknown-column' });
  });

  test('comparisons are for numbers and dates, each on a column of that kind', () => {
    expect(check({ col: 'id', op: '<', value: 5 })).toEqual({ enumCols: new Map() });
    expect(check({ col: 'created', op: '>', value: '2024-01-01' })).toEqual({ enumCols: new Map() });
    expect(check({ col: 'name', op: '<', value: 5 })).toEqual({ field: 'where.value', reason: 'bad-type' });
    expect(check({ col: 'id', op: '<', value: '2024-01-01' })).toEqual({ field: 'where.value', reason: 'bad-type' });
    expect(check({ col: 'created', op: '<', value: 3 })).toEqual({ field: 'where.value', reason: 'bad-type' });
    expect(check({ col: 'uid', op: '>', value: 3 })).toEqual({ field: 'where.value', reason: 'bad-type' });
  });

  test('= and != fit the type of the column and ask for the enum-like check', () => {
    expect(check({ col: 'status', op: '=', value: 'A' })).toEqual({ enumCols: new Map([['status', 'where']]) });
    expect(check({ and: [{ col: 'status', op: '!=', value: 'A' }, { col: 'status', op: '=', value: 'B' }, { col: 'active', op: '=', value: true }] })).toEqual({
      enumCols: new Map([['status', 'where.and[0]'], ['active', 'where.and[2]']]),
    });
    expect(check({ col: 'status', op: '=', value: 3 })).toEqual({ field: 'where.value', reason: 'bad-type' });
    expect(check({ col: 'id', op: '=', value: 'x' })).toEqual({ field: 'where.value', reason: 'bad-type' });
    expect(check({ col: 'active', op: '=', value: 'true' })).toEqual({ field: 'where.value', reason: 'bad-type' });
    expect(check({ col: 'uid', op: '=', value: '123e4567-e89b-12d3-a456-426614174000' })).toEqual({ field: 'where.value', reason: 'bad-type' });
    // a date column takes a date only
    expect(check({ col: 'created', op: '=', value: '2024-01-01' })).toEqual({ enumCols: new Map([['created', 'where']]) });
    expect(check({ col: 'created', op: '=', value: 'soon' })).toEqual({ field: 'where.value', reason: 'bad-type' });
  });

  test('is-null, not-null and shape fit any column', () => {
    for (const c of users.cols) {
      expect(check({ col: c.name, op: 'is-null' })).toEqual({ enumCols: new Map() });
      expect(check({ col: c.name, op: 'shape', value: 'other' })).toEqual({ enumCols: new Map() });
    }
  });
});
