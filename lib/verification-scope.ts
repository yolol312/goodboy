// What a changed file needs verified (track I, I3a, issue #4, plan §15.6): a document, a static
// preview or code. One rule for every call site; it replaces three that disagreed (layer 1's
// extension list, the role limits' "anything under docs/", and a copy of the extension list in
// the reasoning gate), under which code and prototypes under docs/ needed no test.
//
// Documents and previews need no test record (their review is the evidence); code does. A
// preview is static HTML or CSS in a dev-cycle `preview/` dir, or under a `static-preview:`
// glob of the user's (pinned at session start, lib/changed-coverage.ts). Its content is
// checked: anything that runs, loads from outside the preview, or templates is code. So is an
// SVG document that can run script, and any document or preview reached through a link.

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import { MAX_DOC_BYTES, readRegular } from './safe-read';
import { isTestFile, TEST_RUNNER_CONFIG } from './test-validator';

export type VerificationScope = 'document' | 'preview' | 'code';

const PROSE = /\.(?:md|markdown|txt|rst|adoc|asciidoc)$/;
/** Images, PDFs, video and diagram sources are documents only under a docs dir. SVG content is
 *  checked (it can hold script). */
const DOC_ASSET = /\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?|pdf|mp4|webm|drawio|excalidraw|mmd|puml)$/;
const DOC_DIR = /(?:^|\/)docs?\//;
/** Prose-named files that are dependency or build input, never documents. */
const NOT_DOCUMENT = /(?:^|\/)(?:requirements[^/]*\.txt|constraints[^/]*\.txt|cmakelists\.txt)$/;
const PREVIEW_EXT = /\.(?:html?|css)$/;
/** The dev-cycle preview dir: `docs/versions/<v>/preview/` (group 1 is the dir). */
const DEFAULT_PREVIEW = /^((?:.*\/)?docs\/versions\/[^/]+\/preview)\//;

const slashes = (p: string) => p.split('\\').join('/');
const hasPrototype = (lower: string) => lower.split('/').includes('prototype');

/** The static part of a glob before its first wildcard segment (`design/mock/**` → `design/mock`). */
function globBase(glob: string): string {
  const out: string[] = [];
  for (const part of slashes(glob).split('/')) {
    if (/[*?[\]{}!]/.test(part)) break;
    out.push(part);
  }
  return out.join('/');
}

/** The preview dir a path's resources must stay in, or null when the path is no preview. */
function previewBase(rel: string, globs: readonly string[]): string | null {
  const lower = rel.toLowerCase();
  if (!PREVIEW_EXT.test(lower) || hasPrototype(lower)) return null;
  const m = DEFAULT_PREVIEW.exec(lower);
  if (m) return rel.slice(0, m[1]!.length);
  for (const g of globs) {
    try {
      if (new Bun.Glob(g).match(rel)) return globBase(g);
    } catch {
      // a malformed glob matches nothing
    }
  }
  return null;
}

/** The class of a repo-relative path, without reading the file. */
export function classifyPath(rel: string, previewGlobs: readonly string[] = []): VerificationScope {
  const p = slashes(rel);
  const lower = p.toLowerCase();
  if (hasPrototype(lower)) return 'code';
  if (/(?:^|\/)\.goodboy\/docs\.json$/.test(lower)) return 'document';
  if (PROSE.test(lower)) return NOT_DOCUMENT.test(lower) ? 'code' : 'document';
  if (DOC_ASSET.test(lower) && DOC_DIR.test(lower)) return 'document';
  return previewBase(p, previewGlobs) !== null ? 'preview' : 'code';
}

const BANNED_ELEMENTS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'base']);
/** Attributes that make a template or framework run the markup. */
const DIRECTIVE_ATTR = /^(?:v-|x-|ng-|data-ng-|hx-|:|@)/;
const TEMPLATE_TEXT = /\{\{|\{%|<%/;
/** Attributes holding a URL the page loads or submits to. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'background', 'manifest', 'ping', 'cite', 'longdesc']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
/** SVG animation values, which can set an `href` to a script URL (`;`-separated lists). */
const ANIMATION_ATTRS = new Set(['values', 'to', 'from', 'by']);
/** Elements whose `href` is a link to follow, not a resource to load. */
const LINK_ELEMENTS = new Set(['a', 'area']);
/** A character the decoder could not resolve: a URL holding one is not checked, so it fails. */
const UNKNOWN = '\uFFFF';
const NAMED: Record<string, string> = {
  colon: ':', tab: '\t', newline: '\n', sol: '/', bsol: '\\', lpar: '(', rpar: ')', period: '.', comma: ',', semi: ';',
  num: '#', quest: '?', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', equals: '=', excl: '!', percnt: '%',
  commat: '@', dollar: '$', plus: '+', ast: '*', lowbar: '_', hyphen: '-', dash: '-', grave: '`', lsqb: '[', rsqb: ']',
};

/** HTML character references decoded as a browser does before it uses a value (numeric with or
 *  without `;`, and the named ones a URL can be spelled with; letter case folded, so `&Colon;`
 *  reads as `:`, which only fails more). An unknown named reference becomes UNKNOWN. */
function decodeEntities(v: string): string {
  if (!v.includes('&')) return v;
  return v.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, ref: string) => {
    if (ref.startsWith('#')) {
      const code = /^#[xX]/.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : UNKNOWN;
    }
    return NAMED[ref.toLowerCase()] ?? (m.endsWith(';') ? UNKNOWN : m);
  });
}

function inside(target: string, base: string): boolean {
  if (target === '..' || target.startsWith('../')) return false;
  return base === '' || target === base || target.startsWith(`${base}/`);
}

/** Why a URL in a preview is not static, or null. `resource`: loaded by the page (a link may
 *  point anywhere, but never run script). `base` null: active content only, no locality (an
 *  SVG document). */
function urlProblem(raw: string, resource: boolean, fileRel: string, base: string | null): string | null {
  const shown = raw.trim().slice(0, 60);
  // An unknown reference matters where it can spell a scheme: before the first `/`, `?` or `#`.
  if (raw.split(/[/?#]/)[0]!.includes(UNKNOWN)) return `a URL with an encoded character goodboy cannot read (${shown})`;
  // Browsers drop tabs, newlines and other controls inside a URL and read `\` as `/`.
  const v = slashes(raw.trim().replace(/[\u0000-\u001f\u007f]/g, ''));
  const lower = v.toLowerCase();
  if (lower === '' || lower.startsWith('#')) return null;
  if (/^(?:javascript|vbscript):/.test(lower)) return `a script URL (${shown})`;
  if (lower.startsWith('data:')) return lower.startsWith('data:image/') ? null : `a data: URL that is not an image (${shown})`;
  if (!resource || base === null) return null;
  if (/^[a-z][a-z0-9+.-]*:/.test(lower) || lower.startsWith('/')) return `a resource from outside the preview (${shown})`;
  let path = v.split(/[?#]/)[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    // kept as written
  }
  const target = posix.normalize(posix.join(posix.dirname(fileRel), path));
  return inside(target, base) ? null : `a resource from outside the preview (${shown})`;
}

/** The most resource references (`url(`, `image-set(`, `@import`) a preview's CSS may hold;
 *  past it the CSS is not checked, so it is not static (a crafted file made each Stop slow). */
const MAX_CSS_REFS = 2000;
/** The text read after a reference: every quoted string in it, and a bare `url(` argument,
 *  is checked as a URL. */
const REF_WINDOW = 1024;

/** Why CSS is not static, or null. It does not emulate the CSS tokenizer (escapes, comments
 *  and strings made each emulation readable in a way the browser does not, I3a review rounds 1
 *  and 2); it fails closed instead: no backslash escapes at all, comments are not removed (a
 *  commented-out remote URL also counts), and every string near a reference is a URL. Linear:
 *  at most MAX_CSS_REFS windows of REF_WINDOW characters. */
function cssProblem(css: string, fileRel: string, base: string | null): string | null {
  const lower = css.toLowerCase();
  // Positions found in `lower` cut windows from `css`: a character whose lower case is longer
  //   (U+0130) would shift every window past its URL (closing review).
  if (lower.length !== css.length) return 'CSS with characters goodboy cannot index';
  if (lower.includes('\\')) return 'CSS with backslash escapes';
  for (const bad of ['expression(', 'behavior', '-moz-binding', 'javascript:', 'vbscript:']) {
    if (lower.includes(bad)) return `CSS with \`${bad}\``;
  }
  const check = (url: string) => urlProblem(url, true, fileRel, base);
  let refs = 0;
  for (const marker of ['url(', 'src(', 'image-set(', '@import']) {
    for (let at = lower.indexOf(marker); at !== -1; at = lower.indexOf(marker, at + marker.length)) {
      if (++refs > MAX_CSS_REFS) return 'more resource references than goodboy checks';
      const win = css.slice(at + marker.length, at + marker.length + REF_WINDOW);
      const lead = win.trimStart();
      if (lead === '') return 'a reference with no URL in reach';
      const q = lead[0];
      // A quoted URL that does not close in the window cannot be read whole (spaces before a
      //   remote URL are trimmed by the browser); a long data image is fine.
      if ((q === '"' || q === "'") && lead.indexOf(q, 1) === -1 && !/^data:image\//i.test(lead.slice(1).trimStart())) {
        return 'a URL too long to check';
      }
      for (const m of win.matchAll(/(["'])([^"']*)\1/g)) {
        const problem = check(m[2]!);
        if (problem) return problem;
      }
      if (marker === 'url(') {
        const bare = /^([^"'\s)][^\s)]*)/.exec(lead);
        const problem = bare ? check(bare[1]!) : null;
        if (problem) return problem;
      }
    }
  }
  return null;
}

/** Why a preview file's content is not static, or null when it is. HTML is parsed (Bun's
 *  HTMLRewriter), not grepped, and every attribute value is entity-decoded first. `fileRel`
 *  and `base` are repo-relative; `base` null checks active content only (an SVG document). */
export function previewProblem(text: string, kind: 'html' | 'css', fileRel: string, base: string | null): string | null {
  if (kind === 'css') return cssProblem(text, fileRel, base);
  // An SVG document is XML: a DTD entity can expand to markup HTMLRewriter never sees.
  if (/<!entity/i.test(text)) return 'a DTD entity declaration';
  let problem: string | null = null;
  const note = (p: string | null) => {
    problem ??= p;
  };
  // Element and attribute names by their local part: in XML `svg:script`, `h:script` and
  //   `x:href` are `script` and `href`.
  const local = (name: string) => name.toLowerCase().split(':').pop()!;
  let styles = '';
  try {
    new HTMLRewriter()
      .on('*', {
        element(el) {
          const tag = local(el.tagName);
          if (BANNED_ELEMENTS.has(tag)) note(`a <${tag}> element`);
          for (const [name, raw] of el.attributes) {
            const n = name.toLowerCase();
            const ln = local(n);
            const value = decodeEntities(raw);
            if (ln.startsWith('on')) note(`an event handler (${n})`);
            else if (DIRECTIVE_ATTR.test(n) || TEMPLATE_TEXT.test(value)) note(`a template directive (${n})`);
            else if (ln === 'style') note(cssProblem(value, fileRel, base));
            else if (ln === 'http-equiv' && value.trim().toLowerCase() === 'refresh') note('a refresh redirect');
            else if (SRCSET_ATTRS.has(ln)) {
              for (const cand of value.split(',')) note(urlProblem(cand.trim().split(/\s+/)[0] ?? '', true, fileRel, base));
            } else if (ANIMATION_ATTRS.has(ln)) {
              // The animated element is unknown here: a value is checked as a resource.
              for (const part of value.split(';')) note(urlProblem(part, true, fileRel, base));
            } else if (URL_ATTRS.has(ln) && n !== 'xmlns' && !n.startsWith('xmlns:')) {
              note(urlProblem(value, !(LINK_ELEMENTS.has(tag) && (ln === 'href' || ln === 'ping')), fileRel, base));
            }
          }
        },
      })
      .on('style', {
        text(t) {
          styles += t.text;
        },
      })
      .onDocument({
        text(t) {
          if (TEMPLATE_TEXT.test(t.text)) note('a template directive in the text');
        },
      })
      .transform(text);
  } catch {
    return 'HTML that could not be parsed';
  }
  // Style text decoded too: inside `<svg>` a style element's character references are.
  return problem ?? cssProblem(decodeEntities(styles), fileRel, base);
}

function relativeInside(abs: string, root: string): string | null {
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return slashes(rel);
}

/** A path with its symlinks resolved; one that does not exist (a deleted file) through its
 *  nearest existing parent. */
function realish(p: string): string {
  const full = resolvePath(p);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realish(parent), basename(full));
  }
}

/** Repo-relative with `/`, symlinks resolved on both sides; null outside the root. */
function realRelative(abs: string, root: string): string | null {
  return relativeInside(realish(abs), realish(root));
}

/** Classes already decided in this process, by path and the file's identity (a Stop asks for
 *  the same files several times; a preview can be 2 MB to parse). */
const decided = new Map<string, { sig: string; scope: VerificationScope }>();

function classifyUncached(abs: string, root: string, previewGlobs: readonly string[]): VerificationScope {
  const rel = realRelative(abs, root);
  if (rel === null) return classifyPath(slashes(abs), []) === 'document' && !/\.svg$/i.test(abs) ? 'document' : 'code';
  const scope = classifyPath(rel, previewGlobs);
  if (scope === 'code') return scope;
  let st;
  try {
    st = statSync(abs);
  } catch {
    return scope; // deleted: nothing to run
  }
  // A hard link shares its content with another path, which may be code (realpath cannot
  //   tell which); a document or preview is a file of its own.
  if (st.isFile() && st.nlink > 1) return 'code';
  const svg = /\.svg$/i.test(rel);
  if (scope === 'document' && !svg) return scope;
  const read = readRegular(abs, MAX_DOC_BYTES);
  if (read === 'absent') return scope;
  if (read === 'refused') return 'code';
  if (svg) return previewProblem(read.text, 'html', rel, null) === null ? scope : 'code';
  const kind = /\.css$/i.test(rel) ? 'css' : 'html';
  return previewProblem(read.text, kind, rel, previewBase(rel, previewGlobs)!) === null ? 'preview' : 'code';
}

/** The class of a file: its path class (symlinks resolved: a link is classed as its target),
 *  then its content. A preview is a preview only when its content is static, an SVG document
 *  only when it holds no active content; one that cannot be read as a regular file, is over
 *  the cap, or is a hard link is code. A deleted file keeps its path class. */
export function classifyFile(abs: string, root: string, previewGlobs: readonly string[] = []): VerificationScope {
  let sig = 'absent';
  try {
    const l = lstatSync(abs);
    const s = statSync(abs);
    sig = `${l.ino}:${l.mtimeMs}:${s.ino}:${s.size}:${s.mtimeMs}:${s.nlink}`;
  } catch {
    // absent or unreadable: decided again each time (cheap)
  }
  const key = `${abs}\n${root}\n${previewGlobs.join('\n')}`;
  const hit = decided.get(key);
  if (hit && hit.sig === sig && sig !== 'absent') return hit.scope;
  const scope = classifyUncached(abs, root, previewGlobs);
  decided.set(key, { sig, scope });
  return scope;
}

/** Layer 1: does this changed file need a test? Code does; test files, test runner configs
 *  (track L review), documents and static previews do not. A test-named link into code is
 *  code. */
export function needsTests(abs: string, root: string, previewGlobs: readonly string[] = []): boolean {
  // Seen below the root only: a repo under a tests/ dir would make every file a test file.
  const spelled = relativeInside(resolvePath(abs), resolvePath(root)) ?? slashes(abs);
  const testTool = (p: string) => isTestFile(p) || TEST_RUNNER_CONFIG.test(p);
  if (testTool(spelled)) {
    const real = realRelative(abs, root);
    // A test name is trusted only for a file of its own: a symlink is judged by its target,
    //   and a hard link may share its content with code.
    let shared = false;
    try {
      shared = statSync(abs).nlink > 1;
    } catch {
      // deleted: nothing to run
    }
    if (!shared && (real === null || testTool(real))) return false;
  }
  return classifyFile(abs, root, previewGlobs) === 'code';
}

/** Requirements Markdown: a dev-cycle document, whose review checks the plan. */
export function isRequirementsDoc(rel: string): boolean {
  const lower = slashes(rel).toLowerCase();
  if (!lower.endsWith('.md')) return false;
  const base = lower.split('/').pop()!;
  return /(?:^|\/)docs\/versions\//.test(lower) || /^(?:requirements|backlog)[^/]*\.md$/.test(base) || /(?:^|\/)docs\/cycle\.md$/.test(lower);
}
