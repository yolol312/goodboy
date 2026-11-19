// Track M, M7 (release review, G4: commit scan and records): regression tests for its findings. Each block names its item:
// 1 a heredoc paired with a commit by order, 2 the no-reply exemption that hid a number, 3 hashes read as numbers, 4 the
// keyword secret (placeholders and compound names), 5 the backfill note, 6 `rtk git commit -F -`.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Acc } from '../lib/commit-scan';
import { commitScanOfCommand, type GuardResult } from '../lib/commit-scan-guard';
import { findSensitive, redactText } from '../lib/pii-patterns';
import { emptyBackfill, markTarget } from '../lib/test-backfill';
import { CANARY, cleanup, type Fixture, fixture, useEnv } from './m6f-helpers';

setDefaultTimeout(60_000);

let f: Fixture;
let undo: () => void;
beforeEach(() => {
  f = fixture({ realData: true });
  undo = useEnv(f);
});
afterEach(() => {
  undo();
  cleanup();
});

const scan = (command: string): GuardResult | null => commitScanOfCommand(command, f.repo, f.repo, { env: f.env });
const where = (r: GuardResult | null) => (r?.report.hits ?? []).map((h) => `${h.path}:${h.line} ${h.kind}`);
const whys = (r: GuardResult | null): string => (r?.report.unscanned ?? []).map((u) => u.why).join(' | ');
const NOT_HEREDOC = 'exactly one heredoc of this commit';

describe('item 1: stdin commits and heredocs are paired by order only when the counts match', () => {
  test('a commit fed by a pipe next to a --dry-run commit with a heredoc: the real one is not scanned, not given the decoy', () => {
    const c = 'cat real.csv | git commit --allow-empty -F - ; git commit --allow-empty --dry-run -F - <<EOF\nclean #1\nEOF';
    const r = scan(c);
    expect(r?.report.blocked).toBe(true);
    expect(whys(r)).toContain(NOT_HEREDOC);
  });

  test('more heredocs than stdin commits, and fewer: every stdin commit is not scanned', () => {
    const more = scan("git commit --allow-empty -F - < real.txt ; cat <<EOF | git commit --allow-empty -m x\nclean #1\nEOF\ncat <<EOF | tee out\nb\nEOF");
    expect(more?.report.blocked).toBe(true);
    const fewer = scan(`git commit --allow-empty -F - <<EOF\nfix #1 ${CANARY.phone}\nEOF\ngit commit --allow-empty -F -`);
    expect(whys(fewer)).toContain(NOT_HEREDOC);
    // a heredoc the commit reads is not read once the counts differ
    expect(where(fewer)).toEqual([]);
  });

  test('equal counts still pair in order, and a command with no stdin commit is untouched', () => {
    const both = scan(`git commit --allow-empty -F - <<EOF\nfix #1 ${CANARY.phone}\nEOF\ngit commit --allow-empty -F - <<EOF\nmore ${CANARY.card}\nEOF\n`);
    expect(where(both).sort()).toEqual(['<commit message>:1 card', '<commit message>:1 phone']);
    expect(whys(both)).toBe('');
    expect(scan('cat <<EOF >/dev/null\nx\nEOF\ngit commit --allow-empty -m "x #1"')).toBeNull();
  });
});

describe('item 2: a no-reply address hides no number and takes only a plain tag', () => {
  const hits = (text: string): string[] => {
    const acc = new Acc();
    acc.text('<commit message>', 'k', text, new Set());
    return acc.report().hits.map((h) => `${h.line} ${h.kind}`);
  };

  test('a resident number or a phone in the tag is a hit of its own kind, never the email', () => {
    expect(hits(`Co-authored-by: A <noreply+${CANARY.rrn}@x.com>`)).toEqual(['1 resident-number']);
    expect(hits(`Co-authored-by: A <noreply+${CANARY.phone}@x.com>`)).toEqual(['1 phone']);
    expect(hits(`x\nCo-authored-by: A <no-reply+9001011234567@x.com>`)).toEqual(['2 resident-number']);
    expect(hits(`A <${CANARY.rrn}@users.noreply.github.com>`)).toEqual(['1 resident-number']);
    expect(hits(`A <${CANARY.card}@users.noreply.github.com>`)).toEqual(['1 card']);
    // an id longer than GitHub's is no id: the address is an email hit
    expect(hits(`A <${CANARY.card}+user@users.noreply.github.com>`)).toEqual(['1 email']);
  });

  test('a tag with other characters is no no-reply address: it is an email hit', () => {
    expect(hits('A <noreply+a%b@x.com>')).toEqual(['1 email']);
    expect(hits(`A <noreply+${'a'.repeat(65)}@x.com>`)).toEqual(['1 email']);
  });

  test('the real no-reply forms stay exempt', () => {
    for (const a of ['noreply@anthropic.com', 'no-reply@x.io', 'noreply+ci.bot-2@x.io', '12345678+someone@users.noreply.github.com', 'someone@users.noreply.github.com']) {
      expect([a, hits(`Co-authored-by: A <${a}>`)]).toEqual([a, []]);
    }
  });
});

describe('item 3: a hash is no number', () => {
  // mulberry32: the same hashes on every run
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hex = (next: () => number, n: number): string => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(next() * 16)]).join('');
  const uuid = (next: () => number): string => [8, 4, 4, 4, 12].map((n) => hex(next, n)).join('-');
  const b64 = (next: () => number, n: number): string => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[Math.floor(next() * 64)]).join('');

  test('10 000 random sha256, sha1, sha512, uuids with and without dashes: no hit', () => {
    const next = rng(20261119);
    const bad: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      for (const h of [hex(next, 64), hex(next, 40), hex(next, 128), uuid(next), uuid(next).replaceAll('-', '')]) {
        if (findSensitive(h).length > 0) bad.push(h);
      }
    }
    expect(bad.slice(0, 3)).toEqual([]);
    expect(bad.length).toBe(0);
  });

  test('a synthetic yarn.lock of 400 entries: no hit', () => {
    const next = rng(7);
    const lines: string[] = ['# yarn lockfile v1', ''];
    for (let i = 0; i < 400; i++) {
      lines.push(`"pkg-${i}@^1.${i}.0":`, `  version "1.${i}.0"`, `  resolved "https://registry.yarnpkg.com/pkg-${i}/-/pkg-${i}-1.${i}.0.tgz#${hex(next, 40)}"`, `  integrity sha512-${b64(next, 86)}==`, '');
    }
    expect(findSensitive(lines.join('\n')).map((s) => s.kind)).toEqual([]);
  });

  test('a number is still a number: next to a short hex run, in a lockfile, and as a lone digit run in a long word', () => {
    // 31 hex characters around it: not a hash
    expect(findSensitive(`${'a'.repeat(9)}9001011234567${'b'.repeat(9)}`).map((s) => s.kind)).toEqual(['resident-number']);
    expect(findSensitive(`resolved "x#${'ab'.repeat(20)}"\ncontact ${CANARY.rrn} ${CANARY.phone}\n`).map((s) => s.kind)).toEqual(['resident-number', 'phone']);
    expect(redactText(`sha ${'0123456789abcdef'.repeat(4)} card ${CANARY.card}`)).toBe(`sha ${'0123456789abcdef'.repeat(4)} card [redacted:card]`);
    // a uuid-shaped text with the wrong group sizes is no uuid
    expect(findSensitive('1234-5678-9012-3456').map((s) => s.kind)).toEqual([]);
    expect(findSensitive(`id 0123-${CANARY.phone}-ab`).map((s) => s.kind)).toEqual(['phone']);
  });
});

describe('item 4: the keyword secret, placeholders and compound names', () => {
  const secret = (text: string): boolean => findSensitive(text).some((s) => s.kind === 'secret');

  test('a reference to the environment is no secret', () => {
    for (const t of [
      'password: process.env.DB_PASSWORD',
      'secret: ${SECRET}',
      'token="${TOKEN}"',
      'password = os.environ["DB_PASS"]',
      "pwd = os.environ.get('PW')",
      'password: os.getenv("X")',
      'password = System.getenv("DB_PASS");',
      'token = process.env.API_TOKEN,',
      'token: process.env["T"] // the token',
      'secret: ${jwt.secret}',
      'secret: ${app.jwt-secret}',
    ]) {
      expect([t, secret(t)]).toEqual([t, false]);
    }
  });

  test('anything more than the reference stays a secret: a default, a suffix, a quoted string, a bare $word', () => {
    for (const t of [
      'password: process.env.X || "hunter2xyz"',
      'password: process.env.X ?? "hunter2xyz"',
      'password: ${X:-hunter2xyz}',
      'password: ${X-hunter2xyz}',
      'POSTGRES_PASSWORD: ${DB_PASSWORD-s3cretpw}',
      'password: ${DB_PASS-hunter2.prod}',
      'POSTGRES_PASSWORD=${DB_PASS-Sup3r.S3cret9}',
      'password: "${DB_PASS-hunter2.prod}"',
      'token="${abc}xyz123"',
      'token: "process.env.TOKEN"',
      'password=$ecret123',
      'token = process.env.X.length9',
      'password = os.environ.get("X", "hunter2xyz")',
    ]) {
      expect([t, secret(t)]).toEqual([t, true]);
    }
  });

  test('a name that ends in secret or key words is read: SECRET_KEY, secret_key, JWT_SECRET_KEY, jwt.secret-key, private_key, privateKey', () => {
    for (const t of ['SECRET_KEY=abcdef123456', 'secret_key=abcdef123456', 'JWT_SECRET_KEY=abcdef123456', 'jwt.secret-key: abcdef123456', 'private_key=abcdef123456', 'privateKey: "abcdef123456"', "SECRET_KEY = 'django-insecure-x7k2'"]) {
      expect([t, secret(t)]).toEqual([t, true]);
    }
    // a type, a reference and a longer name are none
    for (const t of ['private_key: string', 'privateKey: String', 'SECRET_KEY=${SECRET_KEY}', 'private_key_path = /etc/ssl/key.pem', 'secret_key_base_len = 12']) {
      expect([t, secret(t)]).toEqual([t, false]);
    }
  });
});

describe('item 5: the backfill note passes the sanitizer', () => {
  test('personal data and a secret in --note are redacted before they are stored', () => {
    const s = emptyBackfill();
    s.targets = [{ rel: 'src/b.ts', kind: 'code', needs: ['any'], why: 'w', bytes: 1, status: 'todo' }];
    const note = `needs the gateway; ask ${CANARY.email}, ${CANARY.phone}, key ${CANARY.secret}`;
    expect(markTarget(s, f.repo, f.repo, { rel: 'src/b.ts', status: 'skipped', tests: [], note }, undefined, [])).toBeNull();
    const stored = s.targets[0]!.note!;
    expect(stored).toBe('needs the gateway; ask [redacted:email], [redacted:phone], key [redacted:secret]');
    expect(JSON.stringify(s)).not.toContain(CANARY.phone);
  });
});

describe('item 6: `rtk git commit -F -` reads its heredoc like `git commit`', () => {
  test('the rtk proxy before git does not make the stdin commit unreadable', () => {
    for (const c of [`rtk git commit --allow-empty -F - <<EOF\nfix #1 ${CANARY.phone}\nEOF`, `cat <<EOF | rtk git commit --allow-empty -F -\nfix #1 ${CANARY.phone}\nEOF`]) {
      const r = scan(c);
      expect([c, where(r), whys(r)]).toEqual([c, ['<commit message>:1 phone'], '']);
    }
    expect(scan('rtk git commit --allow-empty -F - <<EOF\nfix #1\nEOF')).toBeNull();
  });
});
