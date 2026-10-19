import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureSessionDir } from '../lib/file-tracker';
import { logGate } from '../lib/gate-log';
import {
  claudeCodeVersion,
  collectEvidence,
  type Evidence,
  type FieldReportInput,
  findSession,
  privateTerms,
  publicLeaks,
  validateFieldReport,
  writeFieldReport,
} from '../lib/field-report';

// Track J, J1 (#8, plan §16): the report-goodboy skill's CLI side — the template, the session's
// evidence, the public summary's check and the inbox write.

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-j1-')));
  dirs.push(d);
  return d;
}
function uuid(): string {
  return crypto.randomUUID();
}
function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

const REPORT: FieldReportInput = {
  title: 'Stop gates block every chat turn while a review agent runs',
  observed: 'Each answer to the user was blocked by the review gate and used a retry.',
  expected: 'The gate waits for the running agent without burning retries.',
  user_words: ['왜 계속 막혀?'],
  involved: ['hooks/stop.ts review gate'],
  suspected_causes: ['The gate does not know a review agent is still running.'],
  proposed_change: 'Skip the retry count while a review agent of this session is open.',
  unknowns: ['Whether a test agent has the same effect.'],
  public_summary: { title: 'Stop gates block chat turns while a review agent runs', body: 'While a background review agent runs, every chat turn is blocked.' },
};
const EV: Evidence = { goodboy_version: '0.34.0', claude_code_version: '2.1.302', session: 'abcd1234', gate_counts: { review: { deny: 3 } }, retries: {}, span: null, recent: [] };

describe('J1: the template', () => {
  test('a complete report passes; a gap, an unknown field, a long text or an unsafe title does not', () => {
    expect(validateFieldReport(REPORT)).toMatchObject({ ok: true, value: { title: REPORT.title, user_words: ['왜 계속 막혀?'] } });
    const bad = (patch: Record<string, unknown>) => validateFieldReport({ ...REPORT, ...patch }).errors.join(' | ');
    expect(bad({ observed: ' ' })).toContain('"observed" must be a non-empty string');
    expect(bad({ involved: [] })).toContain('"involved" needs at least one entry');
    expect(bad({ suspected_causes: ['ok', 3] })).toContain('"suspected_causes" must be an array of non-empty strings');
    expect(bad({ extra: 'x' })).toContain('unknown field "extra"');
    expect(bad({ proposed_change: 'x'.repeat(4001) })).toContain('"proposed_change" is longer than 4000 characters');
    expect(bad({ unknowns: Array(21).fill('x') })).toContain('"unknowns" has more than 20 entries');
    for (const t of ['a "quoted" title', 'a `tick`', 'costs $5', 'back\\slash', 'two\nlines']) {
      expect([t, bad({ public_summary: { title: t, body: 'b' } })]).toEqual([t, expect.stringContaining('must not hold quotes')]);
    }
    expect(bad({ public_summary: { title: 't' } })).toContain('"public_summary.body" must be');
    expect(validateFieldReport([]).ok).toBe(false);
  });
});

describe('J1: the public summary check', () => {
  test('paths, emails, IPs, other hosts, domains and package names, secrets and private names are found', () => {
    const terms = ['acme-billing', 'jdoe'];
    for (const [text, kind] of [
      ['see /Users/jdoe/work/x.ts', 'a local path'],
      ['in ~/proj/a.ts', 'a local path'],
      ['at C:\\Users\\x\\a.ts', 'a local path'],
      ['mail me at a.b@corp.example.org', 'an email address'],
      ['the server 10.0.12.7 refused', 'an IP address'],
      ['see https://jira.internal.example/browse/X-1', 'a URL to another host'],
      ['see https://github.com/acmecorp/billing/issues/3', 'a URL to another host'],
      ['the package com.acmecorp.billing.mapper', 'a domain or package name'],
      ['hosted at billing.acme.io', 'a domain or package name'],
      ['token: ghp_abcdefghijklmnopqrstuvwxyz123456', 'a secret'],
      ['password = hunter22', 'a secret'],
      ['in the acme-billing repo', 'a name from this machine or repo'],
      ['JDOE ran it', 'a name from this machine or repo'],
    ]) {
      expect([text, publicLeaks(text!, terms).join(' | ')]).toEqual([text, expect.stringContaining(kind!)]);
    }
    // goodboy's own repo, Anthropic's docs, generic words and names inside a longer word are fine.
    const clean = 'A Java project: see https://github.com/yolol312/goodboy/issues/8 and https://docs.anthropic.com/x. The jdoes list and acme-billings are not names.';
    expect(publicLeaks(clean, terms)).toEqual([]);
  });

  test("the machine's private names: the repo dir, the remote's owner and name, git's user", () => {
    const d = join(tmp(), 'acme-billing');
    mkdirSync(d);
    git(d, 'init', '-q');
    git(d, 'remote', 'add', 'origin', 'git@github.com:acmecorp/billing-api.git');
    git(d, 'config', 'user.name', 'Jane Doe');
    git(d, 'config', 'user.email', 'jane.d@acme-corp.co.kr');
    const terms = privateTerms(d);
    for (const t of ['acme-billing', 'acmecorp', 'billing-api', 'jane doe', 'jane.d', 'acme-corp']) expect([t, terms.includes(t)]).toEqual([t, true]);
    // Generic words are never terms; git's user.name is one whole name, not a first or a last name alone.
    expect(terms.filter((t) => ['github', 'api', 'origin', 'jane', 'doe'].includes(t))).toEqual([]);
  });
});

describe("J1: the session's evidence", () => {
  test('the newest transcript of the dir or a parent, a session by tag, and the Claude Code version', () => {
    const conf = tmp();
    const work = join(tmp(), 'proj');
    mkdirSync(join(work, 'sub'), { recursive: true });
    const pdir = join(conf, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(pdir, { recursive: true });
    const [older, newer] = [uuid(), uuid()];
    writeFileSync(join(pdir, `${older}.jsonl`), '{"type":"user","version":"2.1.100"}\n');
    writeFileSync(join(pdir, `${newer}.jsonl`), '{"type":"mode"}\n{"type":"user","version":"2.1.200"}\n{"type":"assistant","version":"2.1.302"}\n');
    utimesSync(join(pdir, `${older}.jsonl`), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // A link named like a transcript is skipped.
    symlinkSync(join(pdir, `${older}.jsonl`), join(pdir, `${uuid()}.jsonl`));
    const env = { CLAUDE_CONFIG_DIR: conf };
    const s = findSession(join(work, 'sub'), undefined, env)!;
    expect(s.id).toBe(newer);
    expect(claudeCodeVersion(s.transcript)).toBe('2.1.302');
    expect(findSession(work, older.slice(0, 8), env)?.id).toBe(older);
    expect(findSession(work, 'ffffffff', env)).toBeNull();
    // A full id with no transcript still names the session.
    const lone = uuid();
    expect(findSession(tmp(), lone, env)).toEqual({ id: lone, transcript: null });
    expect(claudeCodeVersion(join(conf, 'missing.jsonl'))).toBeNull();
  });

  test("gate decisions, the span, the last lines, retry counters and goodboy's version", () => {
    const id = uuid();
    dirs.push(ensureSessionDir(id));
    logGate(id, 'review', 'deny', 'a reason');
    logGate(id, 'review', 'deny');
    logGate(id, 'push-test', 'warn');
    logGate(id, 'Bad Name!', 'deny');
    writeFileSync(join(ensureSessionDir(id), '.goodboy-test-retry-count.txt'), '2\n');
    writeFileSync(join(ensureSessionDir(id), '.goodboy-retry-count.txt'), 'x');
    const ev = collectEvidence({ id, transcript: null }, ROOT);
    expect(ev.goodboy_version).toBe(JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version);
    expect(ev.session).toBe(id.slice(0, 8));
    expect(ev.gate_counts).toEqual({ review: { deny: 2 }, 'push-test': { warn: 1 } });
    expect(ev.recent.map((e) => e.gate)).toEqual(['review', 'review', 'push-test']);
    expect(ev.span?.first).toBe(ev.recent[0]!.ts);
    expect(ev.retries).toEqual({ 'test-retry-count': 2 });
    expect(collectEvidence(null, ROOT)).toMatchObject({ session: null, gate_counts: {}, recent: [] });
  });

  test('the span runs from the first to the last gate line; the recent lines are the last 30', () => {
    const id = uuid();
    const dir = ensureSessionDir(id);
    dirs.push(dir);
    const ts = (i: number) => `2026-10-19T10:00:${String(i).padStart(2, '0')}.000Z`;
    const lines = Array.from({ length: 31 }, (_, i) => JSON.stringify({ ts: ts(i), gate: 'review', decision: 'deny' }));
    writeFileSync(join(dir, 'gate-log.jsonl'), lines.join('\n') + '\n');
    const ev = collectEvidence({ id, transcript: null }, ROOT);
    expect(ev.gate_counts).toEqual({ review: { deny: 31 } });
    expect(ev.span).toEqual({ first: ts(0), last: ts(30) });
    expect([ev.recent.length, ev.recent[0]!.ts, ev.recent[29]!.ts]).toEqual([30, ts(1), ts(30)]);
  });
});

describe('J1: the inbox', () => {
  const now = new Date('2026-10-19T10:00:00.000Z');

  test('new files only, mode 600: a second report or a link at the name gets the next name', () => {
    const inbox = join(tmp(), 'inbox');
    const env = { GOODBOY_INBOX_DIR: inbox };
    const a = writeFieldReport(REPORT, EV, { cwd: '/w', root: ROOT, env, now });
    expect(a.path).toBe(join(inbox, '2026-10-19T10-00-00-000Z-stop-gates-block-every-chat-turn-while-a.json'));
    expect(lstatSync(inbox).mode & 0o777).toBe(0o700);
    expect(lstatSync(a.path).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(readFileSync(a.path, 'utf8'));
    expect(rec).toMatchObject({ schema: 'goodboy-field-report/1', status: 'new', cwd: '/w', report: { title: REPORT.title }, evidence: { session: 'abcd1234' } });
    const pub = readFileSync(a.publicPath, 'utf8');
    expect(pub.startsWith('# [field-report] Stop gates block chat turns while a review agent runs\n\nWhile a background')).toBe(true);
    expect(pub).toContain('goodboy 0.34.0, Claude Code 2.1.302.');
    expect(pub).toContain('Gate decisions in the session: review deny 3.');
    const b = writeFieldReport(REPORT, EV, { cwd: '/w', root: ROOT, env, now });
    expect(b.path.endsWith('-a-2.json')).toBe(true);
    // A link where the next report would go is never followed: its target stays as it was.
    const target = join(tmp(), 'target.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, a.path.replace(/\.json$/, '-3.json'));
    const c = writeFieldReport(REPORT, EV, { cwd: '/w', root: ROOT, env, now });
    expect(c.path.endsWith('-a-4.json')).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('keep');
    // A file already at the public summary's name is never handed back as the issue body: the
    // report moves to the next name and leaves no `.json` behind at the first one.
    const later = new Date('2026-10-19T11:00:00.000Z');
    const first = join(inbox, '2026-10-19T11-00-00-000Z-stop-gates-block-every-chat-turn-while-a');
    writeFileSync(`${first}.public.md`, 'not this report');
    const d = writeFieldReport(REPORT, EV, { cwd: '/w', root: ROOT, env, now: later });
    expect([d.path, d.publicPath]).toEqual([`${first}-2.json`, `${first}-2.public.md`]);
    expect(readFileSync(`${first}.public.md`, 'utf8')).toBe('not this report');
    expect(existsSync(`${first}.json`)).toBe(false);
    expect(readFileSync(d.publicPath, 'utf8')).toBe(d.publicText);
  });

  test("an inbox that is a link, writable by others, inside goodboy's dir or, by default, in a temp dir is refused", () => {
    const real = join(tmp(), 'real');
    mkdirSync(real);
    const link = join(tmp(), 'link');
    symlinkSync(real, link);
    const w = (env: Record<string, string>, root = ROOT) => () => writeFieldReport(REPORT, EV, { cwd: '/w', root, env, now });
    expect(w({ GOODBOY_INBOX_DIR: link })).toThrow('is not a directory');
    const open = join(tmp(), 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(w({ GOODBOY_INBOX_DIR: open })).toThrow('writable by others');
    const fakeRoot = tmp();
    expect(w({ GOODBOY_INBOX_DIR: join(fakeRoot, 'inbox') }, fakeRoot)).toThrow("inside goodboy's own directory");
    const home = tmp();
    expect(w({ HOME: home })).toThrow('is in a temp dir');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});

describe('J1: cli.ts report-write', () => {
  const cli = (cwd: string, input: unknown, env: Record<string, string>) => {
    const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'report-write'], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...env },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test('a public summary that names the repo is refused; a clean one is written with the evidence', () => {
    const work = join(tmp(), 'acme-billing');
    mkdirSync(work);
    git(work, 'init', '-q');
    const inbox = join(tmp(), 'inbox');
    const env = { GOODBOY_INBOX_DIR: inbox, CLAUDE_CONFIG_DIR: tmp() };
    const leaky = cli(work, { ...REPORT, public_summary: { title: 'Blocked in acme-billing', body: 'b' } }, env);
    expect(leaky.code).toBe(1);
    expect(leaky.err).toContain('a name from this machine or repo: "acme-billing"');
    expect(existsSync(inbox)).toBe(false);
    // The body is checked too, not only the title.
    const leakyBody = cli(work, { ...REPORT, public_summary: { title: 'Blocked chat turns', body: 'Seen in the acme-billing repo.' } }, env);
    expect([leakyBody.code, leakyBody.err]).toEqual([1, expect.stringContaining('a name from this machine or repo: "acme-billing"')]);
    expect(existsSync(inbox)).toBe(false);
    expect(cli(work, { ...REPORT, involved: [] }, env).err).toContain('"involved" needs at least one entry');
    const ok = cli(work, REPORT, env);
    expect(ok.code).toBe(0);
    const res = JSON.parse(ok.out);
    expect(res).toMatchObject({ ok: true, repo: 'yolol312/goodboy', issue_title: `[field-report] ${REPORT.public_summary.title}` });
    expect(existsSync(res.path) && existsSync(res.public_path)).toBe(true);
    expect(JSON.parse(readFileSync(res.path, 'utf8')).cwd).toBe(work);
  }, 30_000);
});

describe('J1: cli.ts report-evidence and --session', () => {
  const run = (cwd: string, args: string[], env: Record<string, string>, input?: unknown) => {
    const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), ...args], {
      cwd,
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(JSON.stringify(input)),
      stdout: 'pipe',
      stderr: 'pipe',
      // Never the session this test itself may run in.
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...env },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test('the newest session of the dir or a parent by default, another one by its tag, an unknown one refused', () => {
    const conf = tmp();
    const work = join(tmp(), 'proj');
    mkdirSync(join(work, 'sub'), { recursive: true });
    const pdir = join(conf, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(pdir, { recursive: true });
    const [older, newer] = [uuid(), uuid()];
    writeFileSync(join(pdir, `${older}.jsonl`), '{"type":"user","version":"2.1.100"}\n');
    writeFileSync(join(pdir, `${newer}.jsonl`), '{"type":"user","version":"2.1.302"}\n');
    utimesSync(join(pdir, `${older}.jsonl`), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    for (const id of [older, newer]) dirs.push(ensureSessionDir(id));
    logGate(newer, 'review', 'deny', 'a reason');
    logGate(older, 'push-test', 'warn');
    const env = { CLAUDE_CONFIG_DIR: conf, GOODBOY_INBOX_DIR: join(tmp(), 'inbox') };

    const byDefault = run(join(work, 'sub'), ['report-evidence'], env);
    expect(byDefault.code).toBe(0);
    expect(JSON.parse(byDefault.out)).toMatchObject({ session: newer.slice(0, 8), claude_code_version: '2.1.302', gate_counts: { review: { deny: 1 } } });

    // Inside Claude Code, the session the command runs in comes before the newest transcript.
    const own = run(work, ['report-evidence'], { ...env, CLAUDE_CODE_SESSION_ID: older });
    expect(JSON.parse(own.out)).toMatchObject({ session: older.slice(0, 8), claude_code_version: '2.1.100' });

    const byTag = run(work, ['report-evidence', '--session', older.slice(0, 8)], env);
    expect(byTag.code).toBe(0);
    expect(JSON.parse(byTag.out)).toMatchObject({ session: older.slice(0, 8), claude_code_version: '2.1.100', gate_counts: { 'push-test': { warn: 1 } } });

    const unknown = run(work, ['report-evidence', '--session', 'ffffffff'], env);
    expect([unknown.code, unknown.err]).toEqual([1, expect.stringContaining('no session ffffffff')]);
    const notAnId = run(work, ['report-evidence', '--session', '../x'], env);
    expect([notAnId.code, notAnId.err]).toEqual([1, expect.stringContaining('--session takes a session id')]);

    // report-write refuses an unknown --session and writes nothing; it attaches the one named.
    const unknownWrite = run(work, ['report-write', '--session', 'ffffffff'], env, REPORT);
    expect([unknownWrite.code, unknownWrite.err]).toEqual([1, expect.stringContaining('report-write: no session ffffffff')]);
    expect(existsSync(env.GOODBOY_INBOX_DIR)).toBe(false);
    const written = run(work, ['report-write', '--session', older.slice(0, 8)], env, REPORT);
    expect(written.code).toBe(0);
    const res = JSON.parse(written.out);
    expect(res.evidence).toEqual({ goodboy: expect.any(String), claude_code: '2.1.100', session: older.slice(0, 8) });
    expect(JSON.parse(readFileSync(res.path, 'utf8')).evidence.gate_counts).toEqual({ 'push-test': { warn: 1 } });
  }, 30_000);
});

// Review round 1 and the test record's surviving mutations (J1).
describe('J1: limits, spellings and hostile state', () => {
  test('template limits: lengths, required and optional lists, the summary shape, trimming', () => {
    const errs = (patch: Record<string, unknown>) => validateFieldReport({ ...REPORT, ...patch }).errors.join(' | ');
    expect(errs({ title: 'x'.repeat(121) })).toContain('"title" is longer than 120');
    expect(errs({ involved: ['x'.repeat(1001)] })).toContain('an entry of "involved" is longer than 1000');
    expect(errs({ suspected_causes: [] })).toContain('"suspected_causes" needs at least one entry');
    expect(errs({ public_summary: [] })).toContain('"public_summary" must be {"title": "...", "body": "..."}');
    for (const ps of [{ title: 'x'.repeat(121), body: 'b' }, { title: '  ', body: 'b' }]) expect(errs({ public_summary: ps })).toContain('"public_summary.title" must be 1');
    expect(errs({ public_summary: { title: 'a\rb', body: 'b' } })).toContain('must not hold quotes');
    expect(errs({ public_summary: { title: 't', body: 'x'.repeat(6001) } })).toContain('"public_summary.body" must be 1');
    expect(validateFieldReport({ ...REPORT, user_words: [], unknowns: [] }).ok).toBe(true);
    expect(validateFieldReport({ ...REPORT, title: '  x  ' }).value?.title).toBe('x');
  });

  test('every kind of private detail in any spelling is found; plain report text is not', () => {
    const terms = ['acme-billing', 'jane doe', '김성모', '王伟'];
    for (const text of [
      '/data/app/x.ts', 'PATH=:/Users/x/bin', '[/Users/x/a.ts]', 'file:///Users/x/a', 'C:/Users/x/a.ts', '~/.claude/../work/acme/x',
      'fe80::1ff:fe23:4567:890a', 'ftp://docs.anthropic.com/x', 'https://github.com/yolol312/goodboyx', 'see github.com/acmecorp/billing/issues/3',
      'jira.acme.de', 'build01.acme.local', 'src/main/java/com/acmecorp/Billing.java', 'uses @acmecorp/billing-ui',
      `ghp_${'a'.repeat(36)}`, 'AKIAIOSFODNN7EXAMPLE', `sk-${'a'.repeat(20)}`, 'sk_live_abcdefghijklmnop1234', 'xoxb-1234567890-abc',
      '-----BEGIN RSA PRIVATE KEY', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0', `github_pat_${'a'.repeat(22)}`, `glpat-${'a'.repeat(20)}`,
      `AIza${'a'.repeat(35)}`, `npm_${'a'.repeat(36)}`, `Bearer ${'a'.repeat(16)}`, 'redis://:pw@host', '--password hunter22', '{"password": "hunter22"}',
      'Acme Billing', 'acme_billing', 'AcmeBilling', 'Jane Doe said', '김 성모', '김성모'.normalize('NFD'), '王伟',
    ]) {
      expect([text, publicLeaks(text, terms).length > 0]).toEqual([text, true]);
    }
    // Named as what they are, not only as a URL.
    expect(publicLeaks('file:///Users/x/a', []).join(' | ')).toContain('a local path');
    expect(publicLeaks('redis://:pw@host', []).join(' | ')).toContain('a secret');
    for (const text of [
      '~/.claude/settings.json', 'vite.config.dev.json', 'tsconfig.app.json', 'org.springframework.boot', 'org/junit/jupiter/api', '@types/node',
      'max token = 128000', 'token: 180000', 'the token budget', 'eslint@9.1.0', 'the task-management-service-layer module', '12:30:45',
      'github.com/yolol312/goodboy/issues/8', 'the /report-goodboy command and hooks/stop.ts', 'Will and Max ran it',
    ]) {
      expect([text, publicLeaks(text, terms)]).toEqual([text, []]);
    }
  });

  test("private names: a private remote host, the login and the host name, CJK names; never generic words or a subdir's name", () => {
    const top = join(tmp(), 'backend');
    mkdirSync(join(top, 'sub'), { recursive: true });
    git(top, 'init', '-q');
    git(top, 'remote', 'add', 'origin', 'git@gitlab.acme-corp.com:acmegroup/platform/billing.git');
    git(top, 'remote', 'add', 'other', 'git@git.acme-internal.io:team/x.git');
    git(top, 'config', 'user.name', '王伟');
    const terms = privateTerms(join(top, 'sub'));
    for (const t of ['acme-corp', 'acmegroup', 'billing', 'acme-internal', '王伟', userInfo().username.toLowerCase(), hostname().split('.')[0]!.toLowerCase()]) {
      expect([t, terms.includes(t)]).toEqual([t, true]);
    }
    for (const t of ['backend', 'sub', 'platform', 'team', 'gitlab', 'com']) expect([t, terms.includes(t)]).toEqual([t, false]);
    git(top, 'config', 'user.name', 'Al');
    expect(privateTerms(top).includes('al')).toBe(false);
  });

  test('sessions and evidence: links, other files and a FIFO are skipped; --session beats the env; the version is read from the tail', () => {
    const conf = tmp();
    const work = join(tmp(), 'proj');
    mkdirSync(join(work, 'sub'), { recursive: true });
    const pdir = (d: string) => {
      const p = join(conf, 'projects', d.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(p, { recursive: true });
      return p;
    };
    const [inSub, inParent] = [uuid(), uuid()];
    writeFileSync(join(pdir(join(work, 'sub')), `${inSub}.jsonl`), '{"version":"2.1.1"}\n');
    utimesSync(join(pdir(join(work, 'sub')), `${inSub}.jsonl`), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    // The parent's newer session wins over the subdir's old one; a file not named by an id is no session.
    writeFileSync(join(pdir(work), `${inParent}.jsonl`), `${'{"type":"x"}\n'.repeat(60_000)}{"version":"2.1.9"}\n`);
    writeFileSync(join(pdir(work), 'notes.jsonl'), '{"version":"9.9.9"}\n');
    const env = { CLAUDE_CONFIG_DIR: conf };
    const s = findSession(join(work, 'sub'), undefined, env)!;
    expect(s.id).toBe(inParent);
    expect(claudeCodeVersion(s.transcript)).toBe('2.1.9');
    expect(findSession(join(work, 'sub'), inSub.slice(0, 8), { ...env, CLAUDE_CODE_SESSION_ID: inParent })?.id).toBe(inSub);
    expect(findSession(work, undefined, { ...env, CLAUDE_CODE_SESSION_ID: 'not-a-uuid' })?.id).toBe(inParent);
    const linkId = uuid();
    symlinkSync(s.transcript!, join(pdir(work), `${linkId}.jsonl`));
    expect(findSession(work, linkId.slice(0, 8), env)).toBeNull();
    expect(claudeCodeVersion(join(pdir(work), `${linkId}.jsonl`))).toBeNull();
    // goodboy's version must look like one.
    const fakeRoot = tmp();
    mkdirSync(join(fakeRoot, '.claude-plugin'));
    writeFileSync(join(fakeRoot, '.claude-plugin', 'plugin.json'), '{"version":"x y"}');
    expect(collectEvidence(null, fakeRoot).goodboy_version).toBeNull();
    // A gate named like an Object member is counted as itself; only the counters are counters.
    const id = uuid();
    const sdir = ensureSessionDir(id);
    dirs.push(sdir);
    logGate(id, 'constructor', 'deny');
    writeFileSync(join(sdir, '.goodboy-foo.txt'), '5');
    const ev = collectEvidence({ id, transcript: null }, ROOT);
    expect(JSON.stringify(ev.gate_counts)).toBe('{"constructor":{"deny":1}}');
    expect(ev.retries).toEqual({});
    // A gate log that is a link or a FIFO is never read (nor waited on).
    rmSync(join(sdir, 'gate-log.jsonl'));
    const real = join(tmp(), 'log.jsonl');
    writeFileSync(real, `${JSON.stringify({ ts: 't', gate: 'review', decision: 'deny' })}\n`);
    symlinkSync(real, join(sdir, 'gate-log.jsonl'));
    expect(collectEvidence({ id, transcript: null }, ROOT).gate_counts).toEqual({});
    rmSync(join(sdir, 'gate-log.jsonl'));
    expect(Bun.spawnSync(['mkfifo', join(sdir, 'gate-log.jsonl')]).exitCode).toBe(0);
    expect(collectEvidence({ id, transcript: null }, ROOT).gate_counts).toEqual({});
  }, 30_000);

  test('inbox: group-writable, another user, a linked root reached before the inbox exists, /tmp as HOME; a write error is not a taken name', () => {
    const now = new Date('2026-10-19T10:00:00.000Z');
    const w = (env: Record<string, string>, root = ROOT) => () => writeFieldReport(REPORT, EV, { cwd: '/w', root, env, now });
    const group = join(tmp(), 'group');
    mkdirSync(group);
    chmodSync(group, 0o770);
    expect(w({ GOODBOY_INBOX_DIR: group })).toThrow('writable by others');
    if (existsSync('/usr/share')) expect(w({ GOODBOY_INBOX_DIR: '/usr/share' })).toThrow('belongs to another user');
    const fakeRoot = tmp();
    const link = join(tmp(), 'to-root');
    symlinkSync(fakeRoot, link);
    expect(w({ GOODBOY_INBOX_DIR: join(link, 'inbox') }, fakeRoot)).toThrow("inside goodboy's own directory");
    const tmpHome = realpathSync(mkdtempSync('/tmp/goodboy-j1-home-'));
    dirs.push(tmpHome);
    expect(w({ HOME: tmpHome })).toThrow('is in a temp dir');
    const locked = join(tmp(), 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(w({ GOODBOY_INBOX_DIR: locked })).toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test('cli: not JSON, a file argument, a directory or a FIFO as the file, and goodboy\'s own footer never checked', () => {
    const work = join(tmp(), 'session');
    mkdirSync(work);
    git(work, 'init', '-q');
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: '', GOODBOY_INBOX_DIR: join(tmp(), 'inbox'), CLAUDE_CONFIG_DIR: tmp() };
    const run = (args: string[], stdin: string) => {
      const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'report-write', ...args], { cwd: work, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe', env });
      return { code: r.exitCode, err: r.stderr.toString() };
    };
    expect(run([], 'not json').err).toContain('is not JSON');
    writeFileSync(join(work, 'report.json'), JSON.stringify(REPORT));
    // A repo named like a word of goodboy's footer ("…in the session.") still passes.
    expect(run(['report.json'], '').code).toBe(0);
    mkdirSync(join(work, 'adir'));
    expect(run(['adir'], '').err).toContain('not a regular file');
    expect(Bun.spawnSync(['mkfifo', join(work, 'pipe')]).exitCode).toBe(0);
    expect(run(['pipe'], '').err).toContain('not a regular file');
  }, 30_000);
});
