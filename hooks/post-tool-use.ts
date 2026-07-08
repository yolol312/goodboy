#!/usr/bin/env bun
// PostToolUse hook — Read/Edit 추적(read-before-edit/리뷰용), 자동 검증 실행, Bash 대량출력 사후 경고(H2-02)

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  bashOutputFloodMessage,
  bashOutputWarnThresholds,
  classifyBashFlood,
  clearValidationFailure,
  envStr,
  extractBashOutput,
  getCurrentTurn,
  measureOutput,
  readHabitState,
  recordEdit,
  recordRead,
  writeHabitState,
  writeValidationFailure,
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
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
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
}

/** 출력/종료코드가 "도구를 찾을 수 없음"(환경 문제)을 가리키는지 판정.
 *  진짜 검증 실패(타입에러 등)와 구분하기 위함. */
export function looksUnavailable(output: string, exitCode: number | null | undefined): boolean {
  // exit code 127 = command not found (POSIX 셸 관례)
  if (exitCode === 127) return true;
  const o = (output ?? '').toLowerCase();
  const markers = [
    'command not found',
    'not found',
    'no such file or directory',
    'executable not found',
    'enoent',
  ];
  return markers.some((m) => o.includes(m));
}

function runCmd(cmd: string, cwd: string, timeoutMs: number): RunResult {
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

function hasBin(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
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
} {
  const realFailures = results.filter((r) => !r.ok && !r.unavailable);
  const unavailable = results.filter((r) => !r.ok && r.unavailable);

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

  const blocked = realFailures.length > 0;
  const context = blocks.length > 0 ? blocks.join('\n') : undefined;
  return { context, blocked };
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
      const toolName = input.tool_name ?? '';
      const toolInput = input.tool_input ?? {};
      const toolResponse = input.tool_response;

      // (A) Read/Edit 추적
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
            recordRead(sessionId, absFp, turn, mtime);
          }
        } else if (toolName === 'Edit' || toolName === 'Write') {
          const fp = (toolInput.file_path as string | undefined) ?? '';
          if (fp) recordEdit(sessionId, resolvePath(cwd, fp), turn);
        } else if (toolName === 'MultiEdit') {
          // MultiEdit는 file_path가 단일 (edits 배열)이거나, 일부 클라이언트에서 다중일 수 있음.
          const fp = (toolInput.file_path as string | undefined) ?? '';
          if (fp) recordEdit(sessionId, resolvePath(cwd, fp), turn);
          const edits = (toolInput.edits as unknown[] | undefined) ?? [];
          if (Array.isArray(edits)) {
            for (const e of edits) {
              if (e && typeof e === 'object') {
                const fp2 = (e as Record<string, unknown>).file_path as string | undefined;
                if (fp2) recordEdit(sessionId, resolvePath(cwd, fp2), turn);
              }
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[goodboy post-tool-use] track error: ${String(err)}\n`);
      }

      // (B) 자동 검증
      let additionalContext: string | undefined;
      const isEditTool = toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';
      const failureFromResponse = detectFailureFromResponse(toolResponse);
      if (isEditTool && !failureFromResponse) {
        try {
          const results = autoValidate(cwd);
          const { context, blocked } = buildValidationContext(results);
          additionalContext = context;
          // (C1) 검증 실패를 Stop 게이트로 승격 — 실패 시 세션 바인딩 마커를 남기고,
          //   재검증이 통과하면 해제한다. 검증이 아예 안 돈 경우(results 비어있음)는
          //   마커를 건드리지 않는다(통과 확인 없이 해제하는 오해제 방지).
          if (blocked) {
            const failedCmds = results.filter((r) => !r.ok && !r.unavailable).map((r) => r.cmd);
            writeValidationFailure(cwd, sessionId, failedCmds);
          } else if (results.length > 0) {
            clearValidationFailure(cwd);
          }
        } catch (err) {
          process.stderr.write(`[goodboy post-tool-use] validation error: ${String(err)}\n`);
        }
      }

      // (C) H2-02 — Bash 대량출력 사후 경고(비차단, 세션당 1회).
      //   실제 tool_response 출력 크기가 임계를 넘을 때만 경고한다(사후 교정).
      //   에이전트에 확실히 도달하는 hookSpecificOutput.additionalContext로 전달.
      //   ⚠️ rtk가 실제 Bash 토큰 필터링을 이미 하므로 Good Boy는 "경고"만 담당한다.
      //   fail-open — 파싱/측정 실패 시 조용히 통과. env GOODBOY_BASH_FLOOD_WARN=on|off(기본 on).
      if (toolName === 'Bash' && envStr('GOODBOY_BASH_FLOOD_WARN', 'on') !== 'off') {
        try {
          const command = (toolInput.command as string | undefined) ?? '';
          const warning = buildBashOutputWarning(toolResponse, command);
          if (warning) {
            const state = readHabitState(sessionId);
            if (!state.bashOutputWarned) {
              writeHabitState(sessionId, { ...state, bashOutputWarned: true });
              additionalContext = warning;
            }
          }
        } catch (err) {
          // fail-open — 경고 실패해도 도구 흐름을 막지 않는다.
          process.stderr.write(`[goodboy post-tool-use] bash-flood warn error: ${String(err)}\n`);
        }
      }

      const out: HookOutput = {};
      if (additionalContext !== undefined) {
        out.hookSpecificOutput = {
          hookEventName: 'PostToolUse',
          additionalContext,
        };
      }
      emit(out);
    })
    .catch((err) => {
      process.stderr.write(`[goodboy post-tool-use] fatal: ${String(err)}\n`);
      emit({});
    });
}

// 직접 실행될 때만 main()을 호출한다. (테스트에서 import 시 stdin 대기를 막는다.)
if (import.meta.main) {
  main();
}
