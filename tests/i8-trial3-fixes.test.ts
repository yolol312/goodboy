import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changedLineGaps, codeFreeJava } from '../lib/changed-coverage';
import { checkHandoff, handoffsOf, pushTestMessage } from '../lib/push-test';
import { stripLiteralsAndComments } from '../lib/test-validator';
import type { TestResult } from '../lib/types';

// Track I, I8 (#15, plan §15.11): fixes for what the third real-use trial ran into.

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i8-')));
  dirs.push(d);
  return d;
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

const MAPPER = `package a.b.mapper;

import java.util.List;
import org.apache.ibatis.annotations.*;

/** Finds sales; see the XML mapper (no "class" here). */
@Mapper
public interface SalesMapper {
    int PAGE = 50; // a compile-time constant
    String TABLE = "sales_history";

    List<Sale> search(@Param("q") String q, @Param("cutoff") Integer cutoff);

    @Select("select count(*) from sales where id = #{id} and (a = 1)")
    @Options(useCache = true, timeout = 10)
    long count(@Param("id") long id);
}
`;

describe('finding 1: code-free Java interfaces', () => {
  test('AC-1: a mapper interface or an annotation type has no executable code; anything with code does', () => {
    const d = tmp();
    const java = (name: string, text: string) => codeFreeJava(write(d, `${name}.java`, text));
    expect(java('SalesMapper', MAPPER)).toBe(true);
    expect(java('Marker', 'public @interface Marker {\n  String[] value() default {};\n  int size() default 3;\n}\n')).toBe(true);
    expect(java('Default', 'interface A {\n  default int x() { return 1; }\n}\n')).toBe(false);
    expect(java('Static', 'interface A {\n  static int x() throws java.io.IOException { return 1; }\n}\n')).toBe(false);
    expect(java('Nested', 'interface A {\n  class Impl implements A {}\n}\n')).toBe(false);
    expect(java('Computed', 'interface A {\n  java.util.List<String> L = java.util.List.of("a");\n}\n')).toBe(false);
    expect(java('Array', 'interface A {\n  int[] A = {1, 2};\n}\n')).toBe(false);
    expect(java('NewObj', 'interface A {\n  Object O = new Object();\n}\n')).toBe(false);
    expect(java('Plain', 'public class A {\n  int x() { return 1; }\n}\n')).toBe(false);
    expect(java('Enum', 'enum E { A, B }\n')).toBe(false);
    // "interface" only in a comment or a string; an annotation that does not close.
    expect(java('Commented', '// an interface\npublic class A { String s = "interface"; }\n')).toBe(false);
    expect(java('Broken', 'interface A {\n  @Select("x" void f();\n}\n')).toBe(false);
    // Code words inside comments, strings, text blocks, char literals and annotations are no code.
    const quoted = [
      'interface A {',
      '  // see class Impl { }',
      '  /* enum E { X } */',
      '  String SQL = """',
      '      select x from t where a = f(1) and class b { }',
      '      """;',
      "  char BRACE = '{';",
      '  @org.apache.ibatis.annotations.Select("select (a) from t")',
      '  @Options(timeout = 10)',
      '  long count(int id);',
      '}',
    ];
    expect(java('Quoted', quoted.join('\n'))).toBe(true);
    // Only compile-time constants: any other initializer runs in a static initializer.
    for (const [name, field] of [
      ['ObjStr', 'Object O = "x";'],
      ['Null', 'String S = null;'],
      ['MethodRef', 'java.util.function.Function<String, Integer> P = Integer::parseInt;'],
      ['ClassLit', 'Class<?> C = String.class;'],
      ['EnumRef', 'java.util.concurrent.TimeUnit U = java.util.concurrent.TimeUnit.SECONDS;'],
      ['Sum', 'int B = 1 + 2;'],
    ]) {
      expect([name, java(name!, `interface A {\n  ${field}\n}\n`)]).toEqual([name, false]);
    }
    for (const [name, field] of [
      ['Int', 'int A = -1;'],
      ['Long', 'long B = 0x1F_FFL;'],
      ['Double', 'double D = 1.5e3;'],
      ['Bool', 'boolean T = true;'],
      ['Str', 'String S = "a = b";'],
      ['Modifiers', 'public static final int X = 1;'],
    ]) {
      expect([name, java(name!, `interface A {\n  ${field}\n}\n`)]).toEqual([name, true]);
    }
    expect(java('ArrayReturn', 'interface A {\n  default int f()[] { return null; }\n}\n')).toBe(false);
    // A file with no interface at all is not one.
    expect(java('NoType', 'package a.b;\n\nimport java.util.List;\n')).toBe(false);
    // javac reads unicode escapes before anything else (a backslash, `u` and four hex digits
    //   for `{` open a body); an escaped quote does not end a text block, so code after the
    //   real end is still read (I8 review).
    expect(java('Unicode', 'interface A {\n  default int f() \\u007b return 1; }\n}\n')).toBe(false);
    expect(java('TextBlock', 'interface A {\n  String S = """\n    a \\""" b\n    """; default int f() { return 1; }\n}\n')).toBe(false);
    // A lone CR ends a line comment; a name javac takes that is not ASCII, or a control or
    //   format character inside a word, counts as code; CRLF, a BOM, and non-ASCII text in
    //   comments and strings do not (I8 review round 2).
    expect(java('CrComment', 'interface A {\r  // note\r  default int f() { return 1; }\r}\r')).toBe(false);
    expect(java('Hangul', 'class 매출 {}\ninterface A {}\n')).toBe(false);
    expect(java('Umlaut', 'enum Örder { A, B }\ninterface I {}\n')).toBe(false);
    expect(java('Throws', 'interface A {\n  default void f() throws Éxc {}\n}\n')).toBe(false);
    expect(java('Control', 'interface A {\n  cl\x01ass B {}\n}\n')).toBe(false);
    expect(java('ZeroWidth', `interface A {\n  en${String.fromCharCode(0x200b)}um E { X }\n}\n`)).toBe(false);
    expect(java('Crlf', MAPPER.replace(/\n/g, '\r\n'))).toBe(true);
    expect(java('Bom', String.fromCharCode(0xfeff) + MAPPER)).toBe(true);
    expect(java('KoText', 'interface A {\n  // 매출 조회\n  String S = "매출";\n  long count();\n}\n')).toBe(true);
    // The JS forbidden-pattern scan reads code after a CR too, after U+2028 in a comment, and
    //   after a CR in a quoted string.
    expect(stripLiteralsAndComments('// a\rcode();\n')).toContain('code();');
    expect(stripLiteralsAndComments(`// a${String.fromCharCode(0x2028)}code();\n`)).toContain('code();');
    expect(stripLiteralsAndComments('x = "abc\rcode();\n')).toContain('code();');
    // An escaped quote inside a text block, a dotted annotation name, and a doubled-u escape
    //   (test record 2 gaps).
    expect(java('TextBlockEscaped', 'interface A {\n  String S = """\n    a \\""" b\n    """;\n  long count();\n}\n')).toBe(true);
    expect(java('Dotted', 'interface A {\n  @a.b.Options(timeout = 10)\n  long count(int id);\n}\n')).toBe(true);
    expect(java('DoubleU', 'interface A {\n  default int f() \\uu007b return 1; }\n}\n')).toBe(false);
  });

  test('AC-1: a crafted large file or a FIFO named .java ends fast and counts as code', () => {
    const d = tmp();
    const timed = (text: string) => {
      const t = Date.now();
      const v = codeFreeJava(write(d, `T${Math.random().toString(36).slice(2)}.java`, text));
      return { v, ms: Date.now() - t };
    };
    const zeros = timed(`interface A {\n  double D = ${'0'.repeat(50_000)}1.0 + 1;\n}\n`);
    expect(zeros.v).toBe(false);
    expect(zeros.ms).toBeLessThan(1_000);
    const lines = timed(`interface A {\n  void f() throws${'\n'.repeat(110_000)}Exception;\n}\n`);
    expect(lines.v).toBe(true);
    expect(lines.ms).toBeLessThan(1_000);
    const at = timed(`interface A {\n${'@'.repeat(200_000)}\n}\n`);
    expect(at.ms).toBeLessThan(1_000);
    const fifo = join(d, 'Pipe.java');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    expect(codeFreeJava(fifo)).toBe(false);
    // Over the size limit, even a code-free interface counts as code (test record 2 gaps).
    expect(timed(`interface A {\n${'  long count();\n'.repeat(150_000)}}\n`).v).toBe(false);
    // A FIFO named .ts on the JS path counts as code unread.
    const tsFifo = join(d, 'Pipe.ts');
    expect(Bun.spawnSync(['mkfifo', tsFifo]).exitCode).toBe(0);
    expect(changedLineGaps({ results: [], edits: [{ file: tsFifo, lastEditTimestamp: null }], top: d, exempt: [] }).measured).toBe(false);
  }, 30_000);

  test('AC-1: a changed code-free interface missing from the report needs no run; a missing class does', () => {
    const d = tmp();
    const mapper = write(d, 'src/main/java/a/b/mapper/SalesMapper.java', MAPPER);
    const service = write(d, 'src/main/java/a/b/Service.java', 'class Service {\n  int f() { return 1; }\n}\n');
    const rec = {
      timestamp: new Date().toISOString(),
      verdict: 'pass',
      tested_files: [mapper, service],
      coverage: {
        status: 'measured',
        changed: {
          covered: 0,
          total: 0,
          files_without_executed_changes: [],
          files: {},
          in_report: [],
          diff_lines: { 'src/main/java/a/b/mapper/SalesMapper.java': 2, 'src/main/java/a/b/Service.java': 1 },
          base: 'a'.repeat(40),
        },
      },
    } as unknown as TestResult;
    const edits = [mapper, service].map((file) => ({ file, lastEditTimestamp: null }));
    expect(changedLineGaps({ results: [rec], edits, top: d, exempt: [] })).toEqual({
      measured: true,
      gaps: [{ file: 'src/main/java/a/b/Service.java', absent: true }],
    });
  });
});

describe('finding 2: a commit and a push in one command', () => {
  const rules = { allow: [], production: [] };
  function repo(): string {
    const d = join(tmp(), 'repo');
    mkdirSync(d, { recursive: true });
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'user.email', 't@example.com');
    git(d, 'config', 'user.name', 't');
    git(d, 'config', 'commit.gpgsign', 'false');
    write(d, 'a.ts', 'export const a = 1;\n');
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', 'init');
    return d;
  }

  test('AC-2: a command that may change commits before the push is named; after the push, or one that does not, is not', () => {
    const d = repo();
    for (const [command, first] of [
      ['git add -A && git commit -q -m "x #1" && git push origin main', 'git commit'],
      ['git commit -qam "x #1"; git status --short; git push origin main', 'git commit'],
      ['git checkout -b feat && git push -u origin feat', 'git checkout'],
      ['git tag v1 && git push origin v1', 'git tag'],
      ['git -C . merge other && git push origin main', 'git merge'],
      // A function or a loop may run a command after the push in the text first; an alias, an
      //   inline alias, a fetch into a local branch, a moved symbolic ref (I8 review).
      ['f() { git push origin main; }; git commit -qam "x #1"; f', 'git commit'],
      ['for i in 1 2; do git push origin main; git commit -qam "x #1"; done', 'git commit'],
      ['git ci -qam "x #1" && git push origin main', 'git ci'],
      ['git -c alias.x=commit x -qam "x #1" && git push origin main', 'git x'],
      ['git fetch . other:main && git push origin main', 'git fetch'],
      ['git symbolic-ref HEAD refs/heads/other && git push origin main', 'git symbolic-ref'],
      // Read-only spellings that move refs, a config set for one command, and programs other
      //   than git (I8 review round 2).
      ['git tag -a -f -m x v1 && git push origin v1', 'git tag'],
      ['git branch -v -f rel main && git push origin rel', 'git branch'],
      // git deletes before it lists: a read mode next to a flag that changes refs still changes.
      ['git branch -D --list old && git push origin main', 'git branch'],
      ['git checkout -B main other -- && git push origin main', 'git checkout'],
      ['git reset --hard other -- && git push origin main', 'git reset'],
      ['git stash branch wip && git push origin wip', 'git stash'],
      ['git fetch --refmap=src:dst origin && git push origin main', 'git fetch'],
      ['git remote add --mirror=push backup ../b && git push backup', 'git remote'],
      ["git -c diff.external='sh -c x' diff && git push origin main", 'git diff'],
      ['npm version patch && git push origin main', 'npm version'],
      ['make release && git push origin main', 'make release'],
      ['./release.sh && git push origin main', './release.sh'],
      ['bash release.sh && git push origin main', 'bash release.sh'],
      // Between two pushes the later one runs after it; a flag that runs a program (closing check).
      ['git push origin other; git commit -qam "x #1"; git push origin main', 'git commit'],
      ['git push origin other && npm version patch && git push origin main', 'npm version'],
      ['git fetch --upload-pack=x origin && git push origin main', 'git fetch'],
      ["git grep -O'sh -c x' pat && git push origin main", 'git grep'],
      ['gh repo sync && git push origin main', 'gh repo sync'],
    ] as const) {
      expect([command, handoffsOf(command, d, rules)]).toEqual([command, [expect.objectContaining({ revs: [], runFirst: first })]]);
    }
    // The denial names the push that runs after it.
    expect(handoffsOf('git push origin other; git commit -qam "x #1"; git push origin main', d, rules)[0]!.what).toBe('git push origin main');
    for (const command of [
      'git stash && git push origin main',
      'git reset && git push origin main',
      'git config --get user.name && git push origin main',
      'git fetch origin && git push origin main',
      'git add -A && git status && git push origin main',
      'git branch --show-current && git push origin main',
      'git tag -l "v*" && git push origin main',
      'git checkout -- a.ts && git push origin main',
      'git remote -v && git push origin main',
      'git remote show origin && git push origin main',
      'git branch && git push origin main',
      'git tag && git push origin main',
      'git reset HEAD -- a.ts && git push origin main',
      'echo hi && sleep 1 && git push origin main',
      "sh -c 'git push origin main'",
      // After the push in a plain sequence: the push already ran (I8 review round 2).
      'git push origin main && git commit -qam "x #1"',
      'git push origin main && git switch other',
    ]) {
      const hs = handoffsOf(command, d, rules);
      expect([command, hs.some((h) => h.runFirst !== undefined), hs[0]!.revs]).toEqual([command, false, ['main']]);
    }
    const h = handoffsOf('git commit -qam "x #1" && git push origin main', d, rules)[0]!;
    const o = checkHandoff(h, []);
    expect(o).toMatchObject({ ok: false, why: 'unclear', runFirst: 'git commit' });
    const msg = pushTestMessage(h.what, o as Exclude<typeof o, { ok: true }>);
    expect(msg).toContain('This command runs `git commit` before `git push origin main`.');
    expect(msg).toContain('Run that part on its own first, then `git push origin main` as a separate command');
    // An MR made after a commit in the same command, and a ref moved by update-ref, too.
    expect(handoffsOf('git commit -qam "x #1" && gh pr create --fill', d, rules)).toEqual([expect.objectContaining({ kind: 'mr', revs: [], runFirst: 'git commit' })]);
    expect(handoffsOf('git update-ref refs/heads/main HEAD~1 && git push origin main', d, rules)).toEqual([expect.objectContaining({ runFirst: 'git update-ref' })]);
    // A push that a trap runs later is read as unclear, not skipped (I8 review).
    expect(handoffsOf('trap "git push origin main" EXIT; true', d, rules)).toEqual([expect.objectContaining({ unclear: 'it runs a push from a trap' })]);
  });

  test('AC-2: through the hook, the denial says to split the command, to the model and to the user', async () => {
    const d = repo();
    const base = tmp();
    const sid = `i8-${Math.random().toString(36).slice(2)}`;
    const payload = { session_id: sid, cwd: d, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -qam "x #1" && git push origin main' } };
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', 'pre-tool-use.ts')], {
      cwd: d,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: 'off', GOODBOY_POLICY_GATE: 'off', GOODBOY_COMMIT_ISSUE: 'off' },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { systemMessage?: string; hookSpecificOutput?: Record<string, string> };
    await proc.exited;
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('Run that part on its own first');
    expect(out.systemMessage).toContain('나눠서 해야 해요');
  }, 30_000);
});
