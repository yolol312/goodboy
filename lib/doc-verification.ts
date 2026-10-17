// Bounded verification for document changes (track I, I1b, issue #7, plan §15.4). A field
// report: a docs-only task spent hours in test and review runs (mutation harnesses for prose,
// print and render sweeps, new rounds for optional findings). A document change is one whose
// every file is a document or a static preview (lib/verification-scope.ts, I3a); the review
// gate's message then shows the files, the class and the budget first, and the guidance after.
// A budget is a limit, never a pass criterion.

import { projectRelative } from './role-limits';
import { classifyFile, classifyPath } from './verification-scope';

/** The review budget of a document change: one review of at most this many minutes. */
export const DOC_REVIEW_BUDGET_MINUTES = 10;

/** A document or a static preview by its repo-relative path (lib/verification-scope.ts). Not:
 *  code under a docs dir, MDX (it can hold components), a dependency or build file, anything
 *  in a `prototype` dir. */
export function isDocumentFile(rel: string, previewGlobs: readonly string[] = []): boolean {
  return classifyPath(rel, previewGlobs) !== 'code';
}

/** True when every file (absolute) is a document or a static preview inside the project root
 *  (a preview's content is read: one that runs or loads from outside is code). */
export function isDocumentChange(files: readonly string[], root: string, previewGlobs: readonly string[] = []): boolean {
  return files.length > 0 && files.every((f) => projectRelative(f, root) !== null && classifyFile(f, root, previewGlobs) !== 'code');
}

/** The document class, its budget and the guidance, for the review gate's message; empty
 *  when the change is not a document change. */
export function documentChangeNote(files: readonly string[], root: string, previewGlobs: readonly string[] = []): string {
  if (!isDocumentChange(files, root, previewGlobs)) return '';
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
