import { afterEach, describe, expect, test } from 'bun:test';
import {
  bashOutputFloodMessage,
  bashOutputWarnThresholds,
  classifyBashFlood,
  compactForcePct,
  extractBashOutput,
  measureOutput,
  TOKEN_HABITS,
  wantsDetail,
} from '../lib/token-habits';

const savedEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe('token-habits catalog', () => {
  test('catalog includes all five habit IDs', () => {
    for (const id of ['H1-01', 'H1-03', 'H2-01', 'H2-02', 'H5-04']) {
      expect(TOKEN_HABITS[id]).toBeDefined();
      expect(TOKEN_HABITS[id]!.id).toBe(id);
      expect(Array.isArray(TOKEN_HABITS[id]!.envVars)).toBe(true);
    }
  });
});

describe('H1-03 compact force threshold', () => {
  test('default force threshold is 50%', () => {
    setEnv('VCF_COMPACT_FORCE_PCT', undefined);
    expect(compactForcePct()).toBe(50);
  });

  test('VCF_COMPACT_FORCE_PCT overrides the force threshold', () => {
    setEnv('VCF_COMPACT_FORCE_PCT', '65');
    expect(compactForcePct()).toBe(65);
  });

  test('catalog H1-03 exposes VCF_COMPACT_FORCE_PCT default 50', () => {
    expect(TOKEN_HABITS['H1-03']!.envVars).toContain('VCF_COMPACT_FORCE_PCT');
    expect(TOKEN_HABITS['H1-03']!.defaults.VCF_COMPACT_FORCE_PCT).toBe(50);
  });
});

describe('H2-02 classifyBashFlood', () => {
  test('flags cat of a .log file', () => {
    expect(classifyBashFlood('cat /var/log/app.log')).toBe('cat-log');
  });
  test('flags cat of a glob', () => {
    expect(classifyBashFlood('cat logs/*.txt')).toBe('cat-glob');
  });
  test('flags broad find from root', () => {
    expect(classifyBashFlood('find / -name foo')).toBe('find-broad');
  });
  test('flags whole journalctl stream', () => {
    expect(classifyBashFlood('journalctl -u nginx')).toBe('whole-log');
  });

  // 라이브에서 실제로 놓쳤던 형태: 경로 + glob + 리다이렉트 + `|| echo`.
  test('flags cat of path/*.log even with redirect and || echo', () => {
    expect(classifyBashFlood('cat /Users/x/workspace/vcf/*.log 2>/dev/null || echo NO_LOG')).toBe(
      'cat-log',
    );
  });
  test('flags cat of path glob with redirect (no .log)', () => {
    expect(classifyBashFlood('cat src/*.txt 2>/dev/null || true')).toBe('cat-glob');
  });
  test('flags broad find from root with prune/redirect', () => {
    expect(classifyBashFlood('find / -name "*.log" 2>/dev/null')).toBe('find-broad');
  });

  test('does NOT flag when output is already limited', () => {
    expect(classifyBashFlood('cat /var/log/app.log | head -n 50')).toBeNull();
    expect(classifyBashFlood('cat /var/log/app.log | grep ERROR')).toBeNull();
    expect(classifyBashFlood('tail -n 100 /var/log/app.log')).toBeNull();
    expect(classifyBashFlood('journalctl -u nginx -n 100')).toBeNull();
    // 제한자가 붙은 대표적 정상 형태들.
    expect(classifyBashFlood('echo hello | head')).toBeNull();
    expect(classifyBashFlood('cat logs/*.txt | wc -l')).toBeNull();
    expect(classifyBashFlood('grep ERROR /var/log/app.log')).toBeNull();
  });

  test('does NOT flag normal short commands', () => {
    expect(classifyBashFlood('ls -la')).toBeNull();
    expect(classifyBashFlood('git status')).toBeNull();
    expect(classifyBashFlood('cat package.json')).toBeNull();
    expect(classifyBashFlood('echo hello')).toBeNull();
    expect(classifyBashFlood('')).toBeNull();
  });
});

describe('H5-04 wantsDetail', () => {
  test('detects Korean detail-request signals', () => {
    expect(wantsDetail('이 코드를 자세히 설명해줘')).toBe(true);
    expect(wantsDetail('전체 흐름을 상세하게 알려줘')).toBe(true);
    expect(wantsDetail('길게 풀어서 설명')).toBe(true);
  });
  test('detects English detail-request signals', () => {
    expect(wantsDetail('explain this in more detail')).toBe(true);
    expect(wantsDetail('please expand on that')).toBe(true);
  });
  test('returns false for concise/normal prompts', () => {
    expect(wantsDetail('fix the login bug')).toBe(false);
    expect(wantsDetail('')).toBe(false);
  });
});


describe('H2-02 output-size helpers', () => {
  test('bashOutputWarnThresholds defaults to 10000 chars / 200 lines', () => {
    setEnv('VCF_BASH_OUTPUT_WARN_CHARS', undefined);
    setEnv('VCF_BASH_OUTPUT_WARN_LINES', undefined);
    expect(bashOutputWarnThresholds()).toEqual({ chars: 10_000, lines: 200 });
  });

  test('bashOutputWarnThresholds honors env overrides', () => {
    setEnv('VCF_BASH_OUTPUT_WARN_CHARS', '5');
    setEnv('VCF_BASH_OUTPUT_WARN_LINES', '9');
    expect(bashOutputWarnThresholds()).toEqual({ chars: 5, lines: 9 });
  });

  test('extractBashOutput handles string, object, and junk', () => {
    expect(extractBashOutput('raw text')).toBe('raw text');
    expect(extractBashOutput({ stdout: 'a', stderr: 'b' })).toBe('a\nb');
    expect(extractBashOutput({ output: 'c' })).toBe('c');
    expect(extractBashOutput(null)).toBe('');
    expect(extractBashOutput(42)).toBe('');
  });

  test('measureOutput counts chars and lines', () => {
    expect(measureOutput('')).toEqual({ chars: 0, lines: 0 });
    expect(measureOutput('a\nb\nc')).toEqual({ chars: 5, lines: 3 });
  });

  test('bashOutputFloodMessage carries H2-02, sizes, and optional pattern note', () => {
    const m = bashOutputFloodMessage(12345, 300, 'cat-log');
    expect(m).toContain('H2-02');
    expect(m).toContain('300줄');
    expect(m).toContain('cat-log');
    const m2 = bashOutputFloodMessage(12345, 300, null);
    expect(m2).toContain('H2-02');
    expect(m2).not.toContain('위험 패턴');
  });
});
