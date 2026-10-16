// Bounded verification for document changes (track I, I1b, issue #7, plan §15.4). A field
// report: a docs-only task spent hours in test and review runs (mutation harnesses for prose,
// print and render sweeps, new rounds for optional findings). Until I3's classifier, a
// document change is one whose every file is a document (isDocumentFile); the review gate's
// message then shows the files, the class and the budget first, and the guidance after. A
// budget is a limit, never a pass criterion.

import { requiredDimensionsFor } from './review-dimensions';
import { isDocPath, projectRelative } from './role-limits';

/** The review budget of a document change: one review of at most this many minutes. */
export const DOC_REVIEW_BUDGET_MINUTES = 10;

const DOC_EXT = /\.(?:md|markdown|txt|rst|adoc|asciidoc)$/i;
/** Static assets count as documents only under a docs dir (a preview, a diagram). */
const STATIC_EXT = /\.(?:html?|css|svg|png|jpe?g|gif|webp|pdf)$/i;
const DOC_DIR = /(?:^|\/)docs?\//i;
/** The dimensions a document's review may need; any other means the file is not one. */
const DOC_DIMENSIONS = new Set<string>(['plan-completeness', 'ui-ux-accessibility']);

/** A document (repo-relative path): a doc by `isDocPath` that is prose, or a static asset
 *  under a docs dir, outside any `prototype` dir, whose review needs no code dimension. Not:
 *  code under a docs dir, MDX (it can hold components), a dependency manifest
 *  (`requirements.txt`: its review needs dependency-risk), `CMakeLists.txt` (I1b review). */
export function isDocumentFile(rel: string): boolean {
  if (!isDocPath(rel)) return false;
  if (rel.split('/').some((p) => p.toLowerCase() === 'prototype')) return false;
  if (/(?:^|\/)cmakelists\.txt$/i.test(rel)) return false;
  if (!DOC_EXT.test(rel) && !(STATIC_EXT.test(rel) && DOC_DIR.test(rel))) return false;
  return requiredDimensionsFor([rel]).every((d) => DOC_DIMENSIONS.has(d));
}

/** True when every file (absolute) is a document inside the project root. */
export function isDocumentChange(files: readonly string[], root: string): boolean {
  return (
    files.length > 0 &&
    files.every((f) => {
      const rel = projectRelative(f, root);
      return rel !== null && isDocumentFile(rel);
    })
  );
}

/** The document class, its budget and the guidance, for the review gate's message; empty
 *  when the change is not a document change. */
export function documentChangeNote(files: readonly string[], root: string): string {
  if (!isDocumentChange(files, root)) return '';
  const rels = files.map((f) => projectRelative(f, root)!);
  const shown = rels.slice(0, 5).join(', ') + (rels.length > 5 ? ` and ${rels.length - 5} more` : '');
  return (
    `Document change (class: document; ${rels.length} file${rels.length === 1 ? '' : 's'}: ${shown}). ` +
    `Budget: one review of at most ${DOC_REVIEW_BUDGET_MINUTES} minutes, presentation checks included; no test run ` +
    '(documents need none). The budget is a limit, not a pass criterion. Put this note in the reviewer\'s prompt ' +
    '(the reviewer does not see this message). For the reviewer: verify the changed parts ' +
    'and what they affect (counts, IDs, cross-references, shared styles); run the existing relevant checks and check ' +
    'changed claims against their sources; check presentation only where it changed (print only when pagination may ' +
    'change); build no new harness or mutation sweep; stop at the budget and list what was not verified. Delegate one ' +
    'combined review; report nonblocking medium and low findings and defer them to the next planned edit.'
  );
}
