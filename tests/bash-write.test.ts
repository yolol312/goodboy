import { describe, expect, test } from 'bun:test';
import { classifyBashWrite } from '../lib/bash-write';

// 라이브 검증에서 발견: 추론 게이트에 8회 막힌 서브에이전트가
// `cat > src/index.ts <<'EOF'` 로 소스를 덮어써 모든 편집 게이트를 우회했다.

const CWD = '/proj';

function denied(cmd: string, cwd = CWD): string[] {
  return classifyBashWrite(cmd, cwd);
}

describe('classifyBashWrite — 차단해야 하는 쓰기', () => {
  test('heredoc 리다이렉션 (실제 관측된 우회)', () => {
    expect(denied("cat > /proj/src/index.ts << 'EOF'\nx\nEOF")).toEqual(['/proj/src/index.ts']);
  });

  test('상대 경로 리다이렉션', () => {
    expect(denied('echo hi > src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('append 리다이렉션', () => {
    expect(denied('echo hi >> src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('공백 없는 리다이렉션', () => {
    expect(denied('echo hi >src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('tee', () => {
    expect(denied('echo hi | tee src/app.ts')).toEqual(['/proj/src/app.ts']);
    expect(denied('echo hi | tee -a src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('sed -i (GNU/BSD 양쪽)', () => {
    expect(denied("sed -i 's/a/b/' src/app.ts")).toEqual(['/proj/src/app.ts']);
    expect(denied("sed -i '' 's/a/b/' src/app.ts")).toEqual(['/proj/src/app.ts']);
    expect(denied("sed -i.bak 's/a/b/' src/app.ts")).toEqual(['/proj/src/app.ts']);
  });

  test('dd of=', () => {
    expect(denied('dd if=/dev/zero of=src/app.ts bs=1')).toEqual(['/proj/src/app.ts']);
  });

  test('체인 명령 안의 쓰기도 잡는다', () => {
    expect(denied('cd /proj && echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('여러 대상은 모두 보고한다', () => {
    const r = denied('echo a > src/a.ts; echo b > src/b.ts');
    expect(r.sort()).toEqual(['/proj/src/a.ts', '/proj/src/b.ts']);
  });
});

describe('classifyBashWrite — 허용해야 하는 것 (오탐 방지)', () => {
  test('/dev/null 및 fd 복제', () => {
    expect(denied('make 2>/dev/null')).toEqual([]);
    expect(denied('make > /dev/null 2>&1')).toEqual([]);
    expect(denied('echo err >&2')).toEqual([]);
  });

  test('프로젝트 밖 경로 (mktemp -d 프로브)', () => {
    expect(denied('echo x > /var/folders/xy/probe.ts')).toEqual([]);
    expect(denied('echo x > ../outside.ts')).toEqual([]);
  });

  test('프로젝트가 임시 폴더 안에 있어도 게이트가 산다 (실측 회귀)', () => {
    // "tmpdir 하위는 전부 허용"으로 구현했더니 샌드박스/임시 프로젝트에서
    // 게이트가 통째로 무력화됐다. cwd 기준으로만 판정해야 한다.
    const tmpProj = '/var/folders/zz/goodboy-proj';
    expect(classifyBashWrite('echo x > src/app.ts', tmpProj)).toEqual([
      '/var/folders/zz/goodboy-proj/src/app.ts',
    ]);
    // 그 프로젝트 밖의 임시 경로는 여전히 허용
    expect(classifyBashWrite('echo x > /var/folders/zz/probe.ts', tmpProj)).toEqual([]);
  });

  test('산출물/메타 디렉터리', () => {
    expect(denied('echo x > dist/bundle.js')).toEqual([]);
    expect(denied('echo x > node_modules/.cache/y')).toEqual([]);
    expect(denied('git log > .git/notes')).toEqual([]);
    expect(denied('echo x > .claude/reviews/r.json')).toEqual([]);
  });

  test('로그 파일', () => {
    expect(denied('bun run build > build.log')).toEqual([]);
    expect(denied('bun test 2>> test.log')).toEqual([]);
  });

  test('읽기 전용 명령은 무관', () => {
    expect(denied('cat src/app.ts')).toEqual([]);
    expect(denied('grep -n foo src/app.ts')).toEqual([]);
    expect(denied('sed -n 1,5p src/app.ts')).toEqual([]);
    expect(denied('diff a.ts b.ts')).toEqual([]);
  });

  test('입력 리다이렉션은 쓰기가 아니다', () => {
    expect(denied('bun lib/cli.ts review-write < review.json')).toEqual([]);
  });

  test('파이프로 CLI에 넘기는 리뷰 작성 방식은 통과 (리뷰 루프 보호)', () => {
    expect(denied("cat <<'JSON' | bun /plug/lib/cli.ts review-write\n{}\nJSON")).toEqual([]);
  });

  test('변수/글롭이 섞인 타깃은 판정 불가 → 허용(fail-open)', () => {
    expect(denied('echo x > $OUT')).toEqual([]);
    expect(denied('echo x > "${TMPDIR}/f"')).toEqual([]);
  });

  test('빈/비문자열 입력', () => {
    expect(denied('')).toEqual([]);
    expect(classifyBashWrite(undefined as unknown as string, CWD)).toEqual([]);
  });
});

describe('classifyBashWrite — GOODBOY_BASH_WRITE_ALLOW', () => {
  test('사용자 지정 접두사는 허용', () => {
    const prev = process.env.GOODBOY_BASH_WRITE_ALLOW;
    process.env.GOODBOY_BASH_WRITE_ALLOW = 'scratch,tmpout';
    try {
      expect(denied('echo x > scratch/probe.ts')).toEqual([]);
      expect(denied('echo x > tmpout/a')).toEqual([]);
      expect(denied('echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
    } finally {
      if (prev === undefined) delete process.env.GOODBOY_BASH_WRITE_ALLOW;
      else process.env.GOODBOY_BASH_WRITE_ALLOW = prev;
    }
  });
});
