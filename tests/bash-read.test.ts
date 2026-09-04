// lib/bash-read.ts — Bash로 읽은 파일 탐지.
//
// 이 추적이 없으면 bypass permissions 모드(시스템이 "cat/sed로 읽어라"라고 지시)에서
// 읽기 이력이 0이 되어 read-before-edit이 오차단하고 층0 인용 검증이 근거를 잃는다.
//
// 반대 방향의 위험도 같이 지킨다: grep을 읽기로 인정하면 `grep -l foo .` 후 편집이
// 통과해 read-before-edit이 실질 무력화된다.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyBashRead, safeMtime } from '../lib/bash-read';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** 파일 몇 개가 실재하는 프로젝트 샌드박스. */
function newProject(files: string[] = ['src/a.ts', 'README.md']): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-br-'));
  tmpDirs.push(cwd);
  for (const f of files) {
    const abs = resolve(cwd, f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'line1\nline2\nline3\n', 'utf8');
  }
  return cwd;
}

describe('classifyBashRead — 내용을 보여주는 명령', () => {
  test('cat 은 읽기로 기록한다', () => {
    const cwd = newProject();
    expect(classifyBashRead('cat src/a.ts', cwd)).toEqual([resolve(cwd, 'src/a.ts')]);
  });

  test('여러 파일을 한 번에 읽으면 전부 기록한다', () => {
    const cwd = newProject();
    const got = classifyBashRead('cat src/a.ts README.md', cwd);
    expect(got.sort()).toEqual([resolve(cwd, 'README.md'), resolve(cwd, 'src/a.ts')].sort());
  });

  test('head -n 20 의 옵션 값을 파일로 오인하지 않는다', () => {
    const cwd = newProject();
    expect(classifyBashRead('head -n 20 src/a.ts', cwd)).toEqual([resolve(cwd, 'src/a.ts')]);
  });

  test("sed -n '10,40p' FILE 은 스크립트를 건너뛰고 파일만 잡는다", () => {
    const cwd = newProject();
    expect(classifyBashRead("sed -n '1,3p' src/a.ts", cwd)).toEqual([resolve(cwd, 'src/a.ts')]);
  });

  test('sed -i 는 읽기가 아니다 (쓰기 — bash-write 소관)', () => {
    const cwd = newProject();
    expect(classifyBashRead("sed -i '' 's/a/b/' src/a.ts", cwd)).toEqual([]);
  });

  test('파이프 뒤의 리더도 잡는다', () => {
    const cwd = newProject();
    expect(classifyBashRead('cat src/a.ts | head -3', cwd)).toEqual([resolve(cwd, 'src/a.ts')]);
  });

  test('리다이렉션 대상은 읽기가 아니다', () => {
    const cwd = newProject();
    // out.txt는 쓰기 대상 — 읽은 파일로 기록되면 안 된다.
    expect(classifyBashRead('cat src/a.ts > out.txt', cwd)).toEqual([resolve(cwd, 'src/a.ts')]);
  });

  test('env 대입 접두사를 건너뛴다', () => {
    const cwd = newProject();
    expect(classifyBashRead('LC_ALL=C cat src/a.ts', cwd)).toEqual([resolve(cwd, 'src/a.ts')]);
  });

  test('절대경로로 읽어도 잡는다', () => {
    const cwd = newProject();
    expect(classifyBashRead(`cat ${resolve(cwd, 'src/a.ts')}`, cwd)).toEqual([
      resolve(cwd, 'src/a.ts'),
    ]);
  });
});

describe('classifyBashRead — 읽기로 보지 않는 것', () => {
  test('grep 은 읽기가 아니다 — 검색은 "그 파일을 봤다"는 증거가 아니다', () => {
    const cwd = newProject();
    expect(classifyBashRead('grep -n foo src/a.ts', cwd)).toEqual([]);
    expect(classifyBashRead('grep -rl foo .', cwd)).toEqual([]);
  });

  test('rg / awk / find 도 읽기가 아니다', () => {
    const cwd = newProject();
    expect(classifyBashRead('rg foo src/a.ts', cwd)).toEqual([]);
    expect(classifyBashRead("awk '{print}' src/a.ts", cwd)).toEqual([]);
    expect(classifyBashRead('find . -name "*.ts"', cwd)).toEqual([]);
  });

  test('프로젝트 밖 파일은 추적하지 않는다', () => {
    const cwd = newProject();
    expect(classifyBashRead('cat /etc/hosts', cwd)).toEqual([]);
  });

  test('실재하지 않는 경로는 기록하지 않는다', () => {
    const cwd = newProject();
    expect(classifyBashRead('cat src/nope.ts', cwd)).toEqual([]);
  });

  test('디렉터리는 기록하지 않는다', () => {
    const cwd = newProject();
    expect(classifyBashRead('cat src', cwd)).toEqual([]);
  });

  test('변수/글롭이 섞이면 판정하지 않는다 (잘못된 경로 기록 방지)', () => {
    const cwd = newProject();
    expect(classifyBashRead('cat $FILE', cwd)).toEqual([]);
    expect(classifyBashRead('cat src/*.ts', cwd)).toEqual([]);
  });

  test('heredoc 본문의 단어를 명령으로 오인하지 않는다', () => {
    const cwd = newProject();
    const cmd = 'bun x <<EOF\ncat src/a.ts\nEOF';
    expect(classifyBashRead(cmd, cwd)).toEqual([]);
  });

  test('따옴표 안의 cat 은 명령이 아니다', () => {
    const cwd = newProject();
    expect(classifyBashRead('echo "cat src/a.ts"', cwd)).toEqual([]);
  });

  test('빈 명령/비문자열은 빈 배열 (fail-open)', () => {
    const cwd = newProject();
    expect(classifyBashRead('', cwd)).toEqual([]);
    // @ts-expect-error 런타임 견고성 확인
    expect(classifyBashRead(null, cwd)).toEqual([]);
  });
});

describe('safeMtime', () => {
  test('실재 파일은 숫자를 반환', () => {
    const cwd = newProject();
    expect(typeof safeMtime(resolve(cwd, 'src/a.ts'))).toBe('number');
  });

  test('없는 파일은 undefined (기록은 mtime 없이 진행)', () => {
    expect(safeMtime('/nowhere/x.ts')).toBeUndefined();
  });
});
