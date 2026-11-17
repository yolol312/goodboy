// M6g (track M, #19): the switch of the privacy run gate is the user's, not a command's. The CLI reads it from its own process
// environment, which a model could set inline (`NAME=off bun cli.ts sandbox-run`), so the PreToolUse data guard
// (lib/sandbox-data-guard.ts) denies every command that sets it, in every context, with one fixed text.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sandboxDataDenial, sandboxDataMessage } from '../lib/sandbox-data-guard';
import { privacyGateOff, switchFromFile } from '../lib/sandbox-privacy-gate';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const NAME = 'GOODBOY_SANDBOX_PRIVACY_GATE';
const RUN = `bun ${CLI} sandbox-run --suite unit`;

let base = '';
let plain = '';
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6g-switch-')));
  plain = join(base, 'plain');
  mkdirSync(plain, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const denial = (command: string, toolName = 'Bash', cwd = plain) => sandboxDataDenial({ toolName, toolInput: { command }, cwd, projectCwd: cwd });
const denied = (command: string, toolName = 'Bash'): boolean => denial(command, toolName)?.fixed !== undefined;

describe('every way a command sets the switch is denied', () => {
  const forms: [string, string][] = [
    ['inline before the program', `${NAME}=off ${RUN}`],
    ['inline with a quoted value', `${NAME}="off" ${RUN}`],
    ['inline with other assignments first', `FOO=1 ${NAME}=off BAR=2 ${RUN}`],
    ['export, then the run', `export ${NAME}=off; ${RUN}`],
    ['export with &&', `export ${NAME}=off && ${RUN}`],
    ['export with a quoted name', `export "${NAME}"=off; ${RUN}`],
    ['export with the whole assignment quoted', `export '${NAME}=off'; ${RUN}`],
    ['export of several, one the switch', `export A=1 ${NAME}=off B=2`],
    ['env', `env ${NAME}=off ${RUN}`],
    ['env with a quoted assignment', `env "${NAME}=off" ${RUN}`],
    ['env with options first', `env -i PATH=$PATH ${NAME}=off ${RUN}`],
    ['env -S', `env -S '${NAME}=off ${RUN}'`],
    ['env --split-string', `env --split-string="${NAME}=off ${RUN}"`],
    ['declare -x', `declare -x ${NAME}=off; ${RUN}`],
    ['typeset -x', `typeset -x ${NAME}=off; ${RUN}`],
    ['readonly', `readonly ${NAME}=off; ${RUN}`],
    ['local', `f() { local ${NAME}=off; ${RUN}; }; f`],
    ['set -a and a bare assignment', `set -a; ${NAME}=off; set +a; ${RUN}`],
    ['a bare assignment alone', `${NAME}=off`],
    ['an append', `${NAME}+=x ${RUN}`],
    ['sudo and env', `sudo -u me env ${NAME}=off ${RUN}`],
    ['the rtk proxy', `rtk proxy env ${NAME}=off ${RUN}`],
    ['a nested bash -c', `bash -c '${NAME}=off ${RUN}'`],
    ['a nested sh -c with export', `sh -c "export ${NAME}=off && ${RUN}"`],
    ['eval', `eval "${NAME}=off ${RUN}"`],
    ['eval of a substitution', `eval "$(echo '${NAME}=off ${RUN}')"`],
    ['xargs env', `echo x | xargs -I{} env ${NAME}=off ${RUN}`],
    ['find -exec env', `find . -maxdepth 0 -exec env ${NAME}=off ${RUN} ';'`],
    ['a subshell', `(${NAME}=off ${RUN})`],
    ['a pipe into a shell', `echo '${NAME}=off ${RUN}' | sh`],
    ['a heredoc fed to a shell', `bash <<EOF\n${NAME}=off ${RUN}\nEOF`],
    ['an interpreter that spawns it', `python3 -c "import subprocess; subprocess.run('${NAME}=off ${RUN}', shell=True)"`],
    ['after another command', `echo start; ${NAME}=off ${RUN}`],
  ];

  for (const [label, command] of forms) {
    test(label, () => {
      const hit = denial(command);
      expect([command, hit?.fixed !== undefined]).toEqual([command, true]);
    });
  }

  test('the assignment itself is read, not only its company: a program that runs no text and a program the reader does not know', () => {
    for (const command of [
      `${NAME}=off ./run-suite.sh`,
      `FOO=1 ${NAME}=off ./run-suite.sh`,
      `${NAME}+=x ./run-suite.sh`,
      `env ${NAME}=off ./run-suite.sh`,
      `env "${NAME}=off" ./run-suite.sh`,
      `env -S '${NAME}=off ./run-suite.sh'`,
      `rtk proxy env ${NAME}=off ./run-suite.sh`,
      `rtk env "${NAME}=off" ./run-suite.sh`,
      `sudo env ${NAME}=off ./run-suite.sh`,
      `export ${NAME}=off`,
      `declare -x ${NAME}=off`,
      `typeset -x ${NAME}=off`,
      `readonly ${NAME}=off`,
      `export "${NAME}=off"`,
      `echo go && ${NAME}=off ./run-suite.sh`,
    ]) {
      expect([command, denied(command)]).toEqual([command, true]);
    }
  });

  test('a PowerShell call is denied on the spelling alone', () => {
    expect(denied(`$env:${NAME} = 'off'; ${RUN}`, 'PowerShell')).toBe(true);
    expect(denied(`$env:${NAME}='off'`, 'PowerShell')).toBe(true);
    expect(denied(`$env:${NAME} = 'off'; ./run-suite.ps1`, 'PowerShell')).toBe(true);
    expect(denied(`set ${NAME}=off`, 'PowerShell')).toBe(true);
    expect(denied(`$env:${NAME}`, 'PowerShell')).toBe(false);
    expect(denied(`Write-Host $env:${NAME}`, 'PowerShell')).toBe(false);
  });

  test('any tool whose input is a shell command is asked, not Bash only', () => {
    expect(denied(`${NAME}=off ${RUN}`, 'Monitor')).toBe(true);
  });

  test('a command too large to read to the end that names the switch is denied', () => {
    const long = `${'true; '.repeat(6000)}${RUN} # ${NAME}`;
    expect(denied(long)).toBe(true);
  });
});

describe('what is not a command that sets it passes', () => {
  const passes = [
    `${RUN}`,
    `${NAME}x=off ${RUN}`,
    `X${NAME}=off ${RUN}`,
    `GOODBOY_SANDBOX_DATA_GATE=off ${RUN}`,
    `GOODBOY_SANDBOX_PRIVACY=off ${RUN}`,
    `FOO=bar ${RUN}`,
    'export FOO=1; export BAR=2',
    `export ${NAME}`,
    `env -u ${NAME} ${RUN}`,
    `unset ${NAME}; ${RUN}`,
    `echo $${NAME}`,
    `echo "${NAME} is the user's"`,
    `grep ${NAME} README.md`,
    `grep '${NAME}=off' README.md docs/stabilization-plan.md`,
    `rg -n "${NAME}=off" .`,
    `cat README.md | grep ${NAME}`,
    `git commit -m "docs: ${NAME}=off is the user's switch"`,
    `git log --grep=${NAME}`,
    'cat docs/stabilization-plan.md',
  ];
  for (const command of passes) {
    test(command.slice(0, 70), () => {
      expect([command, denial(command)]).toEqual([command, null]);
    });
  }
});

describe('the denial is one fixed text, with no way around it offered', () => {
  test('the same text for the main session and a subagent, whatever the context, naming no variable and no marker', () => {
    const hit = denial(`${NAME}=off ${RUN}`)!;
    const main = sandboxDataMessage(hit, { cli: CLI, subagent: false, marker: '.claude/.goodboy-sandbox-data-approved-x.txt' });
    const sub = sandboxDataMessage(hit, { cli: CLI, subagent: true });
    expect(main).toBe(sub);
    expect(main).toBe(hit.fixed!);
    expect(main).not.toMatch(/GOODBOY_|touch|approv|marker|settings\.json|env var/i);
    // every form gets that text
    expect(new Set(['export X=1; ' + `export ${NAME}=off`, `env ${NAME}=off ${RUN}`].map((c) => denial(c)!.fixed)).size).toBe(1);
    expect(denial(`env ${NAME}=off ${RUN}`)!.what).toBe('a command that sets a goodboy gate switch');
  });

  test('in a project with a real-data sandbox, and in one with none, the same', () => {
    const real = join(base, 'real');
    mkdirSync(join(real, '.goodboy/sandbox'), { recursive: true });
    writeFileSync(join(real, '.goodboy/sandbox/local.json'), JSON.stringify({ dump: null, dumpFormat: null, realData: true }));
    const a = denial(`${NAME}=off ${RUN}`, 'Bash', real);
    const b = denial(`${NAME}=off ${RUN}`, 'Bash', plain);
    expect(a?.fixed).toBeDefined();
    expect(a).toEqual(b);
    // a hit of the data rule is still its own: no fixed text
    expect(denial('psql -h db -U x shop', 'Bash', real)?.fixed).toBeUndefined();
  });

  test('the CLI still reads the switch from its process environment, the user’s settings', () => {
    expect(privacyGateOff({ [NAME]: 'off' })).toBe(true);
    expect(privacyGateOff({ [NAME]: 'on' })).toBe(false);
    expect(privacyGateOff({})).toBe(false);
  });

  test('a switch that may come from a dotenv file is not taken: Bun loads `.env` files and `--env-file` on its own (delta review)', () => {
    const dir = join(base, 'dotenv');
    mkdirSync(dir, { recursive: true });
    expect(switchFromFile(dir, [])).toBe(false);
    expect(switchFromFile(dir, ['--env-file=x.env'])).toBe(true);
    expect(switchFromFile(dir, ['--env-file', 'x.env'])).toBe(true);
    for (const [name, text] of [
      ['.env', `${NAME}=off\n`],
      ['.env.local', `export ${NAME}=off\n`],
      ['.env.development', `OTHER=1\n  "${NAME}" = off\n`],
      ['.env.test.local', `${NAME}: off\n`],
    ] as const) {
      writeFileSync(join(dir, name), text);
      expect([name, switchFromFile(dir, [])]).toEqual([name, true]);
      rmSync(join(dir, name));
    }
    // a dotenv file that does not set the switch, or one that only mentions it, changes nothing
    writeFileSync(join(dir, '.env'), `OTHER=1\n# ${NAME} is the user's\nNOT_${NAME}=off\n`);
    expect(switchFromFile(dir, [])).toBe(false);
    // a dotenv path that is no regular file counts (a link, a dir)
    rmSync(join(dir, '.env'));
    mkdirSync(join(dir, '.env'));
    expect(switchFromFile(dir, [])).toBe(true);
    // the switch then keeps the gate on
    expect(privacyGateOff({ [NAME]: 'off' }, () => true)).toBe(false);
    expect(privacyGateOff({ [NAME]: 'off' }, () => false)).toBe(true);
  });

  test('the CLI ignores a switch a `.env` in its dir sets, and takes the same switch from its process environment', () => {
    const dir = join(base, 'cli-dotenv');
    mkdirSync(dir, { recursive: true });
    const probe = `import { privacyGateOff } from ${JSON.stringify(resolve(import.meta.dir, '..', 'lib', 'sandbox-privacy-gate.ts'))};\nconsole.log(privacyGateOff() ? 'off' : 'on');\n`;
    writeFileSync(join(dir, 'probe.ts'), probe);
    const run = (env: Record<string, string>) => {
      const r = Bun.spawnSync(['bun', 'probe.ts'], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });
      return r.stdout.toString().trim();
    };
    expect(run({ [NAME]: 'off' })).toBe('off');
    writeFileSync(join(dir, '.env'), `${NAME}=off\n`);
    expect(run({})).toBe('on');
  });
});

describe('through the PreToolUse hook', () => {
  async function call(command: string, o: { sub?: boolean; marker?: boolean; tool?: string } = {}): Promise<{ denied: boolean; reason: string; system: string }> {
    const sid = `m6g-${Math.random().toString(36).slice(2)}`;
    if (o.marker) {
      mkdirSync(join(plain, '.claude'), { recursive: true });
      writeFileSync(join(plain, `.claude/.goodboy-sandbox-data-approved-${sid.slice(0, 8)}.txt`), '');
    }
    const payload = {
      session_id: sid,
      cwd: plain,
      hook_event_name: 'PreToolUse',
      tool_name: o.tool ?? 'Bash',
      tool_input: { command },
      tool_use_id: `t-${Math.random().toString(36).slice(2)}`,
      ...(o.sub ? { agent_type: 'goodboy:build-infra', agent_id: 'b1' } : {}),
    };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd: plain,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, HOME: base, GOODBOY_REGISTRY_DIR: join(base, 'registry') },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', system: String(out.systemMessage ?? '') };
  }

  test('denied in the main session and in a subagent, with the fixed text; the user is told in the system message', async () => {
    const [main, sub] = await Promise.all([call(`${NAME}=off ${RUN}`), call(`${NAME}=off ${RUN}`, { sub: true })]);
    expect(main.denied).toBe(true);
    expect(sub.denied).toBe(true);
    expect(main.reason).toBe(sub.reason);
    expect(main.reason).toContain(denial(`${NAME}=off ${RUN}`)!.fixed!);
    expect(main.system).toContain('[goodboy]');
    expect(main.system).not.toContain(NAME);
    expect(sub.system).toBe('');
  });

  test('the user’s one-use marker does not pass it', async () => {
    const r = await call(`export ${NAME}=off; ${RUN}`, { marker: true });
    expect(r.denied).toBe(true);
    expect(r.reason).not.toMatch(/touch|marker/i);
  });

  test('the command without the assignment is not stopped by this rule', async () => {
    const r = await call(RUN);
    expect([r.denied, r.reason.includes('gate switch')]).toEqual([false, false]);
  });
});
