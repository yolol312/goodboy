// Update checkups (track K, K1 #10, plan §17), step K1b: the inventory of the user's Claude Code
// customizations and the static checks of subagent definitions. Zero model turns: it reads
// settings, installed plugins and definition files, and never runs a hook or a command.
//
// - Components: plugins (configured in settings vs installed), hooks (settings and plugin
//   hooks.json), skills, agents, commands and CLAUDE.md files, each with its scope, owner,
//   canonical path and hashes.
// - Identifiers in use (hook events, payload fields, frontmatter and settings keys, CLI
//   flags, env vars): the changelog triage matches entries against them (K1a --ids).
// - Agent checks: pinned models, tools that resolve to nothing, MCP tool syntax, frontmatter
//   keys goodboy does not know, duplicate names, shadowing, copies by hash, delegation that
//   conflicts with the leaf rule. Each finding says how sure it is.
// - Projects: the current project, plus the ones the user registered (projects.json in the
//   checkup dir). Other projects are never scanned.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { claudeConfigDir, isDir, isUnder } from './private-files';
import { readRegular } from './safe-read';
import { maskSecrets } from './secret-patterns';

export type Scope = 'user' | 'project' | 'local' | 'plugin';
export type Kind = 'plugin' | 'hook' | 'skill' | 'agent' | 'command' | 'claude-md';

export interface Component {
  kind: Kind;
  /** The name Claude Code uses: a plugin id, `plugin:agent`, a skill dir name, a hook's
   *  `Event[matcher]`. */
  name: string;
  scope: Scope;
  /** `user`, `project:<root>` or the plugin id. */
  owner: string;
  /** Canonical path (links resolved); a hook's settings or hooks.json file. */
  path: string;
  /** Plugins: enabled in the settings that apply to the current project. Others: present. */
  configured: boolean;
  /** Plugins: in installed_plugins.json with an existing install dir. */
  installed?: boolean;
  /** A hook's command, as configured, with secrets masked. */
  command?: string;
  hash?: { file: string; body?: string; frontmatter?: string };
  /** The frontmatter keys of a definition. */
  keys?: string[];
  /** An agent's checked frontmatter values (name, model, tools, disallowedTools); the rest of
   *  a definition is kept as its keys and hashes only. */
  frontmatter?: Record<string, unknown> | null;
  /** Why a file could not be read or parsed. */
  problem?: string;
}

export interface Identifiers {
  events: string[];
  fields: string[];
  keys: string[];
  flags: string[];
  env: string[];
}

export interface AgentFinding {
  check: 'pinned-model' | 'unknown-tool' | 'mcp-syntax' | 'unknown-key' | 'duplicate' | 'shadowed' | 'copies' | 'delegation' | 'unreadable';
  agents: string[];
  detail: string;
  /** `confirmed`: read from the file. `uncertain`: depends on the running CLI (K1c/K1d probes). */
  certainty: 'confirmed' | 'uncertain';
}

export interface Inventory {
  config_dir: string;
  projects: string[];
  components: Component[];
  identifiers: Identifiers;
  agent_findings: AgentFinding[];
  /** Files and dirs that could not be read, and caps that were hit. */
  problems: string[];
}

// ---- reading ----

const MAX_FILE = 1024 * 1024;
const MAX_COMPONENTS = 3000;
const MAX_SCANNED = 600;
/** All hook scripts together (K1b review: 600 scripts of 900 KB took 22 s). */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

function text(path: string): string | null {
  const r = readRegular(path, MAX_FILE);
  return typeof r === 'string' ? null : r.text;
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** A JSON object file, or undefined when it is absent. A file that is there but is not a
 *  readable JSON object up to 1 MB is named as a problem, never skipped silently. */
function jsonObject(ctx: Ctx, path: string): Record<string, unknown> | undefined {
  const r = readRegular(path, MAX_FILE);
  if (r === 'absent') return undefined;
  if (r === 'refused') {
    problem(ctx, `${path} is not readable as a regular file up to 1 MB`);
    return undefined;
  }
  try {
    const v: unknown = JSON.parse(r.text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // named below
  }
  problem(ctx, `${path} is not a JSON object`);
  return undefined;
}

/** Whether a parsed YAML value stays within a node and character budget, counting a value
 *  each time an alias reaches it. Aliases are shared references, so parsing a "billion laughs"
 *  file is instant but stringifying it is not (K1b review: 431 bytes ran out of memory). */
function withinBudget(v: unknown, maxNodes = 5000, maxChars = MAX_FILE): boolean {
  const stack: unknown[] = [v];
  let nodes = 0;
  let chars = 0;
  while (stack.length) {
    const x = stack.pop();
    if (++nodes > maxNodes) return false;
    if (typeof x === 'string') chars += x.length;
    else if (Array.isArray(x)) {
      for (const y of x) if (stack.push(y) > maxNodes) return false;
    } else if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) {
        chars += k.length;
        if (stack.push(y) > maxNodes) return false;
      }
    }
    if (chars > maxChars) return false;
  }
  return true;
}

/** A Markdown file's YAML frontmatter, its body, and the hashes; `frontmatter: null` when it
 *  has none, a problem when the YAML does not parse or expands past a budget. */
export function readDefinition(path: string): { frontmatter: Record<string, unknown> | null; hash: Component['hash']; problem?: string } | null {
  const t = text(path);
  if (t === null) return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
  const fmText = m ? m[1] : null;
  const body = m ? t.slice(m[0].length) : t;
  const hash = { file: sha(t), body: sha(body), ...(fmText !== null ? { frontmatter: sha(fmText) } : {}) };
  if (fmText === null) return { frontmatter: null, hash };
  try {
    const fm = Bun.YAML.parse(fmText);
    if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) return { frontmatter: null, hash, problem: 'the frontmatter is not a mapping' };
    if (!withinBudget(fm)) return { frontmatter: null, hash, problem: 'the frontmatter expands past 5000 values or 1 MB (YAML aliases?)' };
    return { frontmatter: fm as Record<string, unknown>, hash };
  } catch (err) {
    return { frontmatter: null, hash, problem: `the frontmatter does not parse: ${String(err).slice(0, 120)}` };
  }
}

// ---- identifiers ----

/** Hook payload and output fields Claude Code documents (G0 measurements, plan §10.12). A
 *  script naming one depends on it. */
export const PAYLOAD_FIELDS = [
  'session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode', 'tool_name', 'tool_input', 'tool_response', 'tool_use_id',
  'prompt', 'stop_hook_active', 'last_assistant_message', 'agent_id', 'agent_type', 'agent_transcript_path', 'background_tasks',
  'session_crons', 'source', 'effort', 'trigger', 'custom_instructions', 'notification_type', 'error', 'is_interrupt', 'duration_ms',
  'prompt_id', 'context_tokens', 'permissionDecision', 'permissionDecisionReason', 'additionalContext', 'systemMessage', 'stopReason',
  'suppressOutput', 'hookSpecificOutput', 'updatedInput', 'decision', 'reason',
] as const;

const ENV_REF = /\$\{?([A-Z][A-Z0-9_]{2,})\}?|process\.env\.([A-Z][A-Z0-9_]{2,})|\benv\.([A-Z][A-Z0-9_]{2,})\b/g;
/** Env vars of the shell, not of Claude Code or a customization. */
const SHELL_ENV = new Set(['HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'OLDPWD', 'IFS', 'LOGNAME']);

/** Whether `src` names `word` as a whole token. */
function hasToken(src: string, word: string): boolean {
  for (let i = src.indexOf(word); i >= 0; i = src.indexOf(word, i + 1)) {
    if (!/[\w-]/.test(src[i - 1] ?? '') && !/[\w-]/.test(src[i + word.length] ?? '')) return true;
  }
  return false;
}

/** The identifiers a script or command names: payload fields, env vars, long flags. */
export function scanIdentifiers(src: string, into: Identifiers): void {
  for (const f of PAYLOAD_FIELDS) if (hasToken(src, f)) into.fields.push(f);
  for (const m of src.matchAll(ENV_REF)) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v && !SHELL_ENV.has(v)) into.env.push(v);
  }
  for (const m of src.matchAll(/(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-])/g)) into.flags.push(m[0]);
}

function uniqueSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort();
}

// ---- agents ----

// goodboy's lists, checked against the Claude Code 2.1.304 binary (K1b review). A newer CLI's
//   additions show as uncertain findings until they are added here.

/** Model values that follow Claude Code's choice; anything else pins a model. */
const MODEL_ALIASES = new Set(['inherit', 'best', 'sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'sonnet[1m]', 'opus[1m]', 'fable[1m]']);

/** Built-in tool names. A name outside this list and not an MCP name may resolve to nothing;
 *  the running CLI decides (uncertain). */
const KNOWN_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookEdit',
  'NotebookRead', 'TodoWrite', 'Task', 'Agent', 'Skill', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ToolSearch', 'REPL', 'JavaScript',
  'Monitor', 'LSP', 'SendMessage', 'SendUserMessage', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'PushNotification', 'RemoteTrigger', 'EnterWorktree', 'ExitWorktree',
]);

/** Agent frontmatter keys; another key may be ignored (uncertain). */
const AGENT_KEYS = new Set([
  'name', 'description', 'tools', 'disallowedTools', 'model', 'effort', 'color', 'permissionMode', 'maxTurns', 'skills', 'mcpServers', 'hooks',
  'memory', 'background', 'isolation', 'initialPrompt', 'autoCompactWindow', 'omitClaudeMd', 'observer', 'observerMessage', 'observeSubagents',
]);

/** The agent frontmatter values the checks read; the inventory keeps only these. */
const CHECKED_KEYS = ['name', 'model', 'tools', 'disallowedTools'] as const;

/** goodboy's leads delegate by design (§10.7); every other definition is a leaf. */
const GOODBOY_LEADS = new Set(['test-lead', 'review-lead', 'research-lead']);

/** A tools value as a list of names (`Read, Grep` or a YAML list); `Agent(a, b)` counts as
 *  Agent. Null when the key is absent (the agent inherits every tool). */
function toolList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  const raw = Array.isArray(v) ? v.map(String) : String(v).split(/,(?![^(]*\))/);
  return raw.map((x) => x.trim()).filter((x) => x !== '');
}

function toolName(entry: string): string {
  return entry.replace(/\(.*\)$/, '').trim();
}

/** The static checks of every agent definition in the inventory. */
export function checkAgents(agents: Component[]): AgentFinding[] {
  const out: AgentFinding[] = [];
  const named = (c: Component) => `${c.name} (${c.scope}: ${c.path})`;
  for (const a of agents) {
    if (a.problem) {
      out.push({ check: 'unreadable', agents: [named(a)], detail: a.problem, certainty: 'confirmed' });
      continue;
    }
    const fm = a.frontmatter ?? {};
    // Values from the file are cut in the text, and one agent gives at most 10 findings of a
    //   kind plus a count (K1b review 2: 4000 unknown keys broke the run-file cap).
    const clip = (v: unknown) => String(v).slice(0, 100);
    const some = (check: AgentFinding['check'], details: string[], certainty: AgentFinding['certainty']) => {
      for (const d of details.slice(0, 10)) out.push({ check, agents: [named(a)], detail: d, certainty });
      if (details.length > 10) out.push({ check, agents: [named(a)], detail: `and ${details.length - 10} more like these`, certainty });
    };
    const model = fm.model;
    if (typeof model === 'string' && model.trim() !== '' && !MODEL_ALIASES.has(model.trim())) {
      out.push({ check: 'pinned-model', agents: [named(a)], detail: `model: ${clip(model)} is pinned; intent unconfirmed (retirement, rejection or remap is checked with the running CLI)`, certainty: 'uncertain' });
    }
    const tools = toolList(fm.tools);
    const mcpBad: string[] = [];
    const unknownTools: string[] = [];
    for (const t of tools ?? []) {
      const n = toolName(t);
      if (n.startsWith('mcp__')) {
        if (!/^mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_*-]+)?$/.test(n)) mcpBad.push(`tools entry ${clip(t)} is not mcp__<server> or mcp__<server>__<tool>`);
      } else if (!KNOWN_TOOLS.has(n)) {
        unknownTools.push(`tools entry ${clip(t)} is not a tool goodboy knows; it may resolve to nothing`);
      }
    }
    some('mcp-syntax', mcpBad, 'confirmed');
    some('unknown-tool', unknownTools, 'uncertain');
    some('unknown-key', (a.keys ?? Object.keys(fm)).filter((k) => !AGENT_KEYS.has(k)).map((k) => `frontmatter key ${clip(k)} is not one goodboy knows; the running CLI may ignore it`), 'uncertain');
    // `disallowedTools` removes tools from the inherited set and is ignored when `tools` is set
    //   (2.1.304 schema); only a bare `Agent` or `Task` entry removes the whole tool.
    const disallowed = toolList(fm.disallowedTools) ?? [];
    const canDelegate = tools === null ? !disallowed.some((t) => t === 'Agent' || t === 'Task') : tools.map(toolName).some((n) => n === 'Agent' || n === 'Task');
    const isGoodboyLead = a.owner.startsWith('goodboy@') && GOODBOY_LEADS.has(a.name.replace(/^goodboy:/, ''));
    if (canDelegate && !isGoodboyLead) {
      out.push({
        check: 'delegation',
        agents: [named(a)],
        detail: tools === null ? 'no tools: it inherits every tool, the Agent tool included, which conflicts with the leaf rule' : 'it lists the Agent tool, which conflicts with the leaf rule',
        certainty: 'confirmed',
      });
    }
  }
  // Duplicates in one scope and owner, and shadowing across scopes (a project agent hides a
  //   user agent of the same name; plugin agents are namespaced).
  const byName = new Map<string, Component[]>();
  for (const a of agents) byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
  for (const [name, list] of byName) {
    const groups = new Map<string, Component[]>();
    for (const a of list) groups.set(`${a.scope}|${a.owner}`, [...(groups.get(`${a.scope}|${a.owner}`) ?? []), a]);
    for (const g of groups.values()) if (g.length > 1) out.push({ check: 'duplicate', agents: g.map(named), detail: `${g.length} definitions named ${name} in one scope`, certainty: 'confirmed' });
    const scopes = new Set(list.map((a) => a.scope));
    if (scopes.has('project') && scopes.has('user')) {
      out.push({ check: 'shadowed', agents: list.map(named), detail: `the project agent ${name} hides the user agent of the same name`, certainty: 'confirmed' });
    }
  }
  // Copies: the same body under different paths; divergence alone is no defect.
  const byBody = new Map<string, Component[]>();
  for (const a of agents) if (a.hash?.body) byBody.set(a.hash.body, [...(byBody.get(a.hash.body) ?? []), a]);
  for (const g of byBody.values()) if (g.length > 1) out.push({ check: 'copies', agents: g.map(named), detail: `${g.length} definitions share one body`, certainty: 'confirmed' });
  return out;
}

// ---- the inventory ----

interface Ctx {
  components: Component[];
  ids: Identifiers;
  problems: string[];
  /** The problems seen, for a constant-time dedupe (K1b review 2: a settings file of 50,000
   *  bad events took 52 s with Array.includes). */
  problemSet: Set<string>;
  scanned: Set<string>;
  scannedBytes: number;
  /** Definition and CLAUDE.md paths already listed: one file is one component. */
  paths: Set<string>;
}

const MAX_PROBLEMS = 200;
const MAX_COMMAND = 64 * 1024;
/** Frontmatter keys kept per definition. */
const MAX_KEYS = 200;
/** Identifiers kept per kind, and the length of each. */
const MAX_IDS = 2000;
const MAX_ID_LENGTH = 100;

const LEFT_OUT = 'more problems were left out';

/** Records a problem once. Past MAX_PROBLEMS only a note is kept, except for a cap that was
 *  reached (`always`), which is never lost. */
function problem(ctx: Ctx, p: string, always = false): void {
  const text = p.slice(0, 400);
  if (ctx.problemSet.has(text)) return;
  ctx.problemSet.add(text);
  if (always || ctx.problems.length < MAX_PROBLEMS) ctx.problems.push(text);
  else if (!ctx.problemSet.has(LEFT_OUT)) {
    ctx.problemSet.add(LEFT_OUT);
    ctx.problems.push(LEFT_OUT);
  }
}

/** Whether the component cap is reached; checked before a file is read. */
function full(ctx: Ctx): boolean {
  if (ctx.components.length < MAX_COMPONENTS) return false;
  problem(ctx, 'component cap reached', true);
  return true;
}

function add(ctx: Ctx, c: Component): void {
  if (full(ctx)) return;
  ctx.components.push(c);
  if (c.keys) ctx.ids.keys.push(...c.keys);
}

/** Scans a script file a hook runs, once, for the identifiers it names. */
function scanFile(ctx: Ctx, path: string): void {
  const p = canonical(path);
  if (ctx.scanned.has(p)) return;
  if (ctx.scanned.size >= MAX_SCANNED || ctx.scannedBytes >= MAX_SCAN_BYTES) {
    problem(ctx, 'script scan cap reached', true);
    return;
  }
  ctx.scanned.add(p);
  const t = text(p);
  if (t === null) return;
  ctx.scannedBytes += t.length;
  scanIdentifiers(t, ctx.ids);
}

/** Script files a hook command names, with ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PROJECT_DIR} and
 *  $HOME expanded and quotes joined (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh`), kept only
 *  under `within`: the plugin root, the project root, or HOME and the config dir, whichever
 *  owns the hook. */
function commandFiles(command: string, vars: { pluginRoot: string | null; projectDir: string; home: string }, within: string[]): string[] {
  // Function replacers: a path is text, never a replacement pattern (`$&` in a dir name).
  const expanded = command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, () => vars.pluginRoot ?? '\0')
    .replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/g, () => vars.projectDir)
    .replace(/\$\{HOME\}|\$HOME\b|(?<![\w/])~(?=\/)/g, () => vars.home);
  // A quoted part keeps its separators (hidden as private-use characters until the split) and
  //   joins what follows it.
  const hide = (s: string) => s.replace(/[\s;|&()<>]/g, (c) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
  const unquoted = expanded.replace(/"([^"]*)"|'([^']*)'/g, (_, a: string | undefined, b: string | undefined) => hide(a ?? b ?? ''));
  const out: string[] = [];
  for (const tok of unquoted.split(/[\s;|&()<>]+/)) {
    const p = tok.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));
    if (!p.startsWith('/') || p.includes('\0')) continue;
    const abs = resolve(p);
    if (within.some((w) => isUnder(abs, w))) out.push(abs);
  }
  return out;
}

/** The hooks of one settings or hooks.json object. */
function addHooks(ctx: Ctx, hooks: unknown, file: string, scope: Scope, owner: string, vars: { pluginRoot: string | null; projectDir: string; home: string }, within: string[]): void {
  if (hooks === undefined) return;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    problem(ctx, `${file}: "hooks" is not an object of events ({"PreToolUse": [...]}); Claude Code may not load these hooks`);
    return;
  }
  for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
    ctx.ids.events.push(event);
    if (!Array.isArray(arr)) {
      problem(ctx, `${file}: hooks.${event} is not a list`);
      continue;
    }
    for (const m of arr) {
      if (!m || typeof m !== 'object') {
        problem(ctx, `${file}: a hooks.${event} entry is not an object`);
        continue;
      }
      const { matcher, hooks: list } = m as { matcher?: unknown; hooks?: unknown };
      for (const h of Array.isArray(list) ? list : []) {
        if (!h || typeof h !== 'object') {
          problem(ctx, `${file}: a hooks.${event} hook is not an object`);
          continue;
        }
        const raw = (h as { command?: unknown }).command;
        // A command past 64 KB is read in part; the stored one is masked after it is cut, since
        //   two secret patterns are slow on long text (K1b review 2: 20 s on 200 KB).
        const command = typeof raw === 'string' ? raw.slice(0, MAX_COMMAND) : '';
        if (typeof raw === 'string' && raw.length > MAX_COMMAND) problem(ctx, `${file}: a hooks.${event} command is longer than ${MAX_COMMAND} characters; only its start is read`);
        add(ctx, { kind: 'hook', name: `${event}[${typeof matcher === 'string' ? matcher : ''}]`.slice(0, 200), scope, owner, path: canonical(file), configured: true, command: maskSecrets(command.slice(0, 2000)) });
        scanIdentifiers(command, ctx.ids);
        for (const f of commandFiles(command, vars, within)) scanFile(ctx, f);
      }
    }
  }
}

/** An agent's checked frontmatter values, each bounded. */
function checkedValues(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CHECKED_KEYS) {
    const v = fm[k];
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 500) : Array.isArray(v) ? v.slice(0, 100).map((x) => String(x).slice(0, 200)) : v !== null && typeof v === 'object' ? '[object]' : v;
  }
  return out;
}

/** Skills, agents and commands under a `.claude`-shaped dir or a plugin root. */
function addDefinitions(ctx: Ctx, root: string, scope: Scope, owner: string, prefix: string): void {
  const files: [string, Kind, string][] = [];
  for (const name of entries(join(root, 'skills'))) files.push([join(root, 'skills', name, 'SKILL.md'), 'skill', name]);
  for (const [dir, kind] of [['agents', 'agent'], ['commands', 'command']] as const) {
    for (const name of entries(join(root, dir))) if (name.endsWith('.md')) files.push([join(root, dir, name), kind, basename(name, '.md')]);
  }
  for (const [file, kind, base] of files) {
    if (full(ctx)) return;
    const path = canonical(file);
    if (ctx.paths.has(path)) continue;
    const d = readDefinition(file);
    if (d === null) {
      // A skill dir without SKILL.md is not a skill; a file that is there but not readable is.
      if (!exists(file) || isDir(file)) continue;
      ctx.paths.add(path);
      add(ctx, { kind, name: `${prefix}${base}`, scope, owner, path, configured: true, problem: 'not readable as a regular file up to 1 MB' });
      continue;
    }
    ctx.paths.add(path);
    const fm = d.frontmatter;
    const declared = kind === 'agent' && typeof fm?.name === 'string' ? fm.name : base;
    add(ctx, {
      kind,
      name: `${prefix}${declared}`,
      scope,
      owner,
      path,
      configured: true,
      hash: d.hash,
      keys: fm ? Object.keys(fm).slice(0, MAX_KEYS).map((k) => k.slice(0, MAX_ID_LENGTH)) : [],
      ...(kind === 'agent' ? { frontmatter: fm ? checkedValues(fm) : null } : {}),
      ...(d.problem ? { problem: d.problem } : {}),
    });
  }
}

/** The projects to scan: `cwd`'s nearest dir with `.claude` or `.git` (or `cwd`), then the
 *  ones the user registered (checkup-projects). No other project is scanned. A dir whose
 *  `.claude` is the config dir (HOME) is never a project: its files are the user's. */
export function projectRoots(cwd: string, registered: readonly string[], config: string = claudeConfigDir()): { current: string; roots: string[]; problems: string[] } {
  const problems: string[] = [];
  const cfg = canonical(config);
  const isConfigHome = (d: string) => canonical(join(d, '.claude')) === cfg;
  let current = canonical(resolve(cwd));
  for (let d = resolve(cwd); ; d = dirname(d)) {
    // The walk stops at HOME: a dir above it is no project of this cwd (K1b review 2: from
    //   HOME it found /private/tmp/.claude).
    if (isConfigHome(d)) break;
    if (isDir(join(d, '.claude')) || isDir(join(d, '.git'))) {
      current = canonical(d);
      break;
    }
    if (dirname(d) === d) break;
  }
  const roots = isConfigHome(current) ? [] : [current];
  for (const p of registered) {
    if (!isAbsolute(p)) problems.push(`registered project ${p} is not an absolute path`);
    else if (!isDir(p)) problems.push(`registered project ${p} does not exist`);
    else if (isConfigHome(p)) problems.push(`registered project ${p} holds the user config dir; its files are listed as the user's`);
    else roots.push(canonical(p));
  }
  return { current, roots: uniqueSorted(roots), problems };
}

/** The installation of a plugin that applies here: the current project's, else one without a
 *  project (user or managed); another project's never. */
function applicableInstall(list: unknown, current: string): { installPath?: unknown } | undefined {
  if (!Array.isArray(list)) return undefined;
  const entries = list.filter((e): e is { installPath?: unknown; projectPath?: unknown } => !!e && typeof e === 'object');
  const forProject = (e: { projectPath?: unknown }) => typeof e.projectPath === 'string' && canonical(e.projectPath) === current;
  return entries.find(forProject) ?? entries.find((e) => typeof e.projectPath !== 'string');
}

/** The whole inventory for `cwd` under the config dir of `env`, with the registered projects. */
export function buildInventory(cwd: string, env: NodeJS.ProcessEnv = process.env, registered: readonly string[] = []): Inventory {
  const config = claudeConfigDir(env);
  const home = (env.HOME ?? '').trim() || dirname(config);
  const ctx: Ctx = { components: [], ids: { events: [], fields: [], keys: [], flags: [], env: [] }, problems: [], problemSet: new Set(), scanned: new Set(), scannedBytes: 0, paths: new Set() };
  const { current, roots, problems } = projectRoots(cwd, registered, config);
  ctx.problems.push(...problems);

  // Settings: user, then each project's shared and local settings. Plugins are enabled by the
  //   settings that apply to the current project, last wins: user < project < local.
  const enabled = new Map<string, boolean>();
  const settingsFiles: [string, Scope, string, string][] = [[join(config, 'settings.json'), 'user', 'user', current]];
  for (const r of roots) {
    settingsFiles.push([join(r, '.claude', 'settings.json'), 'project', `project:${r}`, r], [join(r, '.claude', 'settings.local.json'), 'local', `project:${r}`, r]);
  }
  for (const [file, scope, owner, root] of settingsFiles) {
    const o = jsonObject(ctx, file);
    if (o === undefined) continue;
    ctx.ids.keys.push(...Object.keys(o));
    if (o.env && typeof o.env === 'object') ctx.ids.env.push(...Object.keys(o.env as object));
    if ((scope === 'user' || root === current) && o.enabledPlugins && typeof o.enabledPlugins === 'object') {
      for (const [id, on] of Object.entries(o.enabledPlugins as Record<string, unknown>)) enabled.set(id, on === true);
    }
    addHooks(ctx, o.hooks, file, scope, owner, { pluginRoot: null, projectDir: root, home }, scope === 'user' ? [home, config] : [root]);
  }

  // Plugins: installed (installed_plugins.json) vs configured (enabledPlugins).
  const installed = jsonObject(ctx, join(config, 'plugins', 'installed_plugins.json'));
  const listed = installed?.plugins;
  const plugins = listed && typeof listed === 'object' && !Array.isArray(listed) ? (listed as Record<string, unknown>) : {};
  const seen = new Set<string>();
  for (const [id, list] of Object.entries(plugins)) {
    seen.add(id);
    const entry = applicableInstall(list, current);
    const root = typeof entry?.installPath === 'string' ? entry.installPath : '';
    const present = root !== '' && isDir(root);
    add(ctx, { kind: 'plugin', name: id, scope: 'plugin', owner: id, path: present ? canonical(root) : root, configured: enabled.get(id) === true, installed: present });
    if (!present || enabled.get(id) !== true) continue;
    const plugin = id.split('@')[0];
    const hooksFile = join(root, 'hooks', 'hooks.json');
    const hj = jsonObject(ctx, hooksFile);
    if (hj) addHooks(ctx, hj.hooks, hooksFile, 'plugin', id, { pluginRoot: root, projectDir: current, home }, [root]);
    // A plugin's own hook scripts (goodboy's run TypeScript through a launcher).
    for (const f of entries(join(root, 'hooks'))) {
      const p = join(root, 'hooks', f);
      // A link out of the plugin is not the plugin's script.
      if (/\.(?:ts|js|mjs|sh|py)$/.test(f) && isUnder(p, root)) scanFile(ctx, p);
    }
    addDefinitions(ctx, root, 'plugin', id, `${plugin}:`);
  }
  for (const [id, on] of enabled) {
    if (on && !seen.has(id)) add(ctx, { kind: 'plugin', name: id.slice(0, 200), scope: 'plugin', owner: id.slice(0, 200), path: '', configured: true, installed: false });
  }

  // User and project definitions, and CLAUDE.md files.
  addDefinitions(ctx, config, 'user', 'user', '');
  for (const r of roots) addDefinitions(ctx, join(r, '.claude'), 'project', `project:${r}`, '');
  for (const [file, scope, owner] of [[join(config, 'CLAUDE.md'), 'user', 'user'], ...roots.flatMap((r) => [[join(r, 'CLAUDE.md'), 'project', `project:${r}`], [join(r, '.claude', 'CLAUDE.md'), 'project', `project:${r}`]])] as [string, Scope, string][]) {
    if (full(ctx)) break;
    const path = canonical(file);
    if (ctx.paths.has(path)) continue;
    const t = text(file);
    if (t === null) continue;
    ctx.paths.add(path);
    add(ctx, { kind: 'claude-md', name: basename(file), scope, owner, path, configured: true, hash: { file: sha(t) } });
  }

  const agents = ctx.components.filter((c) => c.kind === 'agent');
  const ids = (kind: keyof Identifiers): string[] => {
    const all = uniqueSorted(ctx.ids[kind].map((x) => x.slice(0, MAX_ID_LENGTH)));
    if (all.length > MAX_IDS) problem(ctx, `only the first ${MAX_IDS} of ${all.length} identifiers of kind ${kind} are kept`, true);
    return all.slice(0, MAX_IDS);
  };
  const identifiers: Identifiers = { events: ids('events'), fields: ids('fields'), keys: ids('keys'), flags: ids('flags'), env: ids('env') };
  return {
    config_dir: config,
    projects: roots,
    components: ctx.components,
    identifiers,
    agent_findings: checkAgents(agents),
    problems: ctx.problems,
  };
}

/** Every identifier, for `checkup-changelog --ids`. */
export function allIdentifiers(ids: Identifiers): string[] {
  return uniqueSorted([...ids.events, ...ids.fields, ...ids.keys, ...ids.flags, ...ids.env]);
}

/** Text from definition files on its way to the model: one line, bounded. It is data from
 *  files any cloned repo can hold, never instructions. */
const shown = (s: string, n = 200) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);

/** A short summary for the model's context; the whole inventory goes to the run dir. */
export function inventorySummary(inv: Inventory): Record<string, unknown> {
  const count = (k: Kind) => inv.components.filter((c) => c.kind === k).length;
  const plugins = inv.components.filter((c) => c.kind === 'plugin');
  // Plugin ids come from settings a cloned repo can hold (K1b review 2: 950 KB printed).
  const names = (list: Component[]) => [...list.slice(0, 30).map((p) => shown(p.name, 100)), ...(list.length > 30 ? [`and ${list.length - 30} more`] : [])];
  return {
    projects: inv.projects.map((p) => shown(p, 300)),
    counts: { plugins: count('plugin'), hooks: count('hook'), skills: count('skill'), agents: count('agent'), commands: count('command'), claude_md: count('claude-md') },
    plugins_not_installed: names(plugins.filter((p) => p.configured && !p.installed)),
    plugins_disabled: names(plugins.filter((p) => p.installed && !p.configured)),
    unreadable: inv.components.filter((c) => c.problem).map((c) => shown(`${c.kind} ${c.name}: ${c.problem}`)).slice(0, 20),
    identifiers: Object.fromEntries(Object.entries(inv.identifiers).map(([k, v]) => [k, (v as string[]).length])),
    agent_findings: inv.agent_findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.check]: (m[f.check] ?? 0) + 1 }), {}),
    problems: inv.problems.slice(0, 20).map((p) => shown(p, 300)),
  };
}

/** The lists the CLI prints after the summary, each capped, with what was left out. */
export function inventoryLists(inv: Inventory, maxFindings = 30, maxIds = 200): Record<string, unknown> {
  const left: Record<string, number> = {};
  const ids = Object.fromEntries(
    Object.entries(inv.identifiers).map(([k, v]) => {
      const list = v as string[];
      if (list.length > maxIds) left[k] = list.length - maxIds;
      return [k, list.slice(0, maxIds).map((x) => shown(x, 80))];
    }),
  );
  if (inv.agent_findings.length > maxFindings) left.agent_findings = inv.agent_findings.length - maxFindings;
  return {
    agent_findings_list: inv.agent_findings.slice(0, maxFindings).map((f) => ({ ...f, agents: f.agents.slice(0, 5).map((a) => shown(a)), detail: shown(f.detail) })),
    identifier_lists: ids,
    ...(Object.keys(left).length ? { left_out: left } : {}),
  };
}

/** The inventory that fits `max` bytes as compact JSON: on a large setup the last components
 *  are left out and named as a problem, so the run file can always be written and the
 *  printed summary says it is cut short. */
export function fitInventory(inv: Inventory, max: number): Inventory {
  const size = (v: Inventory) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (size(inv) <= max) return inv;
  // Cut in this order: components, agent findings, identifiers (K1b review 2: one agent with
  //   4000 keys broke the cap with no component to cut).
  const cut = (base: Inventory, key: 'components' | 'agent_findings', label: string): Inventory => {
    const n = base[key].length;
    const at = (k: number): Inventory => ({ ...base, [key]: base[key].slice(0, k), problems: [...base.problems, `inventory.json holds the first ${k} of ${n} ${label} (size cap)`] });
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(at(mid)) <= max) lo = mid;
      else hi = mid - 1;
    }
    return at(lo);
  };
  let v = cut(inv, 'components', 'components');
  if (size(v) > max) v = cut(v, 'agent_findings', 'agent findings');
  if (size(v) > max) {
    const ids = Object.fromEntries(Object.entries(v.identifiers).map(([k, l]) => [k, (l as string[]).slice(0, 100)])) as unknown as Identifiers;
    v = { ...v, identifiers: ids, problems: [...v.problems, 'inventory.json holds the first 100 identifiers of each kind (size cap)'] };
  }
  return v;
}
