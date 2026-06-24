#!/usr/bin/env bun
// PostToolUse hook — Read/Edit 추적(read-before-edit/리뷰용), 자동 검증 실행

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { getCurrentTurn, recordEdit, recordRead } from '../lib';

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

function autoValidate(projectCwd: string): RunResult[] {
  const proj = findProjectRoot(projectCwd);
  if (!proj) return [];
  const results: RunResult[] = [];
  const timeoutMs = 30000;

  if (proj.marker === 'package.json') {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(resolvePath(proj.root, 'package.json'), 'utf8'));
    } catch {
      return [];
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const runner = hasBin('bun') ? 'bun run' : 'npm run';
    const order = ['typecheck', 'lint', 'test'];
    for (const scriptName of order) {
      if (typeof scripts[scriptName] === 'string') {
        results.push(runCmd(`${runner} ${scriptName}`, proj.root, timeoutMs));
      }
    }
  } else if (proj.marker === 'pyproject.toml') {
    if (hasBin('ruff')) {
      results.push(runCmd('ruff check .', proj.root, timeoutMs));
    }
    if (hasBin('pytest')) {
      results.push(runCmd('pytest', proj.root, timeoutMs));
    }
  } else if (proj.marker === 'Cargo.toml') {
    if (hasBin('cargo')) {
      results.push(runCmd('cargo check', proj.root, timeoutMs));
    }
  } else if (proj.marker === 'go.mod') {
    if (hasBin('go')) {
      results.push(runCmd('go build ./...', proj.root, timeoutMs));
    }
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

function main(): void {
  readStdin()
    .then((raw) => {
      let input: PostToolInput = {};
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as PostToolInput);
      } catch (err) {
        process.stderr.write(`[vcf post-tool-use] stdin parse error: ${String(err)}\n`);
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
          if (fp) recordRead(sessionId, resolvePath(cwd, fp), turn);
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
        process.stderr.write(`[vcf post-tool-use] track error: ${String(err)}\n`);
      }

      // (B) 자동 검증
      let additionalContext: string | undefined;
      const isEditTool = toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';
      const failureFromResponse = detectFailureFromResponse(toolResponse);
      if (isEditTool && !failureFromResponse) {
        try {
          const results = autoValidate(cwd);
          const { context } = buildValidationContext(results);
          additionalContext = context;
        } catch (err) {
          process.stderr.write(`[vcf post-tool-use] validation error: ${String(err)}\n`);
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
      process.stderr.write(`[vcf post-tool-use] fatal: ${String(err)}\n`);
      emit({});
    });
}

// 직접 실행될 때만 main()을 호출한다. (테스트에서 import 시 stdin 대기를 막는다.)
if (import.meta.main) {
  main();
}
