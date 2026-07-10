import { describe, expect, test } from 'bun:test';
import { hasBin } from '../hooks/post-tool-use';

// hasBin: 자동 검증이 어떤 러너(bun/npm)를 쓸지 정하는 데 쓰인다.
// Windows에서 execSync의 기본 셸은 cmd.exe라 POSIX `command -v`가 항상 실패했다
// (→ bun이 설치돼 있어도 npm으로 폴백). 플랫폼별 명령을 쓰는지 확인한다.

describe('hasBin', () => {
  test('PATH에 존재하는 실행 파일 => true', () => {
    // sh는 모든 지원 플랫폼(Git Bash 포함)에 있다. bun 테스트 러너 자체도 보장됨.
    expect(hasBin('bun')).toBe(true);
  });

  test('존재하지 않는 실행 파일 => false', () => {
    expect(hasBin('goodboy-definitely-not-a-real-binary')).toBe(false);
  });

  test('셸 메타문자가 섞인 이름은 실행하지 않고 false', () => {
    // 주입 방지: `;`/`|`/공백 등이 들어오면 조회 자체를 하지 않는다.
    expect(hasBin('bun; touch /tmp/goodboy-hasbin-pwned')).toBe(false);
    expect(hasBin('bun && echo x')).toBe(false);
    expect(hasBin('')).toBe(false);
  });

  test('win32에서는 where, 그 외에는 command -v를 쓴다', () => {
    // 플랫폼 분기 자체를 검증(실제 win32 환경이 없으므로 구현 상수 확인).
    const src = Bun.file(new URL('../hooks/post-tool-use.ts', import.meta.url)).text();
    return src.then((text) => {
      expect(text).toContain("process.platform === 'win32'");
      expect(text).toContain('where ${name}');
      expect(text).toContain('command -v ${name}');
    });
  });
});
