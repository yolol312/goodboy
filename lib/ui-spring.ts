// Spring MVC routes for the UI inventory (track M, M3; plan §19): `@Controller` and
// `@RestController` classes with their class-level `@RequestMapping` prefix and the
// `@Get|Post|Put|Delete|PatchMapping` and `@RequestMapping(method = …)` methods. A GET handler of a
// `@Controller` that returns a view (String, ModelAndView, View) is a screen; a handler that
// writes a body (`@ResponseBody`, a `@RestController`, ResponseEntity, void, an object) is an
// API; a non-GET view handler (a form target) is only a route templates link to. Source text is
// read with comments blanked; paths come from string literals and from `static final String`
// constants, and a path it cannot read is a note, never a guess.

import { normRoute, toPattern } from './ui-types';
import { type SrcFile, Sink, blankComments, findClose, idOf, lineAt, skipString, unquote } from './ui-scan-text';

interface Anno {
  name: string;
  args: string | null;
  pos: number;
}

interface ClassDecl {
  name: string;
  annos: Anno[];
  open: number;
  close: number;
}

interface MethodDecl {
  name: string;
  annos: Anno[];
  ret: string;
  pos: number;
}

const MAPPING_METHOD: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const MODIFIERS = /\b(?:public|protected|private|static|final|abstract|synchronized|default|native|open|override|suspend|internal)\b/g;
const VIEW_TYPES = new Set(['String', 'ModelAndView', 'View', 'Rendering']);
const HEADER_LIMIT = 3000;

const lastSegment = (name: string): string => name.slice(name.lastIndexOf('.') + 1);

/** Splits at top-level commas (or `sep`), skipping strings and brackets. */
export function splitTop(text: string, sep = ','): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const e = findClose(text, i);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if (c === sep) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** The `static final String` constants of the project, by `NAME` and `Class.NAME`. */
export function stringConstants(files: SrcFile[]): Map<string, string> {
  const raw = new Map<string, { cls: string; expr: string }>();
  for (const f of files) {
    const code = blankComments(f.text, 'c');
    const cls = /\b(?:class|interface|object)\s+(\w+)/.exec(code)?.[1] ?? '';
    for (const m of code.matchAll(/\b(?:static\s+final|const\s+val|final\s+static)\s+(?:String\s+)?(\w+)\s*(?::\s*String\s*)?=\s*([^;\n]+)/g)) raw.set(`${cls}.${m[1]}`, { cls, expr: m[2]!.trim() });
  }
  const out = new Map<string, string>();
  for (let round = 0; round < 3; round++) {
    for (const [key, { cls, expr }] of raw) {
      if (out.has(key)) continue;
      const v = evalStrings(expr, out, cls);
      if (v !== null && v.length === 1) {
        out.set(key, v[0]!);
        if (!out.has(key.slice(key.indexOf('.') + 1))) out.set(key.slice(key.indexOf('.') + 1), v[0]!);
      }
    }
  }
  return out;
}

/** The strings an expression stands for: literals, `+` of them, constants, `{ "a", "b" }` and
 *  `["a", "b"]`; null when something in it is not readable. */
export function evalStrings(expr: string, consts: Map<string, string>, cls = ''): string[] | null {
  const e = expr.trim();
  if (e === '') return [''];
  if ((e.startsWith('{') && e.endsWith('}')) || (e.startsWith('[') && e.endsWith(']'))) {
    const all: string[] = [];
    for (const part of splitTop(e.slice(1, -1))) {
      const v = evalStrings(part, consts, cls);
      if (v === null) return null;
      all.push(...v);
    }
    return all;
  }
  let acc = '';
  for (const term of splitTop(e, '+')) {
    const t = term.trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(t)) acc += unquote(t);
    else if (/^[\w.]+$/.test(t)) {
      const v = consts.get(t) ?? consts.get(`${cls}.${t}`) ?? consts.get(t.slice(t.lastIndexOf('.') + 1));
      if (v === undefined) return null;
      acc += v;
    } else return null;
  }
  return [acc];
}

function parseAnnoArgs(args: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (args === null) return out;
  for (const part of splitTop(args)) {
    const m = /^(\w+)\s*=\s*([\s\S]*)$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.trim());
    else if (!out.has('value')) out.set('value', part);
  }
  return out;
}

function annotationAt(code: string, i: number): { anno: Anno; end: number } | null {
  const m = /^@([A-Za-z_][\w.]*)/.exec(code.slice(i, i + 120));
  if (!m || m[1] === 'interface') return null;
  let end = i + m[0].length;
  let args: string | null = null;
  let j = end;
  while (j < code.length && /[ \t]/.test(code[j]!)) j++;
  if (code[j] === '(') {
    const c = findClose(code, j);
    if (c < 0) return null;
    args = code.slice(j + 1, c);
    end = c + 1;
  }
  return { anno: { name: lastSegment(m[1]!), args, pos: i }, end };
}

/** Class and method declarations that carry at least one annotation. */
function declarations(code: string): { classes: ClassDecl[]; methods: MethodDecl[] } {
  const classes: ClassDecl[] = [];
  const methods: MethodDecl[] = [];
  for (let i = 0; i < code.length; ) {
    const c = code[i]!;
    if (c === '"' || c === "'") {
      i = skipString(code, i);
      continue;
    }
    if (c !== '@') {
      i++;
      continue;
    }
    const annos: Anno[] = [];
    let at = i;
    for (;;) {
      const a = annotationAt(code, at);
      if (!a) break;
      annos.push(a.anno);
      at = a.end;
      while (at < code.length && /\s/.test(code[at]!)) at++;
      if (code[at] !== '@') break;
    }
    if (annos.length === 0) {
      i++;
      continue;
    }
    // the header: up to the first `{`, `;` or `=` outside parentheses
    let h = at;
    let stop = -1;
    while (h < code.length && h - at < HEADER_LIMIT) {
      const ch = code[h]!;
      if (ch === '(') {
        const e = findClose(code, h);
        if (e < 0) break;
        h = e + 1;
        continue;
      }
      if (ch === '{' || ch === ';' || ch === '=') {
        stop = h;
        break;
      }
      h++;
    }
    if (stop < 0) {
      i = at;
      continue;
    }
    const header = code.slice(at, stop);
    const cls = /\b(?:class|interface|enum|record|object)\s+(\w+)/.exec(header);
    if (cls && code[stop] === '{') {
      classes.push({ name: cls[1]!, annos, open: stop, close: Math.max(findClose(code, stop), stop) });
    } else {
      const fun = /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/.exec(header);
      const java = fun ? null : /^([\s\S]*?)(\w+)\s*\(/.exec(header);
      if (fun) {
        const paren = at + header.indexOf('(', fun.index);
        const close = findClose(code, paren);
        const after = close < 0 ? '' : code.slice(close + 1, stop);
        const rt = /^\s*:\s*([^={]+)/.exec(after);
        methods.push({ name: fun[1]!, annos, ret: rt ? rt[1]!.trim() : 'Unit', pos: annos[0]!.pos });
      } else if (java) {
        const ret = java[1]!.replace(MODIFIERS, ' ').replace(/^\s*<[^>]*>/, '').trim();
        methods.push({ name: java[2]!, annos, ret, pos: annos[0]!.pos });
      }
    }
    i = stop; // the parameters' annotations are not declarations
  }
  return { classes, methods };
}

/** `Map<String, Object>` → `Map`; `ResponseEntity<String>` → `ResponseEntity`. */
const baseType = (t: string): string => t.replace(/<[\s\S]*>/, '').replace(/\?/g, '').trim().split(/[\s.]+/).pop() ?? '';

function requestMethods(argText: string | undefined): string[] {
  if (argText === undefined) return ['ANY'];
  const found = [...argText.matchAll(/RequestMethod\.(\w+)|\b(GET|POST|PUT|DELETE|PATCH)\b/g)].map((m) => (m[1] ?? m[2]!).toUpperCase());
  return found.length > 0 ? [...new Set(found)] : ['ANY'];
}

/** Adds the Spring MVC routes of `files` (Java and Kotlin sources) to the sink. */
export function springRoutes(files: SrcFile[], consts: Map<string, string>, sink: Sink): void {
  for (const f of files) {
    if (!/@(?:\w+\.)*(?:Controller|RestController|RequestMapping|GetMapping|PostMapping)\b/.test(f.text)) continue;
    const code = blankComments(f.text, 'c');
    const { classes, methods } = declarations(code);
    const cls = /\b(?:class|interface|object)\s+(\w+)/.exec(code)?.[1] ?? '';
    const pathsOf = (a: Anno): string[] | null => {
      const args = parseAnnoArgs(a.args);
      const expr = args.get('value') ?? args.get('path');
      if (expr === undefined) return [''];
      const v = evalStrings(expr, consts, cls);
      if (v === null) sink.note(`${f.rel}:${lineAt(code, a.pos)} @${a.name} path is not a literal or a known constant: its routes are not listed`);
      return v;
    };
    for (const m of methods) {
      const owner = classes.filter((c) => c.open < m.pos && m.pos < c.close).sort((a, b) => b.open - a.open)[0];
      if (!owner) continue;
      const names = new Set(owner.annos.map((a) => a.name));
      if (!names.has('Controller') && !names.has('RestController')) continue;
      const mapping = m.annos.find((a) => a.name in MAPPING_METHOD || a.name === 'RequestMapping');
      if (!mapping) continue;
      const classMaps = owner.annos.filter((a) => a.name === 'RequestMapping');
      let prefixes: string[] = [''];
      if (classMaps.length > 0) {
        const p = pathsOf(classMaps[0]!);
        if (p === null) continue;
        prefixes = p;
      }
      const own = pathsOf(mapping);
      if (own === null) continue;
      const verbs = mapping.name in MAPPING_METHOD ? [MAPPING_METHOD[mapping.name]!] : requestMethods(parseAnnoArgs(mapping.args).get('method'));
      const body = names.has('RestController') || names.has('ResponseBody') || m.annos.some((a) => a.name === 'ResponseBody');
      const rt = baseType(m.ret);
      const isView = !body && VIEW_TYPES.has(rt);
      const line = lineAt(code, mapping.pos);
      for (const prefix of prefixes) {
        for (const p of own) {
          const route = toPattern(normRoute(`${prefix}/${p}`));
          for (const verb of verbs) {
            const handler = `${owner.name}.${m.name}`;
            if (isView && (verb === 'GET' || verb === 'ANY')) {
              const method = 'GET';
              sink.route({ method, pattern: route, file: f.rel, line, kind: 'screen' });
              sink.add({ id: idOf('screen', method, route), kind: 'screen', method, route, file: f.rel, line, input: false, label: `${method} ${route} (${handler})` });
            } else if (isView) {
              sink.route({ method: verb, pattern: route, file: f.rel, line, kind: 'handler' });
            } else {
              sink.route({ method: verb, pattern: route, file: f.rel, line, kind: 'api' });
              sink.add({ id: idOf('api', verb, route), kind: 'api', method: verb, route, file: f.rel, line, input: false, label: `${verb} ${route} (${handler})` });
            }
          }
        }
      }
    }
  }
}

