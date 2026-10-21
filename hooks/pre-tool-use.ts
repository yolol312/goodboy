#!/usr/bin/env bun
// PreToolUse hook — 도구 강제 위임, Read-before-edit, 추론 게이트, 위험도 게이트

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import { addedUserGlobs, diffCoverageMode, isPolicyFile, type UserGlobKey } from '../lib/changed-coverage';
import { checkRegression, readRegressionRecords, type RegressionOutcome, regressionMessage, regressionMode } from '../lib/regression';
import { projectDir } from '../lib/project-dir';
import { agentName, ROUTE } from '../lib/routing-policy';
import { testTypesMode } from '../lib/test-types';
import { classifyPath } from '../lib/verification-scope';
import {
  appendDispatchLog,
  approvalMarkerPath,
  approvalMarkerShown,
  assistantEntriesAfterLastText,
  bareCatDumpMessage,
  agentTranscriptPath,
  BASH_SEARCH_MESSAGE,
  bashSearchPaths,
  bashWriteMessage,
  catDumpThresholdBytes,
  checkRecursionGuard,
  classifyBareCatDump,
  classifyBashSearch,
  classifyBashWrite,
  classifyOutward,
  CLI_PATH,
  decideOutward,
  decideSpawn,
  ensureApprovalDir,
  ensureSessionDir,
  statusFiles,
  textAfterEdit,
  writesIndirectly,
  envInt,
  envStr,
  extractRecentAssistantTextEntries,
  gateMessage,
  getCurrentTurn,
  getLatestEditTimestampSince,
  getRecentReadMtime,
  hashPrompt,
  hasAssistantMessages,
  hasReasoningSection,
  hasSkillEvidenceSince,
  isGoodboyArtifact,
  isPartialRead,
  isReadOnlyBash,
  lastKnownVersion,
  projectRelative,
  readReviewCursor,
  searchScopeIsSmall,
  skillRuleMessage,
  hookError,
  logGate,
  namedFiles,
  noteRiskApprovalPath,
  parseReasoningSection,
  readDispatchLog,
  readHostRules,
  readSessionState,
  recordEdit,
  roleOf,
  type SessionState,
  skillDenial,
  writeDenial,
  spawnCaps,
  type SpawnCode,
  spawnsClaudeCli,
  wasFileEditedRecently,
  wasFileReadRecently,
  bashMarkerWrite,
  checkHandoff,
  isHostsFile,
  removedProduction,
  rememberProduction,
  resultCliWrite,
  resultDirWrite,
  resultWriterDenial,
  ownsResultDir,
  classifyHost,
  readCommand,
  MAX_SEGMENTS,
  bashChangedPaths,
  snapshotGateState,
  writesGateState,
  userMarkerPresent,
  useUserMarker,
  findRecentTestFiles,
  handoffApprovalAsk,
  handoffsOf,
  isApprovalMarkerPath,
  isHandoffSkill,
  noteBashStart,
  pushTestMessage,
  revisionTree,
  commitIssueDenial,
  inGoodboySessionDir,
  isRequiredKnowledgeFile,
  markerWriteDenial,
  policyReadDenial,
} from '../lib';

interface PreToolInput {
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
}

interface HookOutput {
  continue?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
    /** Rewritten tool input (G0 M3/M15: applies to Agent calls with permissionDecision 'allow'). */
    updatedInput?: Record<string, unknown>;
  };
}

/** Korean user notice for a spawn cap, since a spent budget leaves the work incomplete (§10.2). */
const SPAWN_CAP_NOTICE: Partial<Record<SpawnCode, string>> = {
  'task-cap': '작업당 에이전트 호출 상한',
  'session-cap': '세션당 에이전트 호출 상한',
  'lead-cap': '리드 한 번당 멤버 호출 상한',
};

/** R2's host rules: every `.goodboy/hosts` up the tree, plus every production host seen earlier
 *  in this session (rememberProduction), so `rm .goodboy/hosts; exit 1` (no post hook to
 *  restore it, G0 M18), `chmod 000` or a symlink cannot lift a production entry. Every Bash
 *  call passes here before it runs (the push test check reads these rules), so the hosts a
 *  call could remove are already remembered. */
function hostRulesNow(cwd: string, sessionId: string): ReturnType<typeof readHostRules> {
  const rules = readHostRules(cwd);
  try {
    rules.production = rememberProduction(sessionId, rules.production);
  } catch {
    // best-effort
  }
  return rules;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

// 추론 게이트가 살펴볼 최근 assistant 메시지 개수.
// 모델이 '## 추론' 섹션을 출력한 뒤 도구 호출 직전에 다른 말(예: "이제 파일을 수정하겠습니다")을
// 한 줄 더 하더라도, 최근 N개 turn 안에 추론 섹션이 있으면 게이트를 통과시킨다.
// N을 작게 유지해 한참 전의 stale 추론 섹션이 게이트를 만족시키지 못하게 한다.
// v0.26.1: 일부 하니스의 텍스트 플러시 지연(차단→재시도 안내 텍스트가 윈도우를 밀어냄)에
//   대응해 기본값을 3 → 5로 올렸다. env GOODBOY_REASONING_WINDOW로 조정 가능.
function reasoningGateWindow(): number {
  return envInt('GOODBOY_REASONING_WINDOW', 5);
}

// 추론 게이트 escape 카운터 (v0.26.1, D 원칙 "탈출구 없는 게이트 금지"):
//   섹션 미인식 deny가 같은 세션에서 3회 누적되면 경고와 함께 통과시킨다.
//   transcript 텍스트 플러시가 지연되는 하니스에서 "한 번 더 시도하면 인식됩니다"가
//   영원히 거짓이 되는 영구 차단을 끊는 탈출구다. 인식 성공 시 리셋.
//
// v0.26.3 — sticky 지연 모드: escape 후 카운터만 리셋하면 다음 편집이 다시 1/3부터
//   차단되어, 플러시 지연이 지속되는 동안 "deny 2회 + escape 1회"가 편집마다 반복된다
//   (실측: 편집 15회 중 10회가 차단 낭비, 텍스트 반영까지 20~40초 지연).
//   escape 시 지연 모드 마커를 남기고, 섹션이 실제로 인식될 때까지 차단하지 않는다.
//   인식 성공 = 지연 해소의 증거이므로 그때 마커를 지우고 게이트를 재무장한다.
const REASONING_DENY_ESCAPE = 3;

/** (I4) A hand-off past the one-hour tier: the layer-1 result sufficed (user-visible, Korean). */
const RELAXED_NOTE =
  '[goodboy] 전체 회귀가 1시간을 넘는 프로젝트라 이번 push는 전체 회귀 대신 이 트리의 층1 테스트 통과 결과로 확인했어요.';

// v0.26.4 — 상태 파일을 에이전트 스코프로 분리(리뷰 지적): sessionId만으로 키잉하면
//   서브에이전트의 지연 모드가 메인 게이트까지 무장해제하고, 메인의 섹션 인식이
//   서브의 지연 모드를 해제해 차단 사이클이 혼합(메인+서브) 세션에서 재발한다.
//   게이트 판정(transcript 선택)과 동일하게 agent_id ?? 'main'으로 스코핑한다
//   (재-Read 게이트의 rereadScope 선례).
function scopedStateFile(base: string, scope: string): string {
  const safe = (scope || 'main').replace(/[^\w-]/g, '_');
  return `${base}.${safe}.txt`;
}

function isReasoningLagMode(sessionId: string, scope: string): boolean {
  try {
    return existsSync(join(ensureSessionDir(sessionId), scopedStateFile('reasoning-lag-mode', scope)));
  } catch {
    return false;
  }
}

function setReasoningLagMode(sessionId: string, scope: string): void {
  try {
    writeFileSync(
      join(ensureSessionDir(sessionId), scopedStateFile('reasoning-lag-mode', scope)),
      '1',
      'utf8',
    );
  } catch {
    // best-effort
  }
}

function clearReasoningLagMode(sessionId: string, scope: string): void {
  try {
    const p = join(ensureSessionDir(sessionId), scopedStateFile('reasoning-lag-mode', scope));
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best-effort
  }
}

function readReasoningDenyCount(sessionId: string, scope: string): number {
  try {
    const p = join(ensureSessionDir(sessionId), scopedStateFile('reasoning-deny-count', scope));
    if (!existsSync(p)) return 0;
    const n = parseInt(readFileSync(p, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeReasoningDenyCount(sessionId: string, scope: string, n: number): void {
  try {
    writeFileSync(
      join(ensureSessionDir(sessionId), scopedStateFile('reasoning-deny-count', scope)),
      String(n),
      'utf8',
    );
  } catch {
    // best-effort — 카운터 기록 실패가 게이트 동작을 막지 않는다.
  }
}

function resetReasoningDenyCount(sessionId: string, scope: string): void {
  try {
    if (readReasoningDenyCount(sessionId, scope) > 0) writeReasoningDenyCount(sessionId, scope, 0);
  } catch {
    // best-effort
  }
}

/** 마지막 deny 기록 시각(epoch ms) — deny-count 파일의 mtime. 파일이 없거나 실패면 null.
 *  카운터가 0으로 리셋될 때도 mtime이 갱신되므로, 반드시 count > 0인 상태에서
 *  (즉 리셋 이전에) 읽어야 "마지막 deny 시각"으로 유효하다. */
function lastReasoningDenyAtMs(sessionId: string, scope: string): number | null {
  try {
    const p = join(ensureSessionDir(sessionId), scopedStateFile('reasoning-deny-count', scope));
    if (!existsSync(p)) return null;
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// 추론(결정 근거) 게이트 모드: env GOODBOY_REASONING_GATE
//   warn(기본) — 차단하지 않는다. 섹션 미인식/빈 섹션은 스코프당 1회만 안내하고 이후는 로그만.
//   deny       — v0.28.2까지의 차단 동작 그대로(escape/flush-wait/lag-confirm 포함).
//   off        — 게이트 (C) 전체를 건너뛴다.
//   알 수 없는 값은 기본(warn)으로 취급한다.
type ReasoningGateMode = 'warn' | 'deny' | 'off';

function reasoningGateMode(): ReasoningGateMode {
  const v = envStr('GOODBOY_REASONING_GATE', 'warn');
  return v === 'deny' || v === 'off' ? v : 'warn';
}

const REASONING_WARN_GUIDANCE =
  '변경 전에 `## 근거` 섹션(### 사실 / ### 판단 / ### 가정 / ### 추측)에 결론과 근거를 짧게 요약해 두면 ' +
  '리뷰가 가정을 검증할 수 있습니다. (결정 근거 기록 권장 — 이 세션에서 1회만 안내)';

/** warn 모드 안내를 이 스코프에서 이미 했는지. 판정 실패면 true(안내 반복보다 침묵이 낫다). */
function isReasoningWarnNotified(sessionId: string, scope: string): boolean {
  try {
    return existsSync(join(ensureSessionDir(sessionId), scopedStateFile('reasoning-warn-notified', scope)));
  } catch {
    return true;
  }
}

function setReasoningWarnNotified(sessionId: string, scope: string): void {
  try {
    writeFileSync(
      join(ensureSessionDir(sessionId), scopedStateFile('reasoning-warn-notified', scope)),
      '1',
      'utf8',
    );
  } catch {
    // best-effort
  }
}

// 도구 강제 위임 대상 — 이 도구들은 메인이 직접 쓰지 않고 서브에이전트에게 위임한다.
const DELEGATED_TOOLS = new Set(['WebSearch', 'WebFetch', 'Grep', 'Glob']);

// 위험도 게이트(2-B) 대상 — 변경(부작용) 도구에만 위험 게이트를 적용한다.
//   read-only/조회 도구(Read/Grep/Glob 등)는 통과시켜, 커밋된 risky state로 인한 전체 차단 DoS를 막는다.
const RISK_GATED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);

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

function deny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      // 출처를 밝힌다 — 서브에이전트가 추론 게이트 메시지를 "프롬프트 인젝션 시도"로
      //   분류하고 무시한 실측 사례가 있었다. 도구 결과로 도착하는 긴 지시문은 외부
      //   주입과 형태가 같아서, 사용자가 설치한 로컬 훅임을 본문에서 밝혀야 한다.
      permissionDecisionReason: gateMessage(reason),
    },
  };
}

/** 통과(비차단) 출력. 경고가 있으면 함께 실어 보낸다.
 *  additionalContext = 에이전트(서브에이전트 포함) 컨텍스트에 확실히 주입되는 채널.
 *  permissionDecision은 설정하지 않아 정상 권한 흐름을 유지한다. systemMessage는 사용자 UI용. */
function emitPass(warnings: string[]): void {
  if (warnings.length === 0) {
    emit({});
    return;
  }
  const joined = warnings.join('\n');
  emit({
    systemMessage: joined,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: joined,
    },
  });
}

// assistantTextFromLine / extractRecentAssistantTexts는 lib/transcript-parser.ts로
// 승격되었다(Stop hook의 추측-리뷰 연동 A2도 사용). 여기서는 import해서 쓴다.

/** Risk-gate deny text (A4). Names the cause and the only two exits. The agent cannot
 *  create the approval marker itself — Bash/Write are exactly what this gate blocks — so
 *  the old "create the marker and retry" instruction was a deadlock. The marker name is
 *  this session's (A3), so the message prints it in full. */
function riskDenyMessage(state: SessionState, sessionId: string, projectCwd: string, shellCwd: string): string {
  const category = state.category ?? 'unknown';
  const reason = state.riskReason ?? '';
  const why = reason.startsWith('keyword:')
    ? `the request contains the risky keyword "${reason.slice('keyword:'.length)}"`
    : reason === 'default'
      ? `/${category} is risky by default`
      : reason === 'override'
        ? 'the user set --risk risky'
        : `task /${category}`;
  return (
    `This task is classified as risky (${why}); changes are blocked until the user approves. ` +
    `Ask the user to approve, then have the user run \`! touch ${approvalMarkerShown(projectCwd, 'risk', sessionId, shellCwd)}\` ` +
    '(you cannot create this file yourself: Bash/Write are blocked in a risky session; the ' +
    'approval applies to this session only). ' +
    'If the classification is wrong, the user can re-run the command with `--risk simple`. ' +
    'Read-only inspection (git status/diff/log/show, ls, cat, head, tail) is still allowed.'
  );
}

function main(): void {
  let input: PreToolInput = {};
  readStdin()
    .then((raw) => {
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as PreToolInput);
      } catch (err) {
        process.stderr.write(`[goodboy pre-tool-use] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      // `cwd` is the shell's current dir, where a Bash command's relative paths resolve. It
      //   follows a model's `cd`, so the project's records, state and approval markers come
      //   from the project dir instead (I10).
      const cwd = input.cwd ?? process.cwd();
      const projectCwd = projectDir(cwd);
      const sessionId = input.session_id ?? 'unknown';
      const toolName = input.tool_name ?? '';
      const toolInput = input.tool_input ?? {};

      // 비차단 사전 경고 누적기(현재 H2-01 warn 모드 전용). deny가 아닌 allow 경로에서
      //   hookSpecificOutput.additionalContext로 최종 emit에 실어 보낸다.
      //   ⚠️ systemMessage는 사용자 UI에만 노출되고 도구를 호출한 (서브)에이전트 컨텍스트에는
      //   주입되지 않는다. additionalContext는 에이전트에 확실히 도달하는 채널이다.
      //   호환/가시성을 위해 systemMessage도 함께 실어 준다. 위험도 게이트(D) deny가 나면 드롭된다.
      //   NOTE: H2-02(Bash 대량출력)는 사전 경고로는 에이전트에 닿지 않아(PreToolUse additionalContext
      //   미주입) PostToolUse 사후 경고로 이동함. 여기서는 더 이상 다루지 않는다.
      const preWarnings: string[] = [];

      // (v0.27.1~2) Bash 쓰기 승인 마커 — A1.7에서 원자 소비해 두고, 이후의 모든
      //   deny 게이트(위험 게이트 D)를 통과한 뒤에만 편집 기록·표면화한다.
      //   D가 deny하면 consumedPath에서 markerPath로 복원해 승인을 보존한다.
      let pendingBashWriteApproval: {
        markerPath: string;
        consumedPath: string;
        writes: string[];
      } | null = null;

      // (A0.9) A production approval marker this command may use, consumed at the end.
      let pendingOutwardApproval: { markerPath: string; what: string } | null = null;
      // (A0.87) The user's push-test approval this hand-off may use, consumed at the end.
      let pendingPushTestApproval: { markerPath: string; what: string } | null = null;

      // (A00) Policy read gate (track H §14.3): until the main session has read the project's
      //   knowledge files in full, its other tools wait (lib/project-knowledge.ts). First of
      //   all, so delegating (Agent/Task, allowed by the delegation guard below) is no way past
      //   it (H2 review).
      {
        const why = policyReadDenial({ sessionId, cwd, turn: getCurrentTurn(sessionId), toolName, toolInput, agentType: input.agent_type });
        if (why !== null) {
          logGate(sessionId, 'policy-read', 'deny', toolName);
          emit(deny(why));
          return;
        }
      }

      // (A0) 재귀 폭주 방어 — Agent/Task 호출에 한해, 60초 슬라이딩 윈도우로
      //   총 호출 상한/동일 프롬프트 반복을 검사한다. agent_type 존재 여부와
      //   무관하게 적용한다(서브에이전트가 또 서브에이전트를 부르는 폭주를 막기 위함).
      //   내부 오류는 삼키고 통과(fail-open)하므로 정상 작업을 막지 않는다.
      if (toolName === 'Agent' || toolName === 'Task') {
        const promptText =
          typeof toolInput.prompt === 'string'
            ? (toolInput.prompt as string)
            : JSON.stringify(toolInput);
        const guard = checkRecursionGuard(sessionId, promptText);
        if (guard.blocked && guard.reason) {
          logGate(sessionId, 'recursion-guard', 'deny', guard.reason);
          emit(deny(guard.reason));
          return;
        }
      }

      // (A0.5) 위임 재독 주의 (비차단) — 메인이 최근 읽은 파일 경로가 위임 프롬프트에
      //   들어 있으면, 서브에이전트가 같은 파일을 다시 읽게 될 가능성이 높다.
      //   서브의 재독은 필요비용일 수 있어(서브 컨텍스트엔 그 내용이 없다) 차단하지 않고,
      //   "직접 처리할 수 있는 작업인지 / 필요한 부분만 프롬프트에 담을 수 있는지"의
      //   판단을 유도하는 주의만 준다. env GOODBOY_DELEGATED_REREAD_WARN=on|off (기본 on).
      if (
        (toolName === 'Agent' || toolName === 'Task') &&
        !input.agent_type &&
        envStr('GOODBOY_DELEGATED_REREAD_WARN', 'on') !== 'off'
      ) {
        try {
          const promptText = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
          // 경로처럼 생긴 토큰(슬래시 + 확장자)만 후보로 본다. URL 등 오매칭은
          //   read 기록 대조에서 걸러진다(기록에 없으면 무시).
          const candidates = promptText.match(/[\w.~-]*\/[\w./-]+\.\w{1,8}/g) ?? [];
          if (candidates.length > 0) {
            const turn = getCurrentTurn(sessionId);
            const withinTurns = envInt('GOODBOY_REREAD_WINDOW', 30);
            const hits: string[] = [];
            for (const c of new Set(candidates)) {
              const abs = resolvePath(cwd, c);
              if (wasFileReadRecently(sessionId, abs, turn, withinTurns, 'main')) {
                hits.push(c);
                if (hits.length >= 3) break;
              }
            }
            if (hits.length > 0) {
              preWarnings.push(
                `위임 프롬프트에 메인이 이미 읽은 파일이 포함되어 있습니다: ${hits.join(', ')}. ` +
                  '서브에이전트는 그 내용을 모르므로 다시 읽게 됩니다 — 직접 처리할 수 있는 작업인지, ' +
                  '필요한 부분만 프롬프트에 담아 전달할 수 있는지 먼저 판단하세요. (위임 재독 주의, H2-01)',
              );
            }
          }
        } catch {
          // fail-open — 주의 계산 실패는 위임을 막지 않는다.
        }
      }

      // (A0.7) Delegation guard (track G §10.7, lib/spawn-guard.ts): only leads start agents,
      //   and only their members, in the foreground; caps per task, lead run, at once and
      //   session; the same agent and prompt again only with evidence. Allowed calls are
      //   logged for the caps and rewritten to the policy model/effort (G0 M3).
      //   env GOODBOY_SPAWN_GATE=on|warn|off (default on); GOODBOY_ROUTING_GATE=off keeps the
      //   call's own model/effort. Fails closed inside a subagent, open in the main session.
      if ((toolName === 'Agent' || toolName === 'Task') && envStr('GOODBOY_SPAWN_GATE', 'on') !== 'off') {
        const warnOnly = envStr('GOODBOY_SPAWN_GATE', 'on') === 'warn';
        try {
          const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
          const callee = strOrNull(toolInput.subagent_type) ?? 'general-purpose';
          const req = {
            caller: input.agent_type ?? null,
            callerId: input.agent_id ?? null,
            callee,
            prompt,
            model: strOrNull(toolInput.model),
            effort: strOrNull(toolInput.effort),
            files: namedFiles(prompt, cwd),
          };
          const now = Date.now();
          const decision = decideSpawn(req, readDispatchLog(sessionId), spawnCaps(), now, {
            fileChangedSince: (p, t) => {
              try {
                return statSync(p).mtimeMs > t;
              } catch {
                return true; // moved or deleted since: the scope changed
              }
            },
            editsSince: (t) => {
              const latest = getLatestEditTimestampSince(sessionId, 0);
              return latest !== null && Date.parse(latest) > t;
            },
          });
          if (!decision.allow) {
            logGate(sessionId, 'spawn-guard', warnOnly ? 'warn' : 'deny', `${decision.code} ${callee}`);
            if (!warnOnly) {
              const label = decision.code ? SPAWN_CAP_NOTICE[decision.code] : undefined;
              emit({
                ...deny(decision.reason ?? 'Delegation denied.'),
                ...(label ? { systemMessage: `[goodboy] ${label}에 도달해 에이전트 호출을 막았어요.` } : {}),
              });
              return;
            }
            preWarnings.push(`${decision.reason} (delegation guard, warn mode)`);
          }
          const rewrite: Record<string, unknown> = { ...(decision.rewrite ?? {}) };
          if (envStr('GOODBOY_ROUTING_GATE', 'on') === 'off') {
            delete rewrite.model;
            delete rewrite.effort;
          }
          // The applied model/effort (after the policy rewrite) are what the log keeps (§10.5).
          appendDispatchLog(sessionId, {
            k: 'dispatch',
            t: now,
            tuid: input.tool_use_id ?? `pre-${now}`,
            caller: req.caller,
            callerId: req.callerId,
            callee,
            hash: hashPrompt(prompt),
            model: typeof rewrite.model === 'string' ? rewrite.model : req.model,
            effort: typeof rewrite.effort === 'string' ? rewrite.effort : req.effort,
            files: req.files,
            why: decision.why ?? 'new',
          });
          if (Object.keys(rewrite).length > 0) {
            const joined = preWarnings.join('\n');
            emit({
              ...(joined ? { systemMessage: joined } : {}),
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: { ...toolInput, ...rewrite },
                ...(joined ? { additionalContext: joined } : {}),
              },
            });
            return;
          }
        } catch (err) {
          logGate(sessionId, 'spawn-guard', 'fail-open', String(err));
          if (input.agent_type) {
            emit(deny('The delegation guard could not check this call, so it is denied inside a subagent. Do the work yourself.'));
            return;
          }
        }
      }

      // (A0.79) A command too large or nested for the shared reader (MAX_SEGMENTS) cannot be
      //   checked by the rules below, so it does not run: split it (security-injection review:
      //   a `find -exec find …` fan-out ran this hook past its timeout, which lets a call through).
      //   A reader that throws denies too: the catch below lets every call through (final G1
      //   review: 20,000 nested `(` overflowed the stack).
      if (toolName === 'Bash' && typeof toolInput.command === 'string') {
        let unreadable: string | null = null;
        try {
          if (readCommand(toolInput.command, cwd).truncated) unreadable = `truncated ${toolInput.command.length}`;
        } catch (err) {
          unreadable = `threw ${String(err).slice(0, 120)}`;
        }
        if (unreadable !== null) {
          logGate(sessionId, 'reader', 'deny', unreadable);
          emit(deny(`This command is too large or nested for goodboy to read (over ${MAX_SEGMENTS} command segments or deeply nested), so its rules cannot be checked. Split it into smaller commands.`));
          return;
        }
      }

      // (A0.795) Commit issue rule (lib/commit-issue.ts, the user's request 2026-10-15): every
      //   `git commit`, in the main session and in agents, names an issue in its message.
      //   Per project `.goodboy/commit-issue` (a pattern, or `off`); env GOODBOY_COMMIT_ISSUE=off.
      if (toolName === 'Bash' && typeof toolInput.command === 'string' && envStr('GOODBOY_COMMIT_ISSUE', 'on') !== 'off') {
        const why = commitIssueDenial(toolInput.command, cwd, sessionId);
        if (why !== null) {
          logGate(sessionId, 'commit-issue', 'deny', why.slice(0, 80));
          emit({ ...deny(why), systemMessage: '[goodboy] 이슈 번호가 없는 커밋을 막았어요. 메시지에 이슈 번호(예: ABC-123, #123)를 넣어야 커밋돼요.' });
          return;
        }
      }

      // (A0.796) Project mode (track H §14.2): only the user marks a directory non-project
      //   (lib/project-mode.ts), in the main session and in agents.
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Bash') {
        const why = markerWriteDenial(sessionId, toolName, toolInput, projectCwd);
        if (why !== null) {
          logGate(sessionId, 'project-mode', 'deny', 'marker without user evidence');
          emit(deny(why));
          return;
        }
      }

      // (A0.8) A subagent may not start a headless Claude Code run: `claude -p` from Bash is
      //   the route around (A0.7). The main session may (it is the user's own action).
      if (
        toolName === 'Bash' &&
        input.agent_type &&
        envStr('GOODBOY_SPAWN_GATE', 'on') !== 'off' &&
        typeof toolInput.command === 'string' &&
        spawnsClaudeCli(toolInput.command)
      ) {
        const msg = 'A subagent may not start Claude Code runs (claude -p / --print). Do the work yourself with your own tools.';
        if (envStr('GOODBOY_SPAWN_GATE', 'on') === 'warn') {
          logGate(sessionId, 'spawn-guard', 'warn', `cli-spawn ${input.agent_type}`);
          preWarnings.push(`${msg} (delegation guard, warn mode)`);
        } else {
          logGate(sessionId, 'spawn-guard', 'deny', `cli-spawn ${input.agent_type}`);
          emit(deny(msg));
          return;
        }
      }

      // (A0.85) Approval markers are the user's alone (track G: no model-side escape). The user
      //   creates one with `! touch`, which runs outside the tool hooks; a model's write to a
      //   marker is denied here, and PostToolUse removes any marker a Bash call created anyway
      //   (an obfuscated name). Removing a marker (withdrawing an approval) stays allowed.
      if (envStr('GOODBOY_MARKER_GUARD', 'on') !== 'off') {
        const markerTarget =
          (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') &&
          typeof (toolInput.file_path ?? toolInput.notebook_path) === 'string' &&
          isApprovalMarkerPath(String(toolInput.file_path ?? toolInput.notebook_path))
            ? String(toolInput.file_path ?? toolInput.notebook_path)
            : toolName === 'Bash' && typeof toolInput.command === 'string'
              ? bashMarkerWrite(toolInput.command)
              : null;
        if (markerTarget !== null) {
          logGate(sessionId, 'marker-guard', 'deny', markerTarget);
          emit(
            deny(
              'goodboy approval markers can only be created by the user (they run `! touch` themselves). ' +
                'Ask the user if they approve; do not create or change the marker yourself.',
            ),
          );
          return;
        }
      }
      // (A0.86) `.goodboy/hosts` production entries are the user's (R2, security review): the
      //   model may add hosts, but an edit that removes or downgrades a production entry is
      //   denied, and so is any Bash write to the file (a Bash removal is restored afterwards).
      if (envStr('GOODBOY_OUTWARD_GATE', 'on') !== 'off') {
        // Remember the production hosts before any Bash call runs (whatever the other gates'
        //   switches), so a call that removes them lifts nothing (hostRulesNow).
        if (toolName === 'Bash') hostRulesNow(cwd, sessionId);
        const hostsDenial = (() => {
          const fp = typeof toolInput.file_path === 'string' ? resolvePath(cwd, toolInput.file_path) : '';
          if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && fp && isHostsFile(fp)) {
            let before = '';
            try {
              before = readFileSync(fp, 'utf8');
            } catch {
              return null; // a new file removes nothing
            }
            const removed = removedProduction(before, textAfterEdit(toolName, toolInput, before));
            return removed.length > 0 ? removed : null;
          }
          if (toolName === 'Bash' && typeof toolInput.command === 'string') {
            const hit = classifyBashWrite(toolInput.command, cwd).filter(isHostsFile);
            return hit.length > 0 ? ['(a Bash write)'] : null;
          }
          return null;
        })();
        if (hostsDenial !== null) {
          logGate(sessionId, 'outward', 'deny', `hosts ${hostsDenial.join(', ')}`);
          const bashWrite = hostsDenial[0] === '(a Bash write)';
          emit(
            deny(
              (bashWrite
                ? 'Bash may not write .goodboy/hosts: a shell write can drop production entries, which only the user removes (stop rule R2). '
                : `This would remove production entries from .goodboy/hosts (${hostsDenial.join(', ')}). Only the user removes or downgrades a production host (stop rule R2). `) +
                'Use Edit/Write to add hosts, and ask the user for the rest.',
            ),
          );
          return;
        }
      }

      // (I1, I3a, I3b) The user globs are the user's (lib/changed-coverage.ts): an Edit/Write that
      //   adds a `coverage-exempt`, `static-preview` or `test-type-exempt` glob to a human policy
      //   entry is denied, an exemption only while its rule is on. The gates would ignore it
      //   anyway (they use the globs pinned at the session start); this explains it early.
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
        const fp = typeof toolInput.file_path === 'string' ? resolvePath(cwd, toolInput.file_path) : '';
        if (fp && isPolicyFile(fp)) {
          let before = '';
          try {
            before = readFileSync(fp, 'utf8');
          } catch {
            // a new file: every glob in it is added
          }
          const added = addedUserGlobs(before, textAfterEdit(toolName, toolInput, before)).filter(
            (a) =>
              (a.key !== 'coverage-exempt' || diffCoverageMode() !== 'off') &&
              (a.key !== 'test-type-exempt' || testTypesMode() !== 'off'),
          );
          if (added.length > 0) {
            const keys = [...new Set(added.map((a) => a.key))];
            const list = keys.map((k) => `${k}: ${added.filter((a) => a.key === k).map((a) => a.glob).join(', ')}`).join('; ');
            logGate(sessionId, added[0]!.key, 'deny', list);
            const WHY: Record<UserGlobKey, string> = {
              'coverage-exempt': 'Only the user exempts files from the changed-line coverage rule (decision G-exception)',
              'static-preview': 'Only the user declares static previews, which need no test',
              'test-type-exempt': 'Only the user exempts files from the test-type rule',
            };
            const why = keys.map((k) => WHY[k]).join('; ');
            emit(
              deny(
                `${why}; this edit adds ${list}. Write tests that run the code, or ask the user: they add the line ` +
                  'themselves, and it counts from the next session.',
              ),
            );
            return;
          }
        }
      }

      // (A0.885) Results come from their agents (lib/role-limits.ts resultWriterDenial).
      //   env GOODBOY_RESULT_GUARD=on|off (default on).
      if (toolName === 'Bash' && typeof toolInput.command === 'string' && envStr('GOODBOY_RESULT_GUARD', 'on') !== 'off') {
        const kind = resultCliWrite(toolInput.command);
        // Copies, moves, redirects and interpreter scripts that name this session's result dirs
        //   (nested shells included); reads and `mkdir -p .claude/tests` pass.
        const intoResults = resultDirWrite(toolInput.command, cwd);
        const denial = kind
          ? resultWriterDenial(kind, input.agent_type, roleOf(input.agent_type))
          : intoResults
            ? `Results come only from the goodboy CLI (test-write / review-write); this command would write ${intoResults} directly. ` +
              'To read a result, use the Read tool, `cat` or `jq`: interpreter code that names a result dir counts as a write (#13).'
            : null;
        if (denial) {
          logGate(sessionId, 'result-guard', 'deny', `${kind} ${input.agent_type ?? 'main'}`);
          emit(deny(denial));
          return;
        }
      }

      // (A0.88) goodboy's gate state is not the model's to change (lib/state-guard.ts).
      if (toolName === 'Bash' && typeof toolInput.command === 'string' && writesGateState(toolInput.command)) {
        logGate(sessionId, 'state-guard', 'deny', toolInput.command.slice(0, 120));
        emit(deny("This command changes goodboy's own session state (goodboy-session-*). The gates decide from it; leave it alone and satisfy the gate instead."));
        return;
      }


      // (A0.87) Push test check (track G, lib/push-test.ts): a hand-off — git push (branches,
      //   tags), MR/PR creation, a deploy to a host that is neither local nor `allow`, or the
      //   /ship and /land-and-deploy skills — needs a passing layer-1 result whose tested tree is
      //   the tree handed off. Before R2, so a denial here never uses a production approval.
      //   A BLOCKED result never passes. The main session's override is the user's one-use
      //   marker (consumed at the end, after every other gate); a subagent has none.
      //   env GOODBOY_PUSH_TEST_GATE=on|warn|off (default on). Fails closed in a subagent.
      if (envStr('GOODBOY_PUSH_TEST_GATE', 'on') !== 'off' && (toolName === 'Bash' || toolName === 'Skill')) {
        const warnOnly = envStr('GOODBOY_PUSH_TEST_GATE', 'on') === 'warn';
        const regMode = regressionMode();
        const inSubagent = !!input.agent_type;
        try {
          const handoffs =
            toolName === 'Bash'
              ? typeof toolInput.command === 'string'
                ? handoffsOf(toolInput.command, cwd, hostRulesNow(cwd, sessionId))
                : []
              : typeof toolInput.skill === 'string' && isHandoffSkill(toolInput.skill) && revisionTree(cwd, 'HEAD') !== null
                ? [{ kind: 'push' as const, what: `/${toolInput.skill}`, cwd, revs: ['HEAD'] }]
                : [];
          if (handoffs.length > 0) {
            const results = findRecentTestFiles(resolvePath(projectCwd, '.claude', 'tests'), envInt('GOODBOY_TEST_WINDOW_MIN', 1440));
            // One tree hash per revision for both checks: a deploy hashes the whole working tree,
            //   and two hashes could overrun the hook timeout (I4 review).
            const trees = new Map<string, string | null>();
            const treeOf = (c: string, rev: string): string | null => {
              const k = `${c}\0${rev}`;
              if (!trees.has(k)) trees.set(k, revisionTree(c, rev));
              return trees.get(k)!;
            };
            for (const h of handoffs) {
              const o = checkHandoff(h, results, treeOf);
              // (I4, lib/regression.ts) Then a full regression goodboy ran on each tree handed off,
              //   from this session's records only (another checkout's are not guarded).
              let reg: Extract<RegressionOutcome, { ok: false }> | null = null;
              if (o.ok && regMode !== 'off') {
                const records = readRegressionRecords(projectCwd);
                let relaxed = false;
                for (const rev of h.revs) {
                  const tree = treeOf(h.cwd, rev);
                  let r: RegressionOutcome = tree === null ? { ok: false, why: 'none', rev, tree: '' } : checkRegression(rev, tree, records);
                  // (#13) Prose on top of a passing tree: that tree's regression counts too, unless
                  //   the tree handed off has a failed run of its own (a README doctest).
                  if (!r.ok && r.why === 'none' && o.docsOnly?.[rev]?.some((b) => checkRegression(rev, b, records).ok)) r = { ok: true };
                  if (!r.ok) {
                    reg = r;
                    break;
                  }
                  relaxed ||= r.relaxed === true;
                }
                if (relaxed && reg === null) preWarnings.push(RELAXED_NOTE);
              }
              if (o.ok && reg === null) continue;
              // Warn mode never uses the user's one-use marker, and lets the other hand-offs be checked.
              if (reg !== null && regMode === 'warn') {
                logGate(sessionId, 'push-test', 'warn', `regression-${reg.why} ${h.what}`);
                preWarnings.push(`${regressionMessage(h.what, reg, CLI_PATH, agentName(ROUTE.test))} (push regression check, warn mode)`);
                continue;
              }
              const marker = approvalMarkerPath(projectCwd,'push-test', sessionId);
              if (!inSubagent && userMarkerPresent(sessionId, marker, input.tool_use_id)) {
                pendingPushTestApproval = { markerPath: marker, what: h.what };
                break;
              }
              const failed = o.ok ? null : o;
              // (#13) The model sees the user's marker path too: it guessed the session tag.
              const markerRel = inSubagent ? undefined : approvalMarkerShown(projectCwd, 'push-test', sessionId, cwd);
              const msg =
                reg !== null
                  ? regressionMessage(h.what, reg, CLI_PATH, agentName(ROUTE.test)) + (markerRel ? handoffApprovalAsk(markerRel) : '')
                  : pushTestMessage(h.what, failed!, markerRel);
              const why = reg !== null ? `regression-${reg.why}` : failed!.why;
              if (warnOnly) {
                logGate(sessionId, 'push-test', 'warn', `${why} ${h.what}`);
                preWarnings.push(`${msg} (${reg !== null ? 'push regression check' : 'push test check'}, warn mode)`);
                break;
              }
              logGate(sessionId, 'push-test', 'deny', `${why} ${h.what}`);
              ensureApprovalDir(projectCwd);
              emit({
                ...deny(inSubagent ? `${msg} Agents never hand off untested work: return BLOCKED.` : msg),
                ...(inSubagent
                  ? {}
                  : {
                      systemMessage:
                        (failed?.runFirst
                          ? `[goodboy] 한 명령 안에서 \`${failed.runFirst}\` 뒤에 ${h.what}을(를) 하려는 걸 막았어요(push는 명령 실행 전에 검사해서 나눠서 해야 해요)`
                          : `[goodboy] ${reg !== null ? '통과한 전체 회귀 기록' : '통과한 테스트 결과'} 없이 ${h.what}을(를) 하려는 걸 막았어요`) +
                        (failed?.why === 'blocked' ? `(테스트를 실행하지 못함: ${failed.blocked?.blocked?.reason ?? ''})` : '') +
                        `. 테스트 없이 보내려면 \`! touch ${approvalMarkerShown(projectCwd, 'push-test', sessionId, cwd)}\`(이번 한 번)을 실행하거나 ${reg !== null ? 'GOODBOY_PUSH_REGRESSION' : 'GOODBOY_PUSH_TEST_GATE'}=off로 끄세요.`,
                    }),
              });
              return;
            }
          }
        } catch (err) {
          logGate(sessionId, 'push-test', 'fail-open', String(err));
          if (inSubagent && !warnOnly) {
            emit(deny('The push test check could not check this command, so it is denied inside a subagent. Return BLOCKED.'));
            return;
          }
        }
      }

      // (A0.9) Outward-command rule (track G stop rule R2, lib/outward-command.ts): a command
      //   that changes a host listed as production in .goodboy/hosts is denied, in the main
      //   session until the user approves that one use; a subagent's command that changes an
      //   unlisted external host is denied with a retarget hint; the main session gets advice,
      //   once per target. Reads always pass. env GOODBOY_OUTWARD_GATE=on|warn|off (default on).
      //   Fails closed inside a subagent, open in the main session.
      if (toolName === 'Bash' && typeof toolInput.command === 'string' && envStr('GOODBOY_OUTWARD_GATE', 'on') !== 'off') {
        const warnOnly = envStr('GOODBOY_OUTWARD_GATE', 'on') === 'warn';
        const inSubagent = !!input.agent_type;
        try {
          const targets = classifyOutward(toolInput.command, cwd);
          if (targets.length > 0) {
            const rules = hostRulesNow(cwd, sessionId);
            const { action, target } = decideOutward(targets, rules, inSubagent);
            // A broken hosts file makes every external host production (classifyHost): say so,
            //   and do not call an unlisted host "listed".
            const listed = !!target && classifyHost(target.host, { ...rules, broken: [] }) === 'production';
            const brokenNote =
              target && !listed && (rules.broken ?? []).length > 0
                ? `goodboy cannot read ${rules.broken!.join(', ')}, so every external host counts as production until the user fixes it`
                : '';
            const what = target ? `${target.kind} → ${target.host}${brokenNote ? ` (${brokenNote})` : ''}` : '';
            const listedAs = brokenNote ? 'treated as production' : 'listed as production in .goodboy/hosts';
            if (action === 'deny-production') {
              const marker = approvalMarkerPath(projectCwd,'outward', sessionId);
              if (!inSubagent && userMarkerPresent(sessionId, marker, input.tool_use_id)) {
                // Used only once every later gate has passed (see the end of this hook), so a
                //   later denial keeps the approval for the retry.
                pendingOutwardApproval = { markerPath: marker, what };
              } else if (warnOnly) {
                preWarnings.push(`[R2] ${what} is ${listedAs}. (outward gate, warn mode)`);
              } else {
                logGate(sessionId, 'outward', 'deny', `production ${what}`);
                ensureApprovalDir(projectCwd);
                emit({
                  ...deny(
                    inSubagent
                      ? `This command changes ${what}, ${listedAs} (stop rule R2). Agents never act on production: return BLOCKED with the exact command for the user to run.`
                      : `This command changes ${what}, ${listedAs} (stop rule R2). Ask the user first. If they approve this exact command, have them run \`! touch ${approvalMarkerShown(projectCwd, 'outward', sessionId, cwd)}\`, then run it again; the approval covers one command.`,
                  ),
                  systemMessage: `[goodboy] 운영(production) 대상 명령을 막았어요: ${what}`,
                });
                return;
              }
            } else if (action === 'deny-unlisted' && !warnOnly) {
              logGate(sessionId, 'outward', 'deny', `unlisted ${what}`);
              emit(
                deny(
                  `This command changes an external system (${what}) that .goodboy/hosts does not list, which agents may not do (stop rule R2). ` +
                    'Point it at a local or sandbox target (one listed as `allow` in .goodboy/hosts), or return BLOCKED with the exact command for the user to run.' +
                    (target?.host.startsWith('$') && /^(?:psql|pg_)/.test(target.kind)
                      ? ' goodboy cannot read a host held in a variable; a unix socket directory written as a literal absolute path (`-h /tmp/pgsock`) counts as local.'
                      : ''),
                ),
              );
              return;
            } else if (action === 'advise' || action === 'deny-unlisted') {
              const key = what;
              const seenFile = join(ensureSessionDir(sessionId), 'outward-advised.json');
              let seen: string[] = [];
              try {
                seen = JSON.parse(readFileSync(seenFile, 'utf8')) as string[];
              } catch {
                seen = [];
              }
              if (!seen.includes(key)) {
                logGate(sessionId, 'outward', 'warn', `unlisted ${what}`);
                preWarnings.push(
                  `[R2] ${what} changes an external system that .goodboy/hosts does not list. Run it only if the user asked for exactly this; otherwise use a sandbox target or ask first.`,
                );
                try {
                  writeFileSync(seenFile, JSON.stringify([...seen, key]), 'utf8');
                } catch {
                  // best-effort: the advice may repeat
                }
              }
            }
          }
        } catch (err) {
          logGate(sessionId, 'outward', 'fail-open', String(err));
          if (inSubagent && !warnOnly) {
            emit(deny('The outward-command rule could not check this command, so it is denied inside a subagent. Return BLOCKED with the command for the user to run.'));
            return;
          }
        }
      }

      // (A0.10) Role limits (track G, lib/role-limits.ts): a goodboy agent writes only what its
      //   role allows (Write/Edit and Bash writes inside the project) and invokes only its own
      //   tool skills. Plugin agents ignore permissionMode and Skill(...) (G0 M5, M9). Built-in
      //   agents are not limited here. env GOODBOY_ROUTING_GATE=off turns it off.
      if (input.agent_type && envStr('GOODBOY_ROUTING_GATE', 'on') !== 'off') {
        const role = roleOf(input.agent_type);
        if (role) {
          let denial: string | null = null;
          const projectRoot = resolvePath(projectCwd);
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
            const p = strOrNull(toolInput.file_path) ?? strOrNull(toolInput.notebook_path);
            if (p) denial = writeDenial(role, resolvePath(cwd, p), projectRoot);
          } else if (toolName === 'Bash' && typeof toolInput.command === 'string') {
            // Redirects (no meta-dir exemptions unless the role writes code) plus file
            //   programs and mutating git commands (security review: cp/mv/rm, git checkout).
            const strict = role.writes !== 'code';
            const changed = [...classifyBashWrite(toolInput.command, cwd, { strict }), ...bashChangedPaths(toolInput.command, cwd)];
            for (const f of changed) {
              denial = writeDenial(role, resolvePath(cwd, f), projectRoot);
              if (denial) break;
            }
          } else if (toolName === 'Skill') {
            const s = strOrNull(toolInput.skill);
            if (s) denial = skillDenial(role, s);
          }
          if (denial) {
            logGate(sessionId, 'role-limit', 'deny', `${role.name} ${toolName}`);
            emit(deny(denial));
            return;
          }
        }
      }

      // (A0.11) Skill rule (track G §10.4, lib/skill-rule.ts): a main-session code edit needs a
      //   workflow skill for the current change (since the last accepted review), or a
      //   skill-gap note recorded through the CLI. Docs, files outside the project and goodboy
      //   artifacts are exempt. env GOODBOY_SKILL_GATE=on|warn|off (default on).
      if (
        !input.agent_type &&
        ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName) &&
        envStr('GOODBOY_SKILL_GATE', 'on') !== 'off'
      ) {
        const p = strOrNull(toolInput.file_path) ?? strOrNull(toolInput.notebook_path);
        if (p) {
          const abs = resolvePath(cwd, p);
          const rel = projectRelative(abs, resolvePath(projectCwd));
          if (rel !== null && classifyPath(rel) === 'code' && !isGoodboyArtifact(abs)) {
            const cursor = readReviewCursor(projectCwd, sessionId);
            const since = cursor ? Date.parse(cursor.timestamp) : 0;
            if (!hasSkillEvidenceSince(sessionId, Number.isFinite(since) ? since : 0)) {
              const msg = skillRuleMessage(CLI_PATH, sessionId);
              if (envStr('GOODBOY_SKILL_GATE', 'on') === 'warn') {
                logGate(sessionId, 'skill-rule', 'warn', rel);
                preWarnings.push(msg);
              } else {
                logGate(sessionId, 'skill-rule', 'deny', rel);
                emit(deny(msg));
                return;
              }
            }
          }
        }
      }

      // (A) 도구 강제 위임. 서브에이전트(agent_type 존재)면 면제.
      //   GOODBOY_DISABLE_DELEGATION=1 이면 위임 자체를 끈다.
      if (!input.agent_type && process.env.GOODBOY_DISABLE_DELEGATION !== '1') {
        if (DELEGATED_TOOLS.has(toolName)) {
          logGate(sessionId, 'delegation', 'deny', toolName);
          emit(
            deny(
              "이 도구는 서브에이전트에게 위임하세요. Agent 도구로 'general-purpose' 등 적합한 서브에이전트를 호출하세요.",
            ),
          );
          return;
        }
      }

      // (A1) H2-03 — Bash 재귀 코드베이스 탐색 강제 위임. 서브에이전트(agent_type)는 면제.
      //   위임 게이트(A)는 Grep/Glob만 막아 Bash의 grep -r/rg/find로 우회된다. 이를 막는다.
      //   env GOODBOY_BASH_SEARCH_GATE=deny|warn|off (기본 deny).
      //   ⚠️ warn은 PreToolUse additionalContext가 에이전트에 닿지 않아 효과가 약하다(사용자 UI만).
      //   확실히 유도하려면 deny를 쓴다(deny의 permissionDecisionReason은 에이전트에 도달).
      if (!input.agent_type && toolName === 'Bash') {
        const gate = envStr('GOODBOY_BASH_SEARCH_GATE', 'deny'); // deny | warn | off
        if (gate !== 'off') {
          const command =
            typeof toolInput.command === 'string' ? (toolInput.command as string) : '';
          const hit = classifyBashSearch(command);
          // (G1) A search over a small, explicit scope runs here: delegating a lookup in a
          //   few known files cost more than the search. GOODBOY_BASH_SEARCH_SMALL (default
          //   200 files) sets the size; 0 delegates every recursive search, as before.
          const smallLimit = envInt('GOODBOY_BASH_SEARCH_SMALL', 200);
          const searchPaths = hit && smallLimit > 0 ? bashSearchPaths(command) : null;
          if (hit && searchPaths && searchScopeIsSmall(searchPaths, cwd, smallLimit)) {
            logGate(sessionId, 'bash-search', 'warn', `small-scope ${hit}`);
          } else if (hit) {
            const msg = `${BASH_SEARCH_MESSAGE} (감지: ${hit})`;
            if (gate === 'warn') {
              logGate(sessionId, 'bash-search', 'warn', hit);
              preWarnings.push(msg);
            } else {
              logGate(sessionId, 'bash-search', 'deny', hit);
              emit(deny(msg));
              return;
            }
          }
        }
      }

      // (A1.5) H2-02 사전 차단 — 후처리 없는 bare cat 대용량 통짜 출력.
      //   실행 전에 출력 크기를 알 수 있는 유일한 케이스(파일 인자 cat)만 statSync로 판정.
      //   파이프/리다이렉트가 붙은 정당한 사용(cat big | head)은 lib에서 전부 통과시킨다.
      //   서브에이전트에도 적용 — 통짜 출력은 어느 컨텍스트에서든 낭비다.
      //   env GOODBOY_CAT_GATE=deny|warn|off (기본 deny), 임계 GOODBOY_CAT_DENY_BYTES.
      if (toolName === 'Bash') {
        const gate = envStr('GOODBOY_CAT_GATE', 'deny');
        if (gate !== 'off') {
          const command =
            typeof toolInput.command === 'string' ? (toolInput.command as string) : '';
          const hit = classifyBareCatDump(command, cwd, catDumpThresholdBytes());
          if (hit) {
            const msg = bareCatDumpMessage(hit.bytes);
            if (gate === 'warn') {
              logGate(sessionId, 'cat-dump', 'warn', `${hit.bytes}B`);
              preWarnings.push(msg);
            } else {
              logGate(sessionId, 'cat-dump', 'deny', `${hit.bytes}B`);
              emit(deny(msg));
              return;
            }
          }
        }
      }

      // (A1.7) Bash 파일 쓰기 게이트 — 편집 게이트 우회 차단.
      //   라이브 검증 실측: 추론 게이트에 8회 막힌 서브에이전트가 `cat > src/x.ts <<EOF`로
      //   소스를 덮어썼다. Bash 쓰기는 read-before-edit·추론 게이트를 지나치고 PostToolUse의
      //   편집 기록에도 남지 않아 리뷰 강제·자동 검증까지 통째로 무력화한다.
      //   메인/서브에이전트 모두에 적용. env GOODBOY_BASH_WRITE_GATE=deny|warn|off (기본 deny).
      if (toolName === 'Bash') {
        const gate = envStr('GOODBOY_BASH_WRITE_GATE', 'deny');
        if (gate !== 'off') {
          const command =
            typeof toolInput.command === 'string' ? (toolInput.command as string) : '';
          const writes = classifyBashWrite(command, cwd);
          if (writes.length > 0) {
            // (v0.27.0, 실사용 피드백) 1회용 승인 마커 — 수백 줄 범위 삭제처럼 Edit의
            //   old_string 정확 재현이 비현실적인 대량 편집의 정식 우회로. 위험 게이트의
            //   승인 마커와 동일 패턴(honor-system). 여기서는 존재만 확인하고 통과 여부만
            //   정한다 — 마커 소비(삭제)와 편집 기록은 이후의 모든 deny 게이트(위험 게이트 D)를
            //   통과한 뒤에 수행한다(v0.27.1 리뷰 지적: D가 deny하면 마커만 소비되고
            //   실행되지 않은 쓰기가 유령 편집으로 기록되는 문제).
            // This session's marker only (A3): another session's approval is not consumed here.
            const approvalPath = approvalMarkerPath(projectCwd,'bash-write', sessionId);
            // 원자적 소비 — renameSync로 고유 경로에 이동한다. rename은 어떤 경합에서도
            //   정확히 한 프로세스만 성공한다(패자는 ENOENT). ⚠️ unlink로 구현하면 안
            //   된다: macOS에서 동시 unlink(2)가 같은 경로에 둘 다 성공해 병렬 이중
            //   승인이 된다(v0.27.3 리뷰 실측 9/10). 위험 게이트(D)가 deny하면
            //   consumedPath에서 복원해 승인을 보존한다.
            const consumedPath = `${approvalPath}.consumed-${process.pid}`;
            const approved = (() => {
              // Track G: a marker made during an open model Bash call is not the user's.
              if (!userMarkerPresent(sessionId, approvalPath, input.tool_use_id)) return false;
              try {
                renameSync(approvalPath, consumedPath); // 경합 패배 시 throw → 승인 없음
                return true;
              } catch {
                return false; // 마커 없음/소비 실패 → 승인 없음으로 취급(게이트 유지)
              }
            })();
            if (approved) {
              pendingBashWriteApproval = { markerPath: approvalPath, consumedPath, writes };
            } else {
              const msg = bashWriteMessage(writes, approvalMarkerShown(projectCwd, 'bash-write', sessionId, cwd));
              ensureApprovalDir(projectCwd); // so the printed `touch` works in a repo without .claude/
              if (gate === 'warn') {
                logGate(sessionId, 'bash-write', 'warn', `${writes.length}개`);
                preWarnings.push(msg);
              } else {
                logGate(sessionId, 'bash-write', 'deny', `${writes.length}개`);
                emit(deny(msg));
                return;
              }
            }
          }
        }
      }

      // (A2) H2-01 — 같은 파일 재-Read 게이트.
      //   최근 N턴 내 같은 파일을, 그 사이 mtime 변경도 편집도 없이 다시 Read하면 불필요한 재-Read로 본다.
      //   오탐 방지 예외(허용): 부분읽기(offset/limit), mtime 변경됨, 마지막 read 이후 편집됨.
      //   모든 판정은 fail-open(내부 오류/불확실 → 허용). env GOODBOY_REREAD_GATE=deny|warn|off (기본 deny).
      //   D2(스코프 개정): read 기록에 agent_id를 태깅하므로 서브에이전트도 "자기 기록" 기준으로
      //   공정하게 게이트한다(전면 면제 해제). 단 agent_type만 있고 agent_id가 없으면(식별 불가)
      //   기존 면제를 유지한다 — 동일 타입 서브 간 교차 오차단(남이 읽은 기록으로 내가 차단) 방지.
      const rereadScope: string | null = input.agent_id
        ? input.agent_id
        : input.agent_type
          ? null // 식별 불가 서브에이전트 → 면제
          : 'main';
      if (toolName === 'Read' && rereadScope !== null) {
        const gate = envStr('GOODBOY_REREAD_GATE', 'deny'); // deny | warn | off
        const filePath = (toolInput.file_path as string | undefined) ?? '';
        // 부분 읽기(offset/limit)는 정당한 재-Read → 예외. A7: PDF `pages` too — without it a
        //   PDF over 20 pages could never be read past the first range.
        // The project's knowledge files may always be read again (the policy read gate asks for them).
        if (gate !== 'off' && filePath && !isPartialRead(toolInput) && !isRequiredKnowledgeFile(projectCwd, resolvePath(cwd, filePath))) {
          const rereadMsg =
            'Already read recently and unchanged since; use the content you already have. ' +
            'If it is no longer in your context, re-read only the part you need with offset/limit ' +
            '(pages for PDFs) — partial reads are allowed. (re-Read gate, H2-01)';
          const blockReread = (() => {
            try {
              const absPath = resolvePath(cwd, filePath);
              const turn = getCurrentTurn(sessionId);
              // 윈도우 기본 30턴(D2 개정): "읽은 내용이 아직 컨텍스트에 살아있는가"의 근사치.
              //   mtime 비교가 파일 변경 오탐을 막고, 압축(/compact) 감지 시 Stop hook이
              //   read 기록을 리셋(epoch)하므로 길게 잡아도 압축 직후 오차단이 없다.
              //   더 엄격하게(사실상 무제한) 하려면 env로 크게 설정한다.
              const withinTurns = envInt('GOODBOY_REREAD_WINDOW', 30);
              // 최근에 읽지 않았으면 통과. A7: only full reads count — after `Read(limit:20)` or
              //   `head -n 3` the agent has not seen the file, so a full Read is not redundant.
              if (!wasFileReadRecently(sessionId, absPath, turn, withinTurns, rereadScope, true))
                return false;
              // 마지막 read 이후 편집됐으면 통과(내용이 바뀌었을 수 있음).
              if (wasFileEditedRecently(sessionId, absPath, turn, withinTurns, rereadScope))
                return false;
              // 이전 read 시점 mtime을 모르면 비교 불가 → 통과(fail-open).
              const prevMtime = getRecentReadMtime(sessionId, absPath, turn, withinTurns, rereadScope, true);
              if (prevMtime === null) return false;
              // 현재 mtime을 못 구하면 통과(fail-open).
              let curMtime: number | null = null;
              try {
                curMtime = statSync(absPath).mtimeMs;
              } catch {
                curMtime = null;
              }
              if (curMtime === null) return false;
              // mtime이 바뀌었으면 파일 변경 → 통과.
              if (curMtime !== prevMtime) return false;
              // 여기까지 오면 불필요한 재-Read.
              return true;
            } catch {
              return false; // 내부 오류는 통과(fail-open)
            }
          })();
          if (blockReread) {
            if (gate === 'warn') {
              // warn 모드: deny 대신 allow + systemMessage.
              logGate(sessionId, 'reread', 'warn', filePath);
              preWarnings.push(rereadMsg);
            } else {
              logGate(sessionId, 'reread', 'deny', filePath);
              emit(deny(rereadMsg));
              return;
            }
          }
        }
      }

      // (B) Read-before-edit
      const isEditTool = toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';

      // (B0) 게이트 산출물 직접 쓰기 차단 — 반드시 CLI를 거치게 한다.
      //   라이브 검증 실측: test-changes/review-changes 에이전트가 CLI를 쓰지 않고
      //   `.claude/tests/hello-unit-test.json`, `.claude/reviews/review-core.json` 처럼
      //   자기 형식으로 Write했다. 스키마가 달라 게이트가 읽지 못하니 "결과 없음"으로
      //   계속 차단되고 프로젝트에는 쓰레기 파일만 쌓였다(haiku는 산문 지시를 무시).
      //   CLI(test-write/review-write)는 스키마를 검증하고 파일명·timestamp를 맞춘다.
      // (B0-session) goodboy's own session state ($TMPDIR/goodboy-session-*) is written by its
      //   hooks only: an edit-tool write there would forge evidence or a cursor (H1 review: a
      //   Write of marker-evidence.jsonl passed; only Bash was bracketed by the state guard).
      if (isEditTool || toolName === 'NotebookEdit') {
        const target = typeof toolInput.file_path === 'string' ? toolInput.file_path : typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : '';
        if (target && inGoodboySessionDir(resolvePath(cwd, target))) {
          logGate(sessionId, 'state-write', 'deny', target.slice(-80));
          emit(deny("This edits goodboy's own session state (goodboy-session-*). The gates decide from it; leave it alone and satisfy the gate instead."));
          return;
        }
      }

      if (isEditTool && envStr('GOODBOY_ARTIFACT_WRITE_GATE', 'on') !== 'off') {
        const filePath = (toolInput.file_path as string | undefined) ?? '';
        if (filePath) {
          // The result dirs of the cwd's project, of a project above it, or of a package below
          //   it (security review rounds 2–3: a Write from a subdirectory to the root, or from
          //   the root into a package before a `cd`, was allowed). Another project's
          //   same-named path elsewhere is not this session's evidence and passes.
          const abs = resolvePath(cwd, filePath);
          const cwdAbs = resolvePath(cwd);
          const resultDir = (kind: string): boolean => {
            const at = abs.indexOf(`${sep}.claude${sep}${kind}${sep}`);
            return at >= 0 && ownsResultDir(abs.slice(0, at) || sep, cwdAbs);
          };
          const inTests = resultDir('tests');
          const inReviews = resultDir('reviews');
          if (inTests || inReviews) {
            const cmd = inTests ? 'test-write' : 'review-write';
            const schema = inTests ? 'TestResult' : 'ReviewResult';
            const rel = abs.startsWith(cwdAbs + sep) ? abs.slice(cwdAbs.length + 1) : abs;
            logGate(sessionId, 'artifact-write', 'deny', rel);
            emit(
              deny(
                `게이트 산출물은 편집 도구로 직접 쓸 수 없습니다: ${rel}. ` +
                  `\`bun "${CLI_PATH}" ${cmd}\` 에 ${schema} JSON을 stdin으로 ` +
                  `파이프하세요 — CLI가 스키마를 검증하고 파일명·timestamp를 맞춥니다. ` +
                  `직접 쓴 파일은 형식이 달라 게이트가 읽지 못하고, "결과 없음"으로 계속 차단됩니다. ` +
                  `(산출물 쓰기 게이트 — 해제: GOODBOY_ARTIFACT_WRITE_GATE=off)`,
              ),
            );
            return;
          }
        }
      }

      if (isEditTool) {
        const filePath = (toolInput.file_path as string | undefined) ?? '';
        if (filePath) {
          const absPath = resolvePath(cwd, filePath);
          const fileExists = (() => {
            try {
              return existsSync(absPath);
            } catch {
              return false;
            }
          })();
          // Write로 새 파일 생성은 예외
          const isNewFileViaWrite = toolName === 'Write' && !fileExists;
          if (!isNewFileViaWrite && fileExists) {
            const turn = getCurrentTurn(sessionId);
            // FRICTION #4: 세션 내에서 직접 Read 했거나, 직접 Write/Edit 한 파일이면
            // 이미 내용을 알고 있으므로 read-before-edit를 만족한 것으로 본다.
            // (v0.27.9) 창 기본 20→30턴: 재-Read 게이트(A2)는 "읽은 내용이 30턴 산다"고
            //   판정하는데 여기만 20턴이면, 21~30턴 구간의 편집이 불필요한 전체 재독을
            //   강제한다(tokenhabit H2-01 실측 — goodboy 자신이 유발하는 재독).
            //   두 게이트의 컨텍스트 수명 근사치를 같은 값으로 정렬한다.
            const rbeWindow = envInt('GOODBOY_READ_BEFORE_EDIT_WINDOW', 30);
            // Track G: the editor itself must know the file — its own read or edit (agent_id
            //   scope; the main session is 'main'). A subagent without agent_id cannot be told
            //   apart, so any record counts for it, as before. What it knew from before the
            //   last compaction does not count (lastKnownVersion).
            const rbeScope = input.agent_id ? input.agent_id : input.agent_type ? undefined : 'main';
            const known = lastKnownVersion(sessionId, absPath, turn, rbeWindow, rbeScope);
            if (known === null) {
              logGate(sessionId, 'read-before-edit', 'deny', absPath);
              emit(
                deny(
                  `Read this file with the Read tool before editing it: ${absPath}. ` +
                    'For a large file, a partial read (offset/limit) of the part you edit is enough. (read-before-edit)',
                ),
              );
              return;
            }
            // (v0.27.9) A read or own edit inside the window is stale when the file changed
            //   since (mtime differs): another agent, the user or a formatter wrote it. Unknown
            //   mtime (old records) fails open. The re-Read gate (A2) allows a read once the
            //   mtime changed, so this demand cannot loop.
            if (known.mtime !== null) {
              try {
                if (statSync(absPath).mtimeMs !== known.mtime) {
                  logGate(sessionId, 'read-before-edit', 'deny', `stale-${known.via} ${absPath}`);
                  emit(
                    deny(
                      `The file changed after you last ${known.via === 'read' ? 'read' : 'edited'} it: ${absPath}. ` +
                        'Read it again (a partial read is fine) and then edit. (read-before-edit, change check)',
                    ),
                  );
                  return;
                }
              } catch {
                // fail-open — mtime 판정 실패가 편집을 막지 않는다.
              }
            }
          }
        }
      }

      // (C0) 문서 파일 면제 (v0.27.0, 실사용 피드백): 문서-only 편집(.md/.txt 등)은
      //   추론 4분류의 실익이 낮은데 게이트 마찰(지연 하니스의 헛 차단)은 코드와 동일하게
      //   발생한다. 기본 면제하고, env GOODBOY_REASONING_DOC_EXEMPT=off로 복원 가능.
      //   (I3a) Documents and previews by the one classifier (lib/verification-scope.ts).
      const editTarget = typeof toolInput.file_path === 'string' ? resolvePath(cwd, toolInput.file_path) : '';
      const reasoningDocExempt =
        isEditTool &&
        editTarget !== '' &&
        classifyPath(projectRelative(editTarget, resolvePath(cwd)) ?? editTarget) !== 'code' &&
        envStr('GOODBOY_REASONING_DOC_EXEMPT', 'on') !== 'off';

      // (C) 추론 게이트
      // 마지막 메시지 하나만 보면, 모델이 추론 섹션을 출력한 뒤 도구 호출 직전에
      // 다른 말("이제 파일을 수정하겠습니다")을 한 줄 더 하면 잘못 차단된다.
      // → 최근 N개 turn 중 ANY가 추론 섹션을 담고 있으면 통과시킨다.
      // 모드(GOODBOY_REASONING_GATE) — off면 이 블록 전체를 건너뛰고, warn(기본)이면
      //   아래 판정은 그대로 하되 차단 대신 로그/1회 안내만 한다. deny만 차단·카운터를 쓴다.
      const reasoningMode = reasoningGateMode();
      const reasoningDenyMode = reasoningMode === 'deny';
      // Labeled so a "cannot judge" exit skips only this gate (A10). The old `emitPass(); return`
      //   also skipped the risk gate (D), so a subagent Write in a risky session passed unapproved.
      rationaleGate: if (isEditTool && !reasoningDocExempt && reasoningMode !== 'off') {
        // 서브에이전트의 편집은 "서브에이전트가 쓴 글"로 판정해야 한다.
        //   hook은 서브에이전트 호출에도 메인 transcript_path를 넘긴다 → 그대로 쓰면
        //   서브가 ## 추론을 아무리 써도 메인의 글만 검사되어 영구 차단된다(실측: 9회 출력, 8회 차단).
        //   전용 transcript를 못 찾으면 판정 불가 → fail-open(게이트 건너뜀).
        const mainTranscript = input.transcript_path ?? '';
        let reasoningTranscript: string | null = mainTranscript;
        if (input.agent_id) {
          reasoningTranscript = agentTranscriptPath(mainTranscript, input.agent_id);
          if (reasoningTranscript === null) {
            logGate(sessionId, 'reasoning', 'fail-open', 'subagent-transcript-not-found');
          }
        }
        if (reasoningTranscript === null) {
          // 서브에이전트 전용 기록을 찾지 못함 → 이 편집은 근거 게이트만 건너뛴다.
          break rationaleGate;
        }
        // (C-lag) 텍스트 플러시 지연 감지 (fail-open, v0.26.1) — 일부 하니스는 assistant
        //   텍스트 블록의 transcript 기록이 수십 초~수 분 지연된다(thinking/tool_use는 즉시 기록).
        //   그 상태에서는 모델이 '## 추론'을 아무리 출력해도 게이트가 옛 텍스트만 보게 되어
        //   deny 메시지("한 번 더 시도하면 인식됩니다")가 거짓이 되는 영구 차단이 된다(실측).
        //   마지막 텍스트 엔트리 이후 assistant 엔트리가 임계 이상 쌓였으면 "플러시 지연 중"으로
        //   보고 이 게이트 블록만 건너뛴다(조기 return 없음 — 이후 위험도 게이트(D)는 유지).
        const lagThreshold = envInt('GOODBOY_REASONING_LAG_ENTRIES', 8);
        const lagEntries = assistantEntriesAfterLastText(reasoningTranscript);
        if (lagEntries >= lagThreshold) {
          logGate(sessionId, 'reasoning', 'fail-open', `text-flush-lag(${lagEntries})`);
        } else {
        // 상태 스코프는 판정 대상 transcript와 동일 기준(agent_id ?? 'main')으로 잡는다.
        const reasoningScope = input.agent_id ?? 'main';
        let recentEntries = extractRecentAssistantTextEntries(
          reasoningTranscript,
          reasoningGateWindow(),
        );
        // (C-wait v0.27.7) 재시도 플러시 대기 — 실사용 재보고: deny 후 즉시 재시도가
        //   플러시(실측 19~40초+)보다 빨리 도착하면 2회째도 미인식된다("이거 또 왜 추론을
        //   감지 못 하지"). deny 직후의 재시도(카운터>0)인데 섹션이 아직 안 보이면, 즉시
        //   재거부하지 않고 transcript에 섹션이 나타날 때까지 최대 N초(기본 20초) 폴링한다.
        //   인식되면 기존 지연 확정(C-confirm)이 이어져 sticky 전환까지 한 번에 간다.
        //   끝내 안 보이면 기존 deny/escape 경로 그대로(안전망 불변). 첫 호출(카운터 0)과
        //   지연 모드에서는 대기하지 않는다. GOODBOY_REASONING_FLUSH_WAIT_MS=0으로 비활성.
        //   상한 45초: hooks.json PreToolUse timeout(60초, 이 대기를 위해 30→60으로 상향)
        //   안에서 15초 여유를 남긴다 — 상한이 타임아웃을 넘으면 하니스가 hook을 죽여
        //   게이트 전체가 fail-open 된다(리뷰 지적).
        const flushWaitMs = Math.min(envInt('GOODBOY_REASONING_FLUSH_WAIT_MS', 20000), 45000);
        // warn 모드는 deny 카운터를 올리지 않으므로 원래도 대기가 발동하지 않지만, 같은 세션에
        //   deny 모드 시절 카운터가 남아 있어도 대기(최대 45초 블로킹)하지 않도록 명시적으로 막는다.
        if (
          reasoningDenyMode &&
          flushWaitMs > 0 &&
          readReasoningDenyCount(sessionId, reasoningScope) > 0 &&
          !isReasoningLagMode(sessionId, reasoningScope) &&
          !recentEntries.some((e) => hasReasoningSection(e.text))
        ) {
          const startMs = Date.now();
          const deadline = startMs + flushWaitMs;
          while (Date.now() < deadline) {
            Bun.sleepSync(500);
            recentEntries = extractRecentAssistantTextEntries(
              reasoningTranscript,
              reasoningGateWindow(),
            );
            if (recentEntries.some((e) => hasReasoningSection(e.text))) break;
          }
          const hit = recentEntries.some((e) => hasReasoningSection(e.text));
          logGate(
            sessionId,
            'reasoning',
            'warn',
            `${hit ? 'flush-wait-hit' : 'flush-wait-miss'}(${Date.now() - startMs}ms)`,
          );
        }
        const recentTexts = recentEntries.map((e) => e.text);
        // (C-escape v0.26.3) 섹션 미인식 처리 공용 경로 — 무언 편집/미인식 deny 모두
        //   같은 카운터를 쓴다. 지연 모드면 차단하지 않고 경고만, 아니면 2회 deny 후 3번째에
        //   지연 모드로 전환한다. true를 반환하면 이번 편집을 통과시킨다는 뜻.
        const lagModeWarning =
          '근거 게이트 지연 모드: transcript 기록 지연이 확인된 세션이라 차단하지 않습니다. ' +
          '## 근거 섹션은 편집 전에 계속 요약해 주세요(정책은 유지되며, 리뷰가 검증합니다).';
        // warn 모드 공용 경로: 차단·카운터 없이 로그를 남기고, 안내가 필요한 경우 스코프당 1회만 싣는다.
        const warnUnrecognized = (reason: string, guide: boolean): void => {
          logGate(sessionId, 'reasoning', 'warn', reason);
          if (guide && !isReasoningWarnNotified(sessionId, reasoningScope)) {
            setReasoningWarnNotified(sessionId, reasoningScope);
            preWarnings.push(REASONING_WARN_GUIDANCE);
          }
        };
        const passUnrecognized = (denyReason: string, denyMessage: (n: number) => string): boolean => {
          if (!reasoningDenyMode) {
            // warn: 무언 편집(silent-edit)은 로그만, 섹션 미인식은 1회 안내. deny 카운터를 올리지
            //   않으므로 flush-wait/escape/lag-confirm(모두 카운터>0 전제)이 발동하지 않는다.
            warnUnrecognized(denyReason, denyReason !== 'silent-edit');
            return true;
          }
          if (isReasoningLagMode(sessionId, reasoningScope)) {
            logGate(sessionId, 'reasoning', 'warn', 'lag-mode');
            preWarnings.push(lagModeWarning);
            return true;
          }
          const denyCount = readReasoningDenyCount(sessionId, reasoningScope) + 1;
          if (denyCount >= REASONING_DENY_ESCAPE) {
            // 카운터 리셋 후 재무장하면 지연이 지속되는 동안 편집마다 deny 2회가
            //   반복된다(실측) — sticky 지연 모드로 전환하고 인식 성공 시 재무장한다.
            setReasoningLagMode(sessionId, reasoningScope);
            writeReasoningDenyCount(sessionId, reasoningScope, 0);
            logGate(sessionId, 'reasoning', 'warn', 'escape');
            preWarnings.push(
              // Wording matches behavior (A9): the escape fires on the attempt after the last block.
              `근거 게이트가 ${REASONING_DENY_ESCAPE - 1}회 차단 후에도 섹션을 인식하지 못했습니다. transcript 기록 지연으로 보고 ` +
                '지연 모드로 전환합니다 — 이 세션에서는 편집을 더 이상 차단하지 않습니다. ## 근거 섹션은 계속 요약해 주세요.',
            );
            return true;
          }
          writeReasoningDenyCount(sessionId, reasoningScope, denyCount);
          logGate(sessionId, 'reasoning', 'deny', denyReason);
          emit(deny(denyMessage(denyCount)));
          return false;
        };
        // recentTexts가 비면 두 경우를 구별한다(라이브 검증 발견 — 무언 편집 우회):
        //   (a) assistant 메시지 자체가 파싱됨(thinking/tool_use만 존재) → 모델이 아무 텍스트
        //       없이 편집하려는 것. 추론 섹션이 없음이 확정이므로 차단한다.
        //   (b) assistant 메시지를 하나도 못 찾음 → 파싱 실패/포맷 변경 가능성 → fail-open.
        if (recentTexts.length === 0) {
          if (hasAssistantMessages(reasoningTranscript)) {
            const passed = passUnrecognized(
              'silent-edit',
              (n) =>
                "편집 전에 '## 근거' 섹션에 결정 근거를 요약해 주세요. 4분류로: ### 사실 / ### 판단 / ### 가정 / ### 추측 ⚠️ . " +
                '출력했는데도 이 메시지가 보이면 기록 반영이 지연된 것입니다 — 같은 도구 호출을 다시 시도하세요. ' +
                `(결정 근거 기록 정책 — 무언 편집 불허, 재시도 ${n}/${REASONING_DENY_ESCAPE}, ${REASONING_DENY_ESCAPE - 1}회 차단 후 지연 모드로 통과)`,
            );
            if (!passed) return;
          } else if (reasoningTranscript !== '') {
            // E1: transcript가 주어졌는데 assistant 메시지를 하나도 못 찾았으면 무력화 신호.
            logGate(sessionId, 'reasoning', 'fail-open', 'transcript-unparsed');
          }
        } else {
          const hasReasoning = recentTexts.some((t) => hasReasoningSection(t));
          if (!hasReasoning) {
            const passed = passUnrecognized(
              'no-section',
              (n) =>
                "편집 전에 '## 근거' 섹션에 결정 근거를 요약해 주세요. 4분류로: ### 사실 / ### 판단 / ### 가정 / ### 추측 ⚠️ . " +
                '주의: 방금 출력한 텍스트는 기록 반영이 지연되어 아직 인식되지 않을 수 있습니다 — 이미 출력했다면 같은 도구 호출을 그대로 다시 시도하세요. ' +
                `(결정 근거 기록 정책, 재시도 ${n}/${REASONING_DENY_ESCAPE}, ${REASONING_DENY_ESCAPE - 1}회 차단 후 지연 모드로 통과)`,
            );
            if (!passed) return;
          } else {
            // (C-confirm v0.27.4) 지연 확정 — 실사용 재보고("편집마다 헛 deny 1회 잔존") 대응:
            //   sticky 지연 모드는 3회 escape에서만 켜지는데, "deny 1회 → 재시도에서 인식"이
            //   되는 중간 속도 플러시 세션은 카운터가 1→리셋을 반복하며 escape에 영영 도달하지
            //   못한다. 직전에 deny했는데 지금 인식된 추론 텍스트가 그 deny **이전에 생성**된
            //   것이면(생성 시각 < deny 시각), 그 deny는 플러시 지연 오탐이었다는 직접 증거다 —
            //   모델이 deny를 보고 순응해 새로 쓴 텍스트라면 생성 시각이 deny 이후여야 한다.
            //   이 경우 escape를 기다리지 않고 즉시 지연 모드로 전환해 헛 deny를 세션당 1회로
            //   수렴시킨다. (hook 입력에 현재 턴 텍스트가 없어 최초 1회는 구조적으로 남는다.)
            //   순응 케이스(생성 시각 ≥ deny 시각)는 전환하지 않아 빠른 하니스의 게이트 강도가
            //   유지되고, 시각 정보가 없으면 아무것도 하지 않는다(fail-safe).
            const priorDenies = readReasoningDenyCount(sessionId, reasoningScope);
            if (
              reasoningDenyMode &&
              priorDenies > 0 &&
              !isReasoningLagMode(sessionId, reasoningScope) &&
              envStr('GOODBOY_REASONING_LAG_STICKY', 'session') !== 'rearm' &&
              envStr('GOODBOY_REASONING_LAG_CONFIRM', 'on') !== 'off'
            ) {
              const denyAtMs = lastReasoningDenyAtMs(sessionId, reasoningScope);
              const recognizedAtMs = recentEntries
                .filter((e) => hasReasoningSection(e.text))
                .map((e) => e.timestampMs)
                .filter((t): t is number => t !== null)
                .reduce<number | null>((max, t) => (max === null || t > max ? t : max), null);
              if (denyAtMs !== null && recognizedAtMs !== null && recognizedAtMs < denyAtMs) {
                setReasoningLagMode(sessionId, reasoningScope);
                logGate(sessionId, 'reasoning', 'warn', 'lag-confirmed');
                preWarnings.push(
                  '근거 게이트: 방금 차단했던 편집의 ## 근거 섹션이 차단 이전에 이미 출력됐던 것으로 확인됐습니다' +
                    '(transcript 기록 지연). 이 세션은 지연 모드로 전환합니다 — 이후 편집은 차단 없이 진행되며, ' +
                    '## 근거 섹션은 계속 요약해 주세요(리뷰가 검증합니다).',
                );
              }
            }
            // 섹션 인식 성공 → escape 카운터 리셋.
            resetReasoningDenyCount(sessionId, reasoningScope);
            // 지연 모드 해제(재무장)는 기본적으로 하지 않는다(v0.27.0, 실사용 피드백):
            //   지연이 상존하는 세션에서 재무장하면 편집 배치마다 deny 1~2회 + escape가
            //   반복된다(실측 보고 — "매 편집마다 1~2회 헛 실패"). 한 번 지연이 확인된
            //   세션은 경고 유도만 유지한다. 지연 없는 하니스는 escape에 도달하지 않으므로
            //   게이트 강도 손실이 없다. 구 재무장 동작은 GOODBOY_REASONING_LAG_STICKY=rearm.
            if (envStr('GOODBOY_REASONING_LAG_STICKY', 'session') === 'rearm') {
              clearReasoningLagMode(sessionId, reasoningScope);
            }
          }
          // (A1) 실질 검사: 제목만 찍고 내용이 텅 빈 '시늉 추론'은 통과 불가.
          //   윈도우 내 추론 섹션 중 하나라도 4분류에 실제 항목이 있으면 통과.
          //   파싱이 전부 실패(null)하면 헤딩 존재만으로 통과(fail-open 유지).
          const parsed = recentTexts
            .filter((t) => hasReasoningSection(t))
            .map((t) => parseReasoningSection(t))
            .filter((s): s is NonNullable<typeof s> => s !== null);
          if (parsed.length > 0) {
            const hasContent = parsed.some(
              (s) =>
                s.facts.length + s.inferences.length + s.assumptions.length + s.speculations.length >
                0,
            );
            if (!hasContent) {
              if (!reasoningDenyMode) {
                // warn: 빈 섹션도 차단하지 않는다(1회 안내 후 로그만).
                warnUnrecognized('empty-section', true);
              } else {
                logGate(sessionId, 'reasoning', 'deny', 'empty-section');
                emit(
                  deny(
                    "'## 근거' 섹션이 비어 있습니다. 4분류(### 사실 / ### 판단 / ### 가정 / ### 추측 ⚠️)에 " +
                      "결론과 근거를 짧게라도 적어 주세요. 해당 없는 분류는 '- 없음'으로 명시합니다. (결정 근거 실질화, A1)",
                  ),
                );
                return;
              }
            }
          }
        }
        } // (C-lag) else 끝 — 플러시 지연이면 위 추론 게이트 블록 전체를 건너뛴다(위험도 게이트(D)는 계속 적용).
      }

      // (D) 위험도 게이트 — 변경 도구에만, 그리고 현재 세션에서 기록된 state에만 적용(2-B).
      //   ⚠️ 위험 게이트가 read-only 도구까지 막으면, 리포에 커밋된/오래된 risky state 하나로
      //   클론 시 모든 도구가 차단되는 DoS가 된다. 그래서:
      //     - 변경 도구(Edit/Write/MultiEdit/Bash)에만 건다(탐색/조회는 통과).
      //     - state.sessionId가 현재 세션과 일치할 때만 신뢰한다(다른 세션/커밋된 잔재는 무시).
      //       정상 흐름은 user-prompt-submit이 같은 세션에 state를 쓰므로 항상 일치한다.
      //     - The state comes from this session's state dir (A3). The repo-level copy, a
      //       single slot that another session's category command can overwrite, is read
      //       only as a fallback and only when it names this session (readSessionState).
      // Read-only Bash (git status, ls, cat, …) stays usable in a risky session (A4);
      //   before, every Bash call was denied, so the agent could not even inspect the repo.
      //   Checked only once the session is known to be risky: it scans the whole command.
      if (RISK_GATED_TOOLS.has(toolName)) {
        const state = readSessionState(projectCwd, sessionId);
        if (
          state &&
          state.risk === 'risky' &&
          !(toolName === 'Bash' && typeof toolInput.command === 'string' && isReadOnlyBash(toolInput.command as string))
        ) {
          const approvedPath = approvalMarkerPath(projectCwd,'risk', sessionId); // this session's (A3)
          // Remembered so the next category command withdraws it, wherever the cwd is then.
          noteRiskApprovalPath(sessionId, approvedPath);
          if (!userMarkerPresent(sessionId, approvedPath, input.tool_use_id)) {
            ensureApprovalDir(projectCwd); // so the user's `! touch` works in a repo without .claude/
            // 위험 게이트가 deny하면, A1.7에서 원자 소비한 Bash 쓰기 승인 마커를 복원한다
            //   (v0.27.1/2: deny로 승인만 소진되는 문제와 병렬 이중 승인 TOCTOU를 함께 해소).
            if (pendingBashWriteApproval !== null) {
              try {
                renameSync(pendingBashWriteApproval.consumedPath, pendingBashWriteApproval.markerPath);
              } catch {
                // best-effort — 복원 실패(fail-closed: 승인 소실) 시 사용자가 마커를 다시 만들면 된다.
              }
            }
            logGate(sessionId, 'risk', 'deny', state.category ?? 'unknown');
            emit(deny(riskDenyMessage(state, sessionId, projectCwd, cwd)));
            return;
          }
        }
      }

      // (A0.87, A0.9) Every deny gate passed: use the user's approvals now, all or none. Each
      //   is taken by an atomic rename to a consumed path; if one is gone (a parallel call used
      //   it), the ones already taken and a pending Bash-write approval are put back and the
      //   call is denied (refactoring review: an outward race used to spend the push approval).
      const approvals = [
        ['push-test', pendingPushTestApproval, (w: string) => `This hands off ${w} without a passing test result, and its one-use approval was already used. Ask the user to approve it again.`],
        ['outward', pendingOutwardApproval, (w: string) => `This command changes ${w}, listed as production in .goodboy/hosts (stop rule R2), and its one-use approval was already used. Ask the user to approve it again.`],
      ] as const;
      const taken: Array<{ markerPath: string; consumed: string }> = [];
      for (const [gate, pending, lost] of approvals) {
        if (pending === null) continue;
        const consumed = `${pending.markerPath}.consumed-${process.pid}`;
        let ok = userMarkerPresent(sessionId, pending.markerPath, input.tool_use_id);
        if (ok) {
          try {
            renameSync(pending.markerPath, consumed);
            taken.push({ markerPath: pending.markerPath, consumed });
          } catch {
            ok = false;
          }
        }
        if (!ok) {
          for (const t of [...taken, ...(pendingBashWriteApproval ? [{ markerPath: pendingBashWriteApproval.markerPath, consumed: pendingBashWriteApproval.consumedPath }] : [])]) {
            try {
              renameSync(t.consumed, t.markerPath);
            } catch {
              // best-effort, as in the risk gate
            }
          }
          logGate(sessionId, gate, 'deny', `${pending.what} (approval already used)`);
          emit(deny(lost(pending.what)));
          return;
        }
        logGate(sessionId, gate, 'warn', `approved ${pending.what}`);
      }
      for (const t of taken) {
        try {
          unlinkSync(t.consumed);
        } catch {
          // a leftover consumed file unlocks nothing
        }
      }

      // Bash 쓰기 승인 마무리 — 여기 도달 = 모든 deny 게이트 통과. 마커는 A1.7에서
      //   이미 원자 소비됐으므로(1회용 보장), 소비 파일을 정리하고 대상 파일을 편집
      //   기록에 남겨 리뷰 추적을 유지하며 사용자에게 표면화한다.
      if (pendingBashWriteApproval !== null) {
        const { consumedPath, writes } = pendingBashWriteApproval;
        try {
          unlinkSync(consumedPath);
        } catch {
          // best-effort — 잔여 소비 파일은 무해(.claude/ 안, 승인 판정에 미사용).
        }
        try {
          const turn = getCurrentTurn(sessionId);
          for (const f of writes) recordEdit(sessionId, f, turn, input.agent_id);
        } catch {
          // best-effort — 기록 실패가 승인된 쓰기를 막지 않는다.
        }
        logGate(sessionId, 'bash-write', 'warn', `approved(${writes.length}개)`);
        preWarnings.push(
          `승인 마커로 Bash 쓰기를 1회 허용했습니다(${writes.length}개 파일). ` +
            '해당 파일들은 편집 기록에 포함되어 리뷰 대상입니다.',
        );
      }

      // Every gate passed: note when and where this Bash call starts, so the post hooks remove
      //   markers it created, record files it wrote indirectly and put back gate state it
      //   changed. Only for calls that run: a denied call fires no post hook, and its open note
      //   would make the user's `! touch` after the denial look model-made.
      if (toolName === 'Bash' && input.tool_use_id) {
        // (I1) A call that can move files into place keeps their times: the post hook compares
        //   git's status with this snapshot (lib/write-sweep.ts).
        const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
        const status =
          command !== undefined && envStr('GOODBOY_BASH_WRITE_GATE', 'deny') !== 'off' && writesIndirectly(command)
            ? (statusFiles(cwd, 5_000) ?? undefined)
            : undefined;
        noteBashStart(sessionId, input.tool_use_id, cwd, command, input.agent_id, status);
        snapshotGateState(sessionId, input.tool_use_id);
      }

      emitPass(preWarnings);
    })
    .catch((err) => {
      // `input` may be null (stdin `null`): the error path itself must not throw.
      hookError(input?.session_id, 'pre-tool-use', 'fatal', err);
      emit({});
    });
}

main();
