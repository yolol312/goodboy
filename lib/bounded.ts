// One bounded child process, for the CLI's runners: the full regression (track I, I4,
// lib/regression.ts) and the update checkup's health and smoke steps (track K, K1c). A command
// gets a timeout and capped output; after it exits, its pipes are read only a little longer,
// so a background child that keeps them open holds neither the run nor its time.

/** After a command exits, its output is read this much longer. */
export const PIPE_GRACE_MS = 2_000;

export interface Bounded {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Time until the command exited (the pipe grace not counted). */
  ms: number;
  /** The command could not start. */
  error?: string;
}

/** A stream's first or last `max` characters, read in chunks so a huge output is never held;
 *  `stop` cancels the read. */
function capture(stream: ReadableStream<Uint8Array>, max: number, keep: 'head' | 'tail'): { done: Promise<void>; text: () => string; stop: () => void } {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let kept = '';
  const add = (s: string) => {
    kept = keep === 'tail' ? (kept + s).slice(-max) : kept.length < max ? (kept + s).slice(0, max) : kept;
  };
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        add(dec.decode(value, { stream: true }));
      }
      add(dec.decode());
    } catch {
      // cancelled
    }
  })();
  return { done, text: () => kept, stop: () => void reader.cancel().catch(() => undefined) };
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/** Runs `fn` with SIGINT, SIGTERM and SIGHUP handled: `cleanup` runs first (kill a child,
 *  remove a temp dir), then the process exits as the signal would have ended it. A cleanup in
 *  `finally` alone never runs on a signal (K1d review: a killed checkup left its paid session
 *  running and its debug log behind). */
export async function onInterrupt<T>(cleanup: () => void, fn: () => Promise<T>): Promise<T> {
  const handler = (sig: NodeJS.Signals) => {
    try {
      cleanup();
    } finally {
      process.exit(128 + SIGNALS[sig as keyof typeof SIGNALS]);
    }
  };
  const names = Object.keys(SIGNALS) as NodeJS.Signals[];
  for (const s of names) process.on(s, handler);
  try {
    return await fn();
  } finally {
    for (const s of names) process.off(s, handler);
  }
}

/** Runs `argv` with a timeout, killing it with `killSignal` (a SIGTERM is followed by a
 *  SIGKILL two seconds later), with no stdin unless `stdin` is given. Never throws. */
export async function runBounded(
  argv: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    max?: { stdout: number; stderr: number };
    keep?: 'head' | 'tail';
    killSignal?: 'SIGTERM' | 'SIGKILL';
    /** Gets the child once it runs, so a caller interrupted by a signal can kill it (K1d). */
    onSpawn?: (kill: (signal: 'SIGTERM' | 'SIGKILL') => void) => void;
  },
): Promise<Bounded> {
  const t0 = Date.now();
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    return { code: null, stdout: '', stderr: '', timedOut: false, ms: 0, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  opts.onSpawn?.((s) => p.kill(s));
  const max = opts.max ?? { stdout: 1024 * 1024, stderr: 64 * 1024 };
  const keep = opts.keep ?? 'head';
  const so = capture(p.stdout as ReadableStream<Uint8Array>, max.stdout, keep);
  const se = capture(p.stderr as ReadableStream<Uint8Array>, max.stderr, keep);
  let timedOut = false;
  const signal = opts.killSignal ?? 'SIGTERM';
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill(signal);
    if (signal === 'SIGTERM') setTimeout(() => p.kill('SIGKILL'), 2000).unref();
  }, opts.timeoutMs);
  const code = await p.exited;
  const ms = Date.now() - t0;
  clearTimeout(timer);
  await Promise.race([Promise.all([so.done, se.done]), Bun.sleep(PIPE_GRACE_MS)]);
  so.stop();
  se.stop();
  return { code, stdout: so.text(), stderr: se.text(), timedOut, ms };
}
