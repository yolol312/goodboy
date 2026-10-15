// The closing G1 round: what the final review and the final layer-1 record found in the shared
// shell reader, pinned down with their fixes. Substitutions inside double quotes (GAP-DQ),
// nesting past what goodboy reads (GAP-NEST), per-word prefix options (GAP-PV), line
// continuations (GAP-LC), dir changes in background jobs and pipelines (GAP-BG), `popd -n`,
// `env -C` / `sudo -D` dirs, `tofu` deploys and the carrier lookup's cost.
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { classifyOutward, readCommand, shellSegments } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { bashChangedPaths, resultDirWrite } from '../lib/role-limits';

const rules = { allow: [], production: [] };
// Deploys are compared in a git repo: this one.
const REPO = resolve(import.meta.dir, '..');
const stripe = 'curl -X DELETE https://api.stripe.com/v1/customers/cus_1';

describe('GAP-DQ: a command substitution inside double quotes runs, so it is read', () => {
  test('pushes, MRs, R2 and result writes inside "$(…)" and "`…`"', () => {
    expect(handoffsOf('out="$(git push origin main 2>&1)"', '/x', rules)).toHaveLength(1);
    expect(handoffsOf('echo "`git push origin main`"', '/x', rules)).toHaveLength(1);
    expect(handoffsOf('url="$(gh pr create --fill)"', '/x', rules).some((h) => h.kind !== 'push' || h.what.includes('gh'))).toBe(true);
    expect(classifyOutward(`r="$(${stripe})"`, '/proj').some((t) => t.mutating)).toBe(true);
    expect(resultDirWrite('x="$(echo hi > .claude/tests/f.json)"', '/proj')).not.toBeNull();
  });

  test('the command around it keeps going after it, with its text in the word', () => {
    expect(shellSegments('echo "a $(id) b" done')).toEqual([['id'], ['echo', 'a $(id) b', 'done']]);
    // `\$(` is no substitution, and a quote inside the substitution is its own.
    expect(shellSegments('echo "\\$(id)"')).toEqual([['echo', '$(id)']]);
    expect(shellSegments('echo "$(printf ")")"')).toEqual([['printf', ')'], ['echo', '$(printf ")")']]);
    // An unclosed one still ends the command around it.
    expect(shellSegments('echo $(id')).toEqual([['id'], ['echo', '$(id']]);
    // `env -C "$(…)"` names a dir goodboy cannot know: the push there is unclear.
    expect(handoffsOf('env -C "$(echo ../B)" git push origin main', '/x/A', rules)[0]?.unclear).toContain('cannot follow');
    // The repo top level still counts as the same repo.
    expect(handoffsOf('cd "$(git rev-parse --show-toplevel)" && git push origin main', '/x/A', rules).map((h) => [h.cwd, h.unclear ?? null])[0]).toEqual(['/x/A', null]);
  });
});

describe('GAP-NEST: nesting past what goodboy reads marks the reading truncated', () => {
  test('20,000 nested `(` is truncated, not a stack overflow', () => {
    const deep = `a=\${b:-${'('.repeat(20_000)}}; git push origin main`;
    const started = Date.now();
    expect(readCommand(deep, '/x').truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Past 64 subshells, well below the list-level cap.
    expect(readCommand(`${'('.repeat(100)}git push origin main${')'.repeat(100)}`, '/x').truncated).toBe(true);
    expect(readCommand(`${'('.repeat(60)}git push origin main${')'.repeat(60)}`, '/x').truncated).toBe(false);
  });

  test('eval and sh -c past four levels are truncated; the push is unclear', () => {
    for (const c of ['eval eval eval eval eval git push origin main', `sh -c "sh -c 'sh -c \\"sh -c \\\\\\"sh -c true\\\\\\"\\"'"`]) {
      expect([c, readCommand(c, '/x').truncated]).toEqual([c, true]);
    }
    expect(handoffsOf('eval eval eval eval eval git push origin main', '/x', rules)[0]?.unclear).toContain('too large or nested');
    // Three levels are read.
    expect(readCommand('eval eval eval git push origin main', '/x').truncated).toBe(false);
    expect(handoffsOf('eval eval eval git push origin main', '/x', rules)[0]?.unclear).toBeUndefined();
  });
});

describe('GAP-PV: prefix options are per prefix word (sudo -n, command -p, time -p take no value)', () => {
  test('the program after the option is still read', () => {
    for (const p of ['sudo -n', 'sudo -s', 'sudo -nu root', 'sudo -uroot', 'command -p', 'time -p', 'timeout 1.5', 'timeout 0.5s', 'nice -n 5', 'exec -a x']) {
      expect([p, handoffsOf(`${p} git push origin main`, '/x', rules).length]).toEqual([p, 1]);
      expect([p, classifyOutward(`${p} ${stripe}`, '/proj').some((t) => t.mutating)]).toEqual([p, true]);
      expect([p, resultDirWrite(`${p} cp /tmp/f.json .claude/tests/x.json`, '/proj') !== null]).toEqual([p, true]);
      expect([p, bashChangedPaths(`${p} cp a.ts src/b.ts`, '/proj')]).toEqual([p, ['/proj/src/b.ts']]);
    }
  });

  test('`env -S` runs its split string; `sudo -D` and `env --chdir` run in their dir', () => {
    expect(handoffsOf("env -S 'git push origin main'", '/x', rules)).toHaveLength(1);
    for (const c of ['sudo -D ../B git push origin main', 'sudo --chdir=../B git push origin main', 'env --chdir ../B git push origin main']) {
      expect([c, handoffsOf(c, '/x/A', rules)[0]?.cwd]).toEqual([c, '/x/B']);
    }
    expect(resultDirWrite('env --chdir .claude/tests touch x', '/proj')).not.toBeNull();
    expect(resultDirWrite('env -C .claude/tests touch x', '/proj')).not.toBeNull();
  });
});

describe('GAP-LC: a backslash-newline is a line continuation, not part of a word', () => {
  test('push, deploy and R2 read across it', () => {
    expect(handoffsOf('git \\\npush origin main', '/x', rules)).toHaveLength(1);
    expect(handoffsOf('npm \\\npublish', REPO, rules).filter((h) => h.kind === 'deploy')).toHaveLength(1);
    expect(classifyOutward('kubectl \\\n  apply -f k.yaml', '/proj').some((t) => t.mutating)).toBe(true);
    expect(readCommand('git push \\\n  origin main', '/x').segments[0]!.words).toEqual(['git', 'push', 'origin', 'main']);
    // Inside single quotes it stays as it is.
    expect(shellSegments("echo 'a\\\nb'")).toEqual([['echo', 'a\\\nb']]);
  });
});

describe('GAP-BG: a cd in a background job or a pipeline does not move the shell', () => {
  test('the next segment still runs where the shell was (bash and zsh)', () => {
    for (const c of ['cd ../B; cd ../A & git push origin main', 'cd ../B; cd ../A | true; git push origin main']) {
      expect([c, handoffsOf(c, '/x/A', rules)[0]?.cwd]).toEqual([c, '/x/B']);
    }
    // `&&` and `||` are no background job or pipe.
    expect(handoffsOf('cd ../B && git push origin main', '/x/A', rules)[0]?.cwd).toBe('/x/B');
    expect(handoffsOf('cd ../B || exit 1; git push origin main', '/x/A', rules)[0]?.cwd).toBe('/x/B');
    // The last pipeline element moves the shell in zsh, not in bash: unclear.
    expect(handoffsOf('true | cd ../B; git push origin main', '/x/A', rules)[0]?.unclear).toContain('cannot follow');
    expect(resultDirWrite('cd /tmp & cp /tmp/f.json .claude/tests/x.json', '/proj')).not.toBeNull();
    expect(bashChangedPaths('cd /tmp & cp /etc/hosts src/a.ts', '/proj')).toEqual(['/proj/src/a.ts']);
  });

  test('`popd -n` changes the stack only, like `pushd -n`; `pushd -n dir` is where popd goes', () => {
    expect(handoffsOf('pushd ../B; popd -n; git push origin main', '/x/A', rules)[0]?.cwd).toBe('/x/B');
    expect(handoffsOf('pushd -n ../B; popd; git push origin main', '/x/A', rules)[0]?.cwd).toBe('/x/B');
  });
});

describe('closing review: a job is a scope of its own, with what runs inside it', () => {
  test('a cd and a write in the same piped or background job are read together', () => {
    for (const c of [
      'echo | { cd .claude/tests; cp /tmp/f x.json; }',
      'true | (cd .claude/tests && cp /tmp/f x.json)',
      'true | cd .claude/tests && cp /tmp/f x.json',
      "bash -c 'cd .claude/tests && cp /tmp/f x.json' | tail",
      "bash -c 'cd .claude/tests && cp /tmp/f x.json' &",
      "eval 'cd .claude/tests && cp /tmp/f x.json' &",
    ]) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
  });

  test('pushes and writes inside a job are compared where the job runs', () => {
    expect(handoffsOf("sh -c 'cd ../B && git push origin main' | tail", '/x/A', rules)[0]?.cwd).toBe('/x/B');
    expect(handoffsOf("eval 'cd ../B && git push origin main' &", '/x/A', rules)[0]?.cwd).toBe('/x/B');
    expect(handoffsOf('true | (cd ../B; git push origin main)', '/x/A', rules)[0]).toMatchObject({ cwd: '/x/B' });
    expect(bashChangedPaths('true | (cd src/deep && cp x ../app.ts)', '/proj')).toEqual(['/proj/src/app.ts']);
    // A nested shell's own jobs stay inside it: its zsh-only `cd` leaves the outer shell's dir known.
    const kept = handoffsOf("sh -c 'true | cd ../B'; git push origin main", '/x/A', rules)[0];
    expect([kept?.cwd, kept?.unclear]).toEqual(['/x/A', undefined]);
    expect(handoffsOf("eval 'true | cd ../B'; git push origin main", '/x/A', rules)[0]?.unclear).toContain('cannot follow');
    // `env -C dir` runs what its program runs in dir too.
    expect(handoffsOf("env -C ../B sh -c 'git push origin main'", '/x/A', rules)[0]?.cwd).toBe('/x/B');
  });
});

describe('closing review: the program word and what runs a substitution', () => {
  test('a substitution that names the program does not hide the command after it', () => {
    expect(handoffsOf('$(which env) git push origin main', '/x', rules)).toHaveLength(1);
    expect(handoffsOf('`command -v sudo` git push origin main', '/x', rules)).toHaveLength(1);
    expect(classifyOutward(`$(which env) ${stripe}`, '/proj').some((t) => t.mutating)).toBe(true);
    expect(resultDirWrite('$(which env) cp /tmp/f .claude/tests/x.json', '/proj')).not.toBeNull();
    expect(handoffsOf('env -P /usr/bin git push origin main', '/x', rules)).toHaveLength(1);
  });

  test("an unquoted heredoc body's quotes are text: they hide no substitution", () => {
    expect(handoffsOf("cat <<EOF\na\"b'$(git push origin main)'\nEOF", '/x', rules)).toHaveLength(1);
  });

  test('`eval` of a substitution that may push is unclear', () => {
    expect(handoffsOf('eval "$(echo git push origin main)"', '/x', rules)[0]?.unclear).toContain('output of a command substitution');
  });

  test('a long `env -S` chain is truncated, not read in quadratic time', () => {
    // Each split string is `env` again, which takes the next `-S`.
    const chain = `env ${'-S env '.repeat(20_000)}git push origin main`;
    const started = Date.now();
    expect(readCommand(chain, '/x').truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('deploys and costs', () => {
  test('an untested `tofu apply` is a deploy hand-off, like terraform', () => {
    expect(handoffsOf('tofu apply -auto-approve', REPO, rules).filter((h) => h.kind === 'deploy')).toHaveLength(1);
  });

  test('carriers are looked up per word, not per word × carrier', () => {
    const vars = Array.from({ length: 3_000 }, (_, i) => `v${i}`).join(' ');
    const words = Array.from({ length: 3_000 }, (_, i) => `/tmp/o${i}`).join(' ');
    const cmd = `ls .claude/tests | while read ${vars}; do cp ${words} /tmp/out; done`;
    const started = Date.now();
    expect(resultDirWrite(cmd, '/proj')).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
