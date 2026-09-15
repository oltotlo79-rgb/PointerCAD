import { describe, expect, it } from 'vitest';
import { COMMAND_DEFINITIONS } from './commandDefinitions.js';
import { currentShortcutMarkdown, resolveShortcutTable, SHORTCUT_TABLE_MARKER } from './shortcutMarkdown.js';

describe('shortcut Markdown', () => {
  it('renders every registered binding from the command source of truth', () => {
    const markdown = currentShortcutMarkdown();
    const bindings = COMMAND_DEFINITIONS.reduce((count, definition) => count + definition.shortcuts.length, 0);
    expect(markdown.split('\n')).toHaveLength(bindings + 2);
    expect(markdown).toContain('| 保存 | `Ctrl/Cmd+S` |');
  });

  it('replaces one marker and rejects duplicate generated-list positions', () => {
    expect(resolveShortcutTable(`# 一覧\n\n${SHORTCUT_TABLE_MARKER}`)).not.toContain(SHORTCUT_TABLE_MARKER);
    expect(() => resolveShortcutTable(`${SHORTCUT_TABLE_MARKER}\n${SHORTCUT_TABLE_MARKER}`)).toThrow();
  });

  it('変更したキーと入力保護の説明を表示し、割当を外した古いキーを載せない', () => {
    const markdown = currentShortcutMarkdown({
      'file.open': { key: 'f2', primary: false, shift: false, alt: false }, 'file.new': null,
    });
    expect(markdown).toContain('| 開く | `F2` | 対象の画面（文字入力・メニュー・ダイアログを除く） |');
    expect(markdown).not.toContain('Ctrl/Cmd+O');
    expect(markdown).not.toContain('Ctrl/Cmd+N');
    expect(markdown).toContain('| 保存 | `Ctrl/Cmd+S` |');
    expect(currentShortcutMarkdown()).toContain('Ctrl/Cmd+O');
  });
});
