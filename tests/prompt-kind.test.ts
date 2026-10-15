import { describe, expect, test } from 'bun:test';
import { isGoodboyCommand, isTaskNotification, parseSlashCommand } from '../lib/prompt-kind';

describe('isTaskNotification (G0 M10: completions arrive as prompts)', () => {
  test('a background-task completion block is a notification', () => {
    const p = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>';
    expect(isTaskNotification(p)).toBe(true);
    expect(isTaskNotification(`\n  ${p}`)).toBe(true);
  });

  test('a user prompt that mentions the tag is not', () => {
    expect(isTaskNotification('why did <task-notification> show up?')).toBe(false);
    expect(isTaskNotification('')).toBe(false);
  });
});

describe('parseSlashCommand (G0 M12: typed commands arrive verbatim)', () => {
  test('bare command with arguments', () => {
    expect(parseSlashCommand('/fix-bug 로그인 후 401')).toEqual({
      namespace: null,
      name: 'fix-bug',
      args: '로그인 후 401',
    });
  });

  test('namespaced command', () => {
    expect(parseSlashCommand('/goodboy:migrate add a column')).toEqual({
      namespace: 'goodboy',
      name: 'migrate',
      args: 'add a column',
    });
  });

  test('arguments may span lines', () => {
    expect(parseSlashCommand('/add-feature first line\nsecond line')?.args).toBe(
      'first line\nsecond line',
    );
  });

  test('argument-free command', () => {
    expect(parseSlashCommand('  /fix-bug  ')).toEqual({ namespace: null, name: 'fix-bug', args: '' });
  });

  test('a command on a later line (pasted text) is not a command', () => {
    expect(parseSlashCommand('see this log:\n/fix-bug crash on save')).toBeNull();
  });

  test('plain text and paths are not commands', () => {
    expect(parseSlashCommand('just a message')).toBeNull();
    expect(parseSlashCommand('/Users/me/file.ts is broken')).toBeNull();
  });
});

describe('isGoodboyCommand', () => {
  test('bare and goodboy-namespaced commands are ours; other plugins are not', () => {
    expect(isGoodboyCommand({ namespace: null, name: 'fix-bug', args: '' })).toBe(true);
    expect(isGoodboyCommand({ namespace: 'goodboy', name: 'fix-bug', args: '' })).toBe(true);
    expect(isGoodboyCommand({ namespace: 'other', name: 'fix-bug', args: '' })).toBe(false);
  });
});
