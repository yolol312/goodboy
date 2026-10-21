#!/usr/bin/env bun
// PostToolUse hook — Read/Edit 추적(read-before-edit/리뷰용), 자동 검증 실행, Bash 대량출력 사후 경고(H2-02)

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  agentCallRecord,
  appendDispatchLog,
  hookError,
  bareSkillName,
  bashOutputFloodMessage,
  isWorkflowSkill,
  recordSkillEvidence,
  skillEffortNotice,
  bashOutputWarnThresholds,
  classifyBashFlood,
  classifyBashReadDetailed,
  clearValidationFailure,
  isPartialRead,
  envStr,
  extractBashOutput,
  getCurrentTurn,
  measureOutput,
  readHabitState,
  recordEdit,
  recordRead,
  recordValidationPass,
  recordWebFetch,
  safeMtime,
  wasUrlFetched,
  webRefetchMessage,
  webRepeatSearchMessage,
  writeHabitState,
  writeValidationFailure,
  afterBash,
  answerChoseNonProject,
  readShownRange,
  recordMarkerEvidence,
} from '../lib';

interface PostToolInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  /** The session's effort on tool events (G0 M4). */
  effort?: { level?: string };
}

interface HookOutput {
  continue?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
  };
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function emit(out: HookOutput): void {
  try {
    process.stdout.write(JSON.stringify(out));
  } catch {
    // best-effort
  }
}

function findProjectRoot(startCwd: string): { root: string; marker: string } | null {
  const markers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  let cur = resolvePath(startCwd);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    for (const m of markers) {
      const candidate = resolvePath(cur, m);
      if (existsSync(candidate)) {
        return { root: cur, marker: m };
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

interface RunResult {
  cmd: string;
  ok: boolean;
  output: string;
  /** 검증 도구 자체를 찾을 수 없어 검증을 수행하지 못한 경우(환경 문제). 진짜 검증 실패와 구분한다. */
  unavailable?: boolean;
  /** The command hit its time budget: inconclusive, never treated as a failure (A5). */
  timedOut?: boolean;
}

/** "Tool not found" (an environment problem) vs. a genuine validation failure.
 *  Only the shell's "command not found" exit code (127) counts (stabilization plan A5);
 *  the output is no longer inspected (the parameter is kept for callers).
 *  Output substrings such as "not found" or "ENOENT" also appear in genuine failures —
 *  e.g. TS6053 "File '…' not found" — which used to be skipped as "tool unavailable".
 *  Spawn-level ENOENT is detected separately in runCmd. */
export function looksUnavailable(_output: string, exitCode: number | null | undefined): boolean {
  return exitCode === 127;
}

export function runCmd(cmd: string, cwd: string, timeoutMs: number): RunResult {
  try {
    const stdout = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    return { cmd, ok: true, output: stdout };
  } catch (err) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
      status?: number | null;
      code?: number | string;
    };
    const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
    const message = e.message ?? '';
    const output = [stdout, stderr, message].filter(Boolean).join('\n');
    const exitCode = typeof e.status === 'number' ? e.status : undefined;
    // A slow but healthy check (e.g. a 33 s typecheck) used to leave a failure marker and
    // block Stop on every edit. A timeout says nothing about the code: inconclusive.
    if (e.code === 'ETIMEDOUT') return { cmd, ok: false, output, timedOut: true };
    // child_process ENOENT(스폰 자체 실패)도 도구 부재로 본다.
    const spawnEnoent = e.code === 'ENOENT';
    const unavailable = spawnEnoent || looksUnavailable(output, exitCode);
    return { cmd, ok: false, output, unavailable };
  }
}

function tail(text: string, lines: number): string {
  const arr = text.split(/\r?\n/);
  return arr.slice(-lines).join('\n');
}

/** PATH에 실행 파일이 있는지. Windows에서 execSync의 기본 셸은 cmd.exe라 `command -v`가
 *  항상 실패한다(→ bun이 있어도 npm으로 폴백하던 버그). 플랫폼별 조회 명령을 쓴다.
 *  name은 호출부에서 상수로만 넘어오지만, 셸 주입을 막기 위해 형태를 제한한다. */
export function hasBin(name: string): boolean {
  if (!/^[\w.-]+$/.test(name)) return false;
  const cmd = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectFailureFromResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  if (r.is_error === true) return true;
  if (r.error) return true;
  return false;
}

// autoValidate 총 실행 예산. hooks.json PostToolUse 타임아웃(60s)보다 작게 잡아,
//   여러 명령 합산이 타임아웃을 넘겨 훅이 강제종료(검증 컨텍스트 유실)되는 것을 막는다.
const AUTOVALIDATE_TOTAL_BUDGET_MS = 45_000;
const AUTOVALIDATE_PER_CMD_MS = 30_000;

/** autoValidate 모드. 매 편집마다 test 전체를 돌리면 (1) 훅 타임아웃 초과(3×30s>60s),
 *  (2) 미신뢰 repo의 package.json test/lint 스크립트 자동 실행(임의 코드 실행 벡터) 위험이 있어
 *  기본은 가장 싼 검사(typecheck류)만 수행한다.
 *  env GOODBOY_AUTOVALIDATE=typecheck(기본) | all(typecheck+lint+test 등 전부) | off(검증 안 함). */
export function autoValidateMode(): 'typecheck' | 'all' | 'off' {
  const v = envStr('GOODBOY_AUTOVALIDATE', 'typecheck');
  if (v === 'all' || v === 'off') return v;
  return 'typecheck';
}

export function autoValidate(projectCwd: string): RunResult[] {
  const mode = autoValidateMode();
  if (mode === 'off') return [];
  const proj = findProjectRoot(projectCwd);
  if (!proj) return [];
  const results: RunResult[] = [];

  // 총 예산 내에서만 각 명령을 실행한다. 예산이 소진되면 나머지 검증은 조용히 건너뛴다(비차단).
  //   per-command 타임아웃은 30s와 남은 예산 중 작은 값으로 제한한다.
  const startedAt = Date.now();
  const runWithBudget = (cmd: string): void => {
    const remaining = AUTOVALIDATE_TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining <= 0) return; // 예산 소진 → 나머지 건너뜀
    results.push(runCmd(cmd, proj.root, Math.min(AUTOVALIDATE_PER_CMD_MS, remaining)));
  };

  if (proj.marker === 'package.json') {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(resolvePath(proj.root, 'package.json'), 'utf8'));
    } catch {
      return [];
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const runner = hasBin('bun') ? 'bun run' : 'npm run';
    // 기본(typecheck): typecheck만. all: typecheck→lint→test.
    const order = mode === 'all' ? ['typecheck', 'lint', 'test'] : ['typecheck'];
    for (const scriptName of order) {
      if (typeof scripts[scriptName] === 'string') {
        runWithBudget(`${runner} ${scriptName}`);
      }
    }
  } else if (proj.marker === 'pyproject.toml') {
    // 기본: 가장 싼 검사(ruff)만. all: ruff + pytest.
    if (hasBin('ruff')) runWithBudget('ruff check .');
    if (mode === 'all' && hasBin('pytest')) runWithBudget('pytest');
  } else if (proj.marker === 'Cargo.toml') {
    if (hasBin('cargo')) runWithBudget('cargo check');
  } else if (proj.marker === 'go.mod') {
    if (hasBin('go')) runWithBudget('go build ./...');
  }
  return results;
}

/** autoValidate 결과로부터 PostToolUse additionalContext를 구성한다.
 *  - 진짜 검증 실패(ok=false, unavailable 아님): 블로킹 "수정이 필요합니다" 컨텍스트.
 *  - 도구 부재(unavailable): 블로킹하지 않고 정보성 노트만, 나머지 명령은 계속 검사.
 *  - 둘 다 없으면 undefined.
 *  반환: { context, blocked } — blocked는 진짜 실패가 하나라도 있었는지. */
export function buildValidationContext(results: RunResult[]): {
  context: string | undefined;
  blocked: boolean;
  /** Commands that genuinely failed (not unavailable, not timed out) — the marker content. */
  failedCmds: string[];
  /** At least one check passed and none was inconclusive: safe to clear an old marker. */
  confirmedPass: boolean;
} {
  const realFailures = results.filter((r) => !r.ok && !r.unavailable && !r.timedOut);
  const unavailable = results.filter((r) => !r.ok && r.unavailable);
  const timedOut = results.filter((r) => !r.ok && r.timedOut);

  const blocks: string[] = [];
  if (realFailures.length > 0) {
    blocks.push('자동 검증 결과:');
    for (const r of realFailures) {
      blocks.push('');
      blocks.push(`[명령] ${r.cmd}`);
      blocks.push('[출력]');
      blocks.push(tail(r.output, 50));
    }
    blocks.push('');
    blocks.push('수정이 필요합니다.');
  }

  // 도구 부재는 블로킹하지 않고 정보성 노트만 덧붙인다.
  if (unavailable.length > 0) {
    if (blocks.length > 0) blocks.push('');
    for (const r of unavailable) {
      blocks.push(`자동 검증 도구를 찾을 수 없어 건너뜀: ${r.cmd}`);
    }
  }
  if (timedOut.length > 0) {
    if (blocks.length > 0) blocks.push('');
    for (const r of timedOut) {
      blocks.push(`Auto-validation timed out (inconclusive, not treated as a failure): ${r.cmd}`);
    }
  }

  const blocked = realFailures.length > 0;
  const context = blocks.length > 0 ? blocks.join('\n') : undefined;
  const failedCmds = realFailures.map((r) => r.cmd);
  const confirmedPass = !blocked && timedOut.length === 0 && results.some((r) => r.ok);
  return { context, blocked, failedCmds, confirmedPass };
}

/** H2-02 — Bash 실제 출력이 임계를 넘는지 판정해 사후 경고 문구를 만든다.
 *  - 핵심 트리거는 실제 출력 크기(chars/lines). classifyBashFlood 패턴은 보조 신호로만 표기.
 *  - 임계 이하 → null(무경고). fail-open은 호출부에서 처리한다.
 *  반환: 경고 문구 또는 null. */
export function buildBashOutputWarning(
  toolResponse: unknown,
  command: string,
): string | null {
  const output = extractBashOutput(toolResponse);
  const { chars, lines } = measureOutput(output);
  const { chars: charLimit, lines: lineLimit } = bashOutputWarnThresholds();
  if (chars <= charLimit && lines <= lineLimit) return null;
  let patternKey: string | null = null;
  try {
    patternKey = classifyBashFlood(command);
  } catch {
    patternKey = null;
  }
  return bashOutputFloodMessage(chars, lines, patternKey);
}

function main(): void {
  // (J3) The session for the fatal path's hook-error record (lib/gate-log.ts hookError).
  let errorSession: string | null = null;
  readStdin()
    .then((raw) => {
      let input: PostToolInput = {};
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as PostToolInput);
      } catch (err) {
        process.stderr.write(`[goodboy post-tool-use] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? 'unknown';
      errorSession = sessionId;
      const toolName = input.tool_name ?? '';
      const toolInput = input.tool_input ?? {};
      const toolResponse = input.tool_response;

      // (A0) Delegation log (track G §10.7): an Agent call's background launch or its
      //   foreground completion, so the delegation guard can count running agents.
      if (toolName === 'Agent' || toolName === 'Task') {
        const rec = agentCallRecord(input.tool_use_id ?? null, toolResponse, Date.now());
        if (rec) appendDispatchLog(sessionId, rec);
      }
      // (H1) The user chose "non-project" in an AskUserQuestion answer (lib/project-mode.ts).
      if (toolName === 'AskUserQuestion' && !input.agent_type && answerChoseNonProject(toolResponse)) {
        recordMarkerEvidence(sessionId, 'answered');
      }
      // (A0.5) Skill rule evidence (track G §10.4): the main session invoked a workflow skill.
      //   A skill that runs at its own effort says so in one line (§10.5).
      let skillNotice: string | null = null;
      if (toolName === 'Skill' && !input.agent_type) {
        const skill = typeof toolInput.skill === 'string' ? toolInput.skill : '';
        if (skill !== '' && isWorkflowSkill(skill)) {
          recordSkillEvidence(sessionId, { k: 'skill', t: Date.now(), name: bareSkillName(skill) });
        }
        skillNotice = skillEffortNotice(skill, input.effort?.level);
      }

      // (A) Read/Edit 추적
      //   D2: agent_id가 있으면(서브에이전트) 기록에 태깅해, 재-Read 게이트가
      //   에이전트별 스코프로 판정할 수 있게 한다. 메인은 태깅 없음(='main' 스코프, 하위호환).
      const agentId =
        typeof input.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : undefined;
      try {
        const turn = getCurrentTurn(sessionId);
        if (toolName === 'Read') {
          const fp = (toolInput.file_path as string | undefined) ?? '';
          if (fp) {
            const absFp = resolvePath(cwd, fp);
            // H2-01: Read 시점의 파일 mtime을 함께 기록해 재-Read 게이트가
            // "그 사이 파일이 바뀌었는지"를 판정할 수 있게 한다. stat 실패는 무시(mtime 생략).
            let mtime: number | undefined;
            try {
              mtime = statSync(absFp).mtimeMs;
            } catch {
              mtime = undefined;
            }
            // A7: offset/limit/pages reads are partial; the re-Read gate ignores them. Their line
            //   range is kept for the policy read gate (track H).
            const shown = readShownRange(toolInput, toolResponse);
            recordRead(sessionId, absFp, turn, mtime, agentId, shown.partial, shown.range);
          }
        } else if (toolName === 'Bash') {
          // Bash로 읽은 파일도 읽기로 기록한다. bypass permissions 모드에서는 시스템이
          //   "파일은 cat/sed로 읽어라"라고 지시하므로, 이 기록이 없으면 정직하게 읽고
          //   정확히 인용한 세션조차 읽기 이력이 0이 되어 read-before-edit이 오차단하고
          //   층0 인용 검증이 근거를 잃는다. 내용을 보여주는 명령만 인정한다(grep 제외).
          const command = (toolInput.command as string | undefined) ?? '';
          for (const { path: abs, partial } of classifyBashReadDetailed(command, cwd)) {
            recordRead(sessionId, abs, turn, safeMtime(abs), agentId, partial);
          }
        } else if (toolName === 'Edit' || toolName === 'Write') {
          // The mtime right after the edit lets read-before-edit see a later change by
          //   someone else (another agent, the user, a formatter).
          const fp = (toolInput.file_path as string | undefined) ?? '';
          if (fp) {
            const abs = resolvePath(cwd, fp);
            recordEdit(sessionId, abs, turn, agentId, safeMtime(abs));
          }
        } else if (toolName === 'MultiEdit') {
          // MultiEdit는 file_path가 단일 (edits 배열)이거나, 일부 클라이언트에서 다중일 수 있음.
          const fp = (toolInput.file_path as string | undefined) ?? '';
          if (fp) {
            const abs = resolvePath(cwd, fp);
            recordEdit(sessionId, abs, turn, agentId, safeMtime(abs));
          }
          const edits = (toolInput.edits as unknown[] | undefined) ?? [];
          if (Array.isArray(edits)) {
            for (const e of edits) {
              if (e && typeof e === 'object') {
                const fp2 = (e as Record<string, unknown>).file_path as string | undefined;
                if (fp2) {
                  const abs2 = resolvePath(cwd, fp2);
                  recordEdit(sessionId, abs2, turn, agentId, safeMtime(abs2));
                }
              }
            }
          }
        }
      } catch (err) {
        hookError(sessionId, 'post-tool-use', 'track error', err);
      }

      // (B) 자동 검증
      let additionalContext: string | undefined;
      const isEditTool = toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';
      const failureFromResponse = detectFailureFromResponse(toolResponse);
      if (isEditTool && !failureFromResponse) {
        try {
          // Taken before the checks read the tree: a pass vouches only for edits made before it started.
          const startedAt = new Date().toISOString();
          // From the shell's dir: the search walks up to the nearest package, which in a
          //   monorepo is below the project dir (I10 review).
          const results = autoValidate(cwd);
          const { context, blocked, failedCmds, confirmedPass } = buildValidationContext(results);
          additionalContext = context;
          // (C1) 검증 실패를 Stop 게이트로 승격 — 실패 시 세션 바인딩 마커를 남기고,
          //   재검증이 통과하면 해제한다. 검증이 아예 안 돈 경우(results 비어있음)는
          //   마커를 건드리지 않는다(통과 확인 없이 해제하는 오해제 방지).
          //   A5: a timeout or unavailable tool is no pass either — the marker stays as is.
          //   A3: failures are per session; a pass is recorded for the project, because the
          //   checks ran on the tree every session shares (lib/validation-state.ts).
          const root = findProjectRoot(cwd)?.root;
          if (blocked) {
            writeValidationFailure(sessionId, failedCmds, root);
          } else if (confirmedPass) {
            clearValidationFailure(sessionId);
            if (root) recordValidationPass(root, results.filter((r) => r.ok).map((r) => r.cmd), startedAt);
          }
        } catch (err) {
          hookError(sessionId, 'post-tool-use', 'validation error', err);
        }
      }

      // (C) H2-02 — Bash 대량출력 사후 경고(비차단, 패턴별 세션당 1회).
      //   실제 tool_response 출력 크기가 임계를 넘을 때만 경고한다(사후 교정).
      //   D3 개정: 세션당 딱 1회 → 홍수 "유형(cat-log/cat-glob/find-broad/whole-log/generic)"별
      //   1회로 확대. 다른 유형의 낭비가 이어지면 다시 교정 기회를 준다(스팸은 여전히 억제).
      //   에이전트에 확실히 도달하는 hookSpecificOutput.additionalContext로 전달.
      //   ⚠️ rtk가 실제 Bash 토큰 필터링을 이미 하므로 Good Boy는 "경고"만 담당한다.
      //   fail-open — 파싱/측정 실패 시 조용히 통과. env GOODBOY_BASH_FLOOD_WARN=on|off(기본 on).
      if (toolName === 'Bash' && envStr('GOODBOY_BASH_FLOOD_WARN', 'on') !== 'off') {
        try {
          const command = (toolInput.command as string | undefined) ?? '';
          const warning = buildBashOutputWarning(toolResponse, command);
          if (warning) {
            const patternKey = (() => {
              try {
                return classifyBashFlood(command) ?? 'generic';
              } catch {
                return 'generic';
              }
            })();
            const state = readHabitState(sessionId);
            const warned = new Set(state.bashFloodPatterns ?? []);
            // 하위호환: 구 포맷(패턴 목록 없이 boolean만) 세션은 generic을 이미 경고한 것으로
            // 간주한다. 신 포맷(목록 존재)에서는 목록만 신뢰한다.
            if (state.bashFloodPatterns === undefined && state.bashOutputWarned) {
              warned.add('generic');
            }
            if (!warned.has(patternKey)) {
              warned.add(patternKey);
              writeHabitState(sessionId, {
                ...state,
                bashOutputWarned: true,
                bashFloodPatterns: Array.from(warned),
              });
              additionalContext = warning;
            }
          }
        } catch (err) {
          // fail-open — 경고 실패해도 도구 흐름을 막지 않는다.
          hookError(sessionId, 'post-tool-use', 'bash-flood warn error', err);
        }
      }

      // (D) H2-04 — 동일 URL 재페치/동일 검색어 재검색 경고(비차단). 세션 전체 스코프
      //   (서브에이전트 포함) — 메인이 위임한 서브가 같은 페이지를 또 가져오는 낭비까지 잡는다.
      //   원격 내용 변경은 감지할 수 없으므로 deny가 아닌 warn 고정.
      //   (v0.27.9) WebSearch 확장 — tokenhabit 실측(웹 호출 270회, 같은 대상 반복 다수).
      //   검색어는 "search:" 접두로 URL 기록과 키 공간을 분리한다. 기록은 압축 epoch 리셋
      //   (clearReadRecords)에서 함께 비워진다 — 압축 후 "앞선 결과"는 컨텍스트에 없다.
      //   env GOODBOY_WEBFETCH_REFETCH_WARN=on|off (기본 on, WebSearch 포함).
      if (
        (toolName === 'WebFetch' || toolName === 'WebSearch') &&
        envStr('GOODBOY_WEBFETCH_REFETCH_WARN', 'on') !== 'off'
      ) {
        try {
          const isFetch = toolName === 'WebFetch';
          const target = isFetch
            ? typeof toolInput.url === 'string'
              ? (toolInput.url as string)
              : ''
            : typeof toolInput.query === 'string'
              ? (toolInput.query as string)
              : '';
          if (target) {
            const key = isFetch ? target : `search:${target}`;
            if (wasUrlFetched(sessionId, key)) {
              additionalContext = isFetch
                ? webRefetchMessage(target)
                : webRepeatSearchMessage(target);
            }
            recordWebFetch(sessionId, key);
          }
        } catch (err) {
          // fail-open
          hookError(sessionId, 'post-tool-use', 'web refetch warn error', err);
        }
      }

      // (E) Track G: after a Bash call, markers it made are removed and project files it wrote
      //   indirectly are recorded (lib/write-sweep.ts afterBash; also run by
      //   PostToolUseFailure, since a failing command skips PostToolUse, G0 M18).
      let markerNotice: string | undefined;
      if (toolName === 'Bash') {
        const after = afterBash(sessionId, input.tool_use_id, cwd, toolInput.command, agentId);
        if (after.context) additionalContext = additionalContext ? `${additionalContext}\n${after.context}` : after.context;
        markerNotice = after.notice;
      }

      const out: HookOutput = {};
      if (additionalContext !== undefined) {
        out.hookSpecificOutput = {
          hookEventName: 'PostToolUse',
          additionalContext,
        };
      }
      const notices = [markerNotice, skillNotice].filter((n): n is string => typeof n === 'string' && n !== '');
      if (notices.length > 0) out.systemMessage = notices.join('\n');
      emit(out);
    })
    .catch((err) => {
      hookError(errorSession, 'post-tool-use', 'fatal', err);
      emit({});
    });
}

// 직접 실행될 때만 main()을 호출한다. (테스트에서 import 시 stdin 대기를 막는다.)
if (import.meta.main) {
  main();
}
