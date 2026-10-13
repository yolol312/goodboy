// lib/acceptance.ts — English dev-cycle headings in any case (stabilization plan F1).
// Complements the "English dev-cycle documents (F1)" block of tests/acceptance.test.ts,
// which covers `## screens` and `## COMPONENTS`: here the changes table, whose heading is
// matched by a part (`## Changed screens — What changes`), and English headings with
// extra words, which take the same part match.
// Only APIs that predate F1 are imported, so the file also runs against older trees.

import { describe, expect, test } from 'bun:test';
import { extractUiuxCriteria } from '../lib/acceptance';

const changes = (heading: string): string =>
  [
    `## ${heading}`,
    '',
    '| Screen | Before | This version |',
    '|---|---|---|',
    '| Board | flat list | grouped by status |',
  ].join('\n');

const ids = (md: string): string[] => extractUiuxCriteria(md).map((c) => c.id);

describe('English headings in any case (F1)', () => {
  test.each([
    ['Changed screens — What changes'],
    ['Changed screens — what changes'],
    ['CHANGED SCREENS — WHAT CHANGES'],
    ['what changes'],
  ])('the changes table under "## %s" yields its criterion', (heading) => {
    const criteria = extractUiuxCriteria(changes(heading));
    expect(criteria.map((c) => c.id)).toEqual(['UIUX-CHG-1']);
    expect(criteria[0]?.description).toContain('grouped by status');
  });

  test('screens and components headings with extra words match by a part, in any case', () => {
    const md = [
      '## screens (this version)',
      '',
      '| Screen | Kind |',
      '|---|---|',
      '| Settings | NEW |',
      '',
      '## COMPONENTS USED',
      '',
      '| Component | Kind | Variants | States | Used on |',
      '|---|---|---|---|---|',
      '| TaskCard | changed | compact | - | Board |',
    ].join('\n');
    expect(ids(md)).toEqual(['UIUX-NEW-1', 'UIUX-COMP-1']);
  });

  // Round 3: the changes heading names screens too. Without an exact `## Screens`, the
  //   partial match fell on it and read the changes as the screen list.
  test('without an exact "## Screens", the screen list does not fall back to the changes table', () => {
    // The changes come first, so a partial match for "screens" meets them first.
    const md = [
      '## Changed screens — What changes',
      '',
      '| Screen | Before | This version |',
      '|---|---|---|',
      '| Board | new | grouped by status |',
      '',
      '## All screens of this version',
      '',
      '| Screen | Kind |',
      '|---|---|',
      '| Settings | new |',
    ].join('\n');
    const criteria = extractUiuxCriteria(md);
    expect(criteria.map((c) => c.description)).toEqual([
      '신규 화면이 존재하고 도달 가능하다: Settings',
      'Board: grouped by status',
    ]);
  });

  // Round 3 (final hallucination review): the literal English of 화면 목록 matched nothing.
  test('"## Screen list" is a screen list heading', () => {
    const md = ['## Screen list', '', '| Screen | Kind |', '|---|---|', '| Settings | new |'].join('\n');
    expect(extractUiuxCriteria(md).map((c) => c.description)).toEqual(['신규 화면이 존재하고 도달 가능하다: Settings']);
  });
});
