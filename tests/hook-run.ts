// One way to run a goodboy hook as a process for the tests that drive PreToolUse, PostToolUse and Stop
// (tests/n-quick-fixes.test.ts, tests/i29-dotdot-links.test.ts): the payload goes in on stdin, the hook's JSON
// comes out. Each call has its own temporary registry dir, and a session's state is under $TMPDIR/goodboy-session-<id>.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

export interface HookOut {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

/** `<root>/<raw>` with the `..` kept (join would collapse it). */
export const spell = (root: string, raw: string): string => `${root}/${raw}`;

/** A new session id; its state dir is added to `cleanup`, the list the test removes after each case. */
export function newSession(prefix: string, cleanup: string[]): string {
  const s = `${prefix}${Math.random().toString(36).slice(2, 10)}`;
  cleanup.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

/** The hook file `hookFile`, repo-relative (`hooks/pre-tool-use.ts`, `hooks/post-tool-use.ts`, `hooks/stop.ts`), in `cwd` as session `sessionId`. */
export async function runHook(hookFile: string, cwd: string, sessionId: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<HookOut> {
  const registry = mkdtempSync(join(tmpdir(), 'goodboy-hook-reg-'));
  try {
    const p = Bun.spawn(['bun', join(ROOT, hookFile)], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GOODBOY_REGISTRY_DIR: registry,
        GOODBOY_DISABLE_DELEGATION: '1',
        GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
        GOODBOY_REASONING_FLUSH_WAIT_MS: '0',
        GOODBOY_REASONING_GATE: 'off',
        ...env,
      },
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return JSON.parse(out || '{}') as HookOut;
  } finally {
    rmSync(registry, { recursive: true, force: true });
  }
}

/** What a PreToolUse answer decided. */
export function denialOf(out: HookOut): { denied: boolean; reason: string } {
  const h = out.hookSpecificOutput ?? {};
  return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
}

/** The files a session recorded as `edits` or `reads`, in order. */
export function recordedFiles(kind: 'edits' | 'reads', sessionId: string): string[] {
  try {
    return readFileSync(join(tmpdir(), `goodboy-session-${sessionId}`, `${kind}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { file: string }).file);
  } catch {
    return [];
  }
}
