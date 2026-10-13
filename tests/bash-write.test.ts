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

  // A6: relative targets resolve against the directory `cd` moved to.
  test('cd outside the project, then a relative write => not a project write', () => {
    expect(denied('cd /tmp/scratch && cat > measure.ts')).toEqual([]);
    expect(denied('cd "/tmp/my scratch"; echo x > a.ts')).toEqual([]);
    expect(denied('cd /tmp/scratch && echo hi | tee out.ts')).toEqual([]);
  });

  test('cd into a project subdirectory still counts', () => {
    expect(denied('cd src && echo x > app.ts')).toEqual(['/proj/src/app.ts']);
    expect(denied('cd /tmp && cd /proj/src && echo x > app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('a write before the cd resolves against the original cwd', () => {
    expect(denied('echo x > src/app.ts && cd /tmp')).toEqual(['/proj/src/app.ts']);
  });

  test('absolute targets ignore cd', () => {
    expect(denied('cd /tmp && echo x > /proj/src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('cd to HOME or ~ resolves to the home directory (outside the project)', () => {
    expect(denied('cd && echo x > a.ts')).toEqual([]);
    expect(denied('cd ~/work && echo x > a.ts')).toEqual([]);
  });

  // Review of A6: never weaker than ignoring cd. Unknowable dirs fall back to the cwd.
  test('cd to an unknowable dir ($VAR, ~user) falls back to the original cwd', () => {
    expect(denied('cd $DIR && echo x > a.ts')).toEqual(['/proj/a.ts']);
    expect(denied('cd ~bob && echo x > a.ts')).toEqual(['/proj/a.ts']);
  });

  test('a cd inside a subshell or command substitution does not leak out', () => {
    expect(denied('(cd /tmp && ls) && echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
    expect(denied('(cd /tmp); echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
    expect(denied('echo $(cd /tmp && pwd) > src/app.ts')).toEqual(['/proj/src/app.ts']);
    expect(denied('(cd /tmp && echo x > probe.ts)')).toEqual([]);
  });

  test('cd options and cd - are handled', () => {
    expect(denied('cd -P /tmp && echo x > a.ts')).toEqual([]);
    expect(denied('cd -- /tmp && echo x > a.ts')).toEqual([]);
    expect(denied('cd /tmp && cd - && echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
    expect(denied('cd - && echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('"cd" inside quotes or as part of a word is not a cd', () => {
    expect(denied('echo "cd /tmp" && echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
    expect(denied('abcd /tmp; echo x > src/app.ts')).toEqual(['/proj/src/app.ts']);
  });

  test('여러 대상은 모두 보고한다', () => {
    const r = denied('echo a > src/a.ts; echo b > src/b.ts');
    expect(r.sort()).toEqual(['/proj/src/a.ts', '/proj/src/b.ts']);
  });

  test('따옴표로 감싼 대상 경로도 잡는다 (v0.26.1 스캐너 회귀 방지)', () => {
    expect(denied('echo x > "src/a.ts"')).toEqual(['/proj/src/a.ts']);
    expect(denied("echo x > 'src/a.ts'")).toEqual(['/proj/src/a.ts']);
  });

  test('heredoc이어도 같은 줄의 리다이렉션 대상은 잡는다 (본문만 제거)', () => {
    expect(denied('cat <<EOF > src/a.ts\nif (x >= 1) y()\nEOF')).toEqual(['/proj/src/a.ts']);
    expect(denied("cat <<'EOF' >> src/a.ts\nbody\nEOF")).toEqual(['/proj/src/a.ts']);
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

describe('classifyBashWrite — v0.26.1 실측 오탐 4종 (전부 비차단이어야 한다)', () => {
  test('오탐 1: 문자열 안 화살표 함수 `=>` (bun -e 인라인 스크립트)', () => {
    expect(denied('bun -e "arr.map((x,i)=>x)"')).toEqual([]);
    expect(denied("node -e 'items.filter(x=>x.ok)'")).toEqual([]);
  });

  test('오탐 2: heredoc 본문의 `>=` (본문은 데이터 — 명령으로 스캔 금지)', () => {
    const cmd = "bun run check.ts <<'EOF'\nif (r.turn >= cursor) advance()\nEOF";
    expect(denied(cmd)).toEqual([]);
    // 인용 없는 종결자 heredoc도 동일.
    expect(denied('cat <<EOF\nscore >= threshold\nEOF')).toEqual([]);
  });

  test('오탐 3: 작은따옴표 안 꺾쇠 (커밋 메시지의 이메일)', () => {
    expect(denied("git commit -m 'fix: gate <noreply@anthropic.com>'")).toEqual([]);
    expect(denied('git commit -m "fix: gate <noreply@anthropic.com>"')).toEqual([]);
  });

  test('오탐 4: heredoc 종결자를 쓰기 대상 파일로 오인', () => {
    // 본문 마지막 줄이 `>`로 끝나면 옛 정규식은 다음 줄의 종결자(MSGEOF)를 타깃으로 봤다.
    expect(denied('git commit -F - <<MSGEOF\nresult >\nMSGEOF')).toEqual([]);
    expect(denied('cat <<MSGEOF\nfeat: a -> b\nMSGEOF')).toEqual([]);
  });

  test('종결자 없는 열린 heredoc은 나머지 전체를 본문으로 간주', () => {
    expect(denied('cat <<EOF\necho x > src/a.ts')).toEqual([]);
  });

  test('herestring(<<<)은 heredoc이 아니다 — 이후 리다이렉션은 계속 잡는다', () => {
    expect(denied('grep foo <<<"bar" > src/a.ts')).toEqual(['/proj/src/a.ts']);
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

describe('classifyBashWrite — v0.26.2 실측 오탐 5호: 따옴표 안 tee/sed 단어', () => {
  test('오탐 5: 따옴표 문자열 안의 tee / sed -i 단어는 명령이 아니다 (실측 재현 입력)', () => {
    expect(denied(`python3 -c 'print("note about tee and sed -i inside quotes")'`)).toEqual([]);
  });

  test('커밋 메시지 안의 tee/sed 단어도 비차단', () => {
    expect(denied("git commit -m 'fix: tee wrapper and sed -i docs update'")).toEqual([]);
    expect(denied('git commit -m "explain tee -a usage and sed -i.bak variants"')).toEqual([]);
  });

  test('따옴표 안 dd/of= 단어도 비차단', () => {
    expect(denied(`echo 'dd of=src/a.ts is dangerous'`)).toEqual([]);
  });

  test('정상 탐지 유지: 진짜 tee/sed -i/dd는 계속 잡는다', () => {
    expect(denied('echo x | tee src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x | tee -a src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x | tee "src/a.ts"')).toEqual(['/proj/src/a.ts']);
    expect(denied('/usr/bin/tee src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied("sed -i 's/a/b/' src/app.ts")).toEqual(['/proj/src/app.ts']);
    expect(denied("sed -i.bak 's/a/b/' 'src/app.ts'")).toEqual(['/proj/src/app.ts']);
    expect(denied('dd if=/dev/zero of="src/app.ts" bs=1')).toEqual(['/proj/src/app.ts']);
  });

  test('tee 뒤 리다이렉션 대상은 tee 파일 인자로 오수집하지 않는다', () => {
    // /dev/null은 항상 허용 → tee의 파일 인자 수집이 OP 마커에서 멈추는지 확인.
    expect(denied('echo x | tee /tmp/out.txt > /dev/null')).toEqual([]);
    expect(denied('echo x | tee src/a.ts > /dev/null')).toEqual(['/proj/src/a.ts']);
  });

  test('the fd number of a redirection is not a file argument', () => {
    // Seen live: denied as a write to "./2".
    expect(denied("sed -i '' -e '/^run/d' /tmp/mut.sh 2>/dev/null")).toEqual([]);
    expect(denied('echo x | tee /tmp/out.txt 2>/dev/null')).toEqual([]);
    expect(denied("sed -i 's/a/b/' src/app.ts 2>/dev/null")).toEqual(['/proj/src/app.ts']);
    expect(denied('echo x 2> src/err.ts')).toEqual(['/proj/src/err.ts']); // the target still counts
    // In bash a quoted fd number is a word: `'2'>/dev/null` is the file 2, then a stdout redirect.
    expect(denied("sed -i 's/a/b/' '2'>/dev/null")).toEqual(['/proj/2']);
  });
});

// Round 3 (final security review, compared with real bash 5.3 and zsh 5.9): a `<<` in quotes
//   or in a comment opened a heredoc, and the delimiter was only its word-character prefix.
//   Either way every later line went unscanned, so a write there was allowed.
describe('classifyBashWrite — heredoc detection (round 3)', () => {
  test('a `<<` inside quotes, in a comment or in arithmetic opens no heredoc', () => {
    expect(denied("echo '<<EOF' > /dev/null\necho x > src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(denied('echo "<<EOF"\necho x > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied("git log --format='%H <<EOF'\necho x > src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(denied('true # <<EOF\necho x > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo $((1<<2))\necho x > src/a.ts')).toEqual(['/proj/src/a.ts']);
  });

  test('the delimiter is the whole word, quotes removed', () => {
    expect(denied('cat <<EOF-1\nhello > x\nEOF-1\necho x > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('cat <<"E O F"\nbody > c.ts\nE O F\necho x > src/d.ts')).toEqual(['/proj/src/d.ts']);
    expect(denied('cat <<A <<B\na > 1\nA\nb > 2\nB\necho x > src/e.ts')).toEqual(['/proj/src/e.ts']);
  });

  test('bodies stay unscanned, and the operator line is scanned', () => {
    expect(denied("cat > src/a.ts <<'EOF'\nconst f = (x) => x >= 1;\nEOF")).toEqual(['/proj/src/a.ts']);
    expect(denied('cat <<-EOF\n\tbody > b.ts\n\tEOF\necho ok')).toEqual([]);
    expect(denied('cat <<EOF | tee src/a.ts\nbody\nEOF')).toEqual(['/proj/src/a.ts']);
    expect(denied("cat <<<'herestring > x' > /tmp/y")).toEqual([]);
    expect(denied("cat <<<'x'\necho y > src/a.ts")).toEqual(['/proj/src/a.ts']); // `<<<` is no heredoc
  });

  // Round 3 (closing security review): read as one opaque string, the double-quoted
  //   `$( … )` kept its heredoc body, which was then scanned as commands. That is how
  //   Claude Code writes commit messages and PR bodies.
  test('a heredoc inside `"$( … )"` is found: commit messages and PR bodies are not scanned', () => {
    const commit =
      "git commit -m \"$(cat <<'EOF'\nfix: the \"a > b\" check | tee y\n\nIt's 5\" wide -> ok\n\n" +
      'Co-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"';
    expect(denied(commit)).toEqual([]);
    expect(denied(`${commit}\necho x > src/a.ts`)).toEqual(['/proj/src/a.ts']);
    expect(denied("gh pr create --title t --body \"$(cat <<'EOF'\n## Summary\n- a > b\nEOF\n)\"")).toEqual([]);
    expect(denied('x=$(cat <<EOF\nbody > z\nEOF\n)\necho "$x" > src/a.ts')).toEqual(['/proj/src/a.ts']);
  });

  test('arithmetic hides no lines: `(( … ))` and `$[ … ]`', () => {
    expect(denied('(( y = 1 << 3 ))\necho x > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo $[1<<3]\necho x > src/a.ts')).toEqual(['/proj/src/a.ts']);
  });

  test('a comment writes nothing; `#` inside a word is no comment', () => {
    expect(denied('true # > src/a.ts')).toEqual([]);
    expect(denied('for f in a b; do echo $f; done # done > src/x.ts')).toEqual([]);
    expect(denied('echo a#b > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo ${#arr} > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo a\\ #b > src/a.ts')).toEqual(['/proj/src/a.ts']); // after an escaped blank
    expect(denied('(echo a) # > src/a.ts')).toEqual([]); // after a subshell, a new word
  });
});

describe('classifyBashWrite — more redirection forms (round 3)', () => {
  test("zsh's `>>|` and `>&|` write; so does `>&2-`, which zsh reads as the file 2-", () => {
    expect(denied('echo x >>| src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x >&| src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied("sed -i 's/a/b/' >>| /dev/null src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x | tee >&| /dev/null src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('cmd >&2-')).toEqual(['/proj/2-']);
    expect(denied('cmd 2>&1-')).toEqual(['/proj/1-']);
  });

  test('a quoted target that starts with `&` is a file', () => {
    expect(denied('echo x > "&a.ts"')).toEqual(['/proj/&a.ts']);
  });
});

// Layer-1 round 5, compared with real bash 5.3, bash 3.2 and zsh 5.9.
describe('classifyBashWrite — comments and quotes, more cases (layer-1 round 5)', () => {
  // A `#` starts a comment only at the start of a word. After the `)` that closes `$( … )`,
  //   `$(( … ))` or `<( … )` the word goes on, and all three shells write src/a.ts here.
  //   Read as a comment, the redirection after it went unscanned and the write was allowed.
  test('a `#` right after `$( … )`, `$(( … ))` or `<( … )` is part of the word, not a comment', () => {
    expect(denied('echo $(echo a)#b > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo $((1))#b > src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('cat <(echo a)#x > src/a.ts')).toEqual(['/proj/src/a.ts']);
  });

  // No test noticed when the escape inside double quotes was dropped: `\"` then closed the
  //   string, and the `<<EOF` after it hid every later line.
  test('a `<<` after an escaped quote inside double quotes opens no heredoc', () => {
    expect(denied('echo "a\\"b <<EOF" > /dev/null\necho x > src/a.ts')).toEqual(['/proj/src/a.ts']);
  });
});
