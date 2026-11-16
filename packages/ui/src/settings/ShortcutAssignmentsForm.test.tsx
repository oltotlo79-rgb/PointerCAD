import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { COMMAND_DEFINITIONS } from '../commands/commandDefinitions.js';
import type { ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { ShortcutAssignmentsForm } from './ShortcutAssignmentsForm.js';

/* 設計 1-4・§6.2: キーのタブは「操作名｜使う場所｜今のキー」の表で全ての命令が見え、衝突の印と件数を出す。 */
function render(current: ShortcutAssignments): string {
  return renderToStaticMarkup(<ShortcutAssignmentsForm current={current} onApply={vi.fn(() => true)} />);
}

describe('キーの割当の表(B-06)', () => {
  it('全ての命令の行を、操作名・使う場所・今のキー・状態の列で持ち、名前とキーで探す欄と絞り込みを出す', () => {
    const markup = render({});
    expect(markup).toContain(`aria-label="${t('settings.shortcuts.command')}"`);
    for (const key of ['name', 'scope', 'keys', 'state'] as const) expect(markup).toContain(`>${t(`settings.shortcuts.column.${key}`)}</th>`);
    expect(markup.match(/data-command-id="/gu)).toHaveLength(COMMAND_DEFINITIONS.length);
    expect(markup).toContain(`title="${t('settings.shortcuts.commandGuide')}"`);
    expect(markup).toContain(`>${t('settings.shortcuts.keySearch')}</button>`);
    expect(markup).toContain(`title="${t('settings.shortcuts.problemsOnlyGuide')}"`);
    expect(markup).toContain(t('settings.shortcuts.count').replace('{total}', String(COMMAND_DEFINITIONS.length))
      .replace('{shown}', String(COMMAND_DEFINITIONS.length)).replace('{conflicts}', '0'));
    // 最初に選ばれている行と、固定の命令の印。
    expect(markup).toMatch(/<tr aria-selected="true"><td><button[^>]*data-command-id="file\.open"/u);
    expect(markup).toContain(`>${t('settings.shortcuts.fixedBadge')}</td>`);
    expect(markup).toContain(t('settings.shortcuts.selected').replace('{name}', `${t('toolbar.file.open')}（`));
  });

  it('同じキーの 2 つの命令に衝突の印を付け、件数に数え、適用を断る', () => {
    const markup = render({ 'history.undo': [{ key: 'f2', primary: false, shift: false, alt: false }],
      'history.redo': [{ key: 'f2', primary: false, shift: false, alt: false }] });
    expect(markup.match(new RegExp(`>${t('settings.shortcuts.conflictBadge')}</td>`, 'gu'))).toHaveLength(2);
    expect(markup).toContain(t('settings.shortcuts.count').replace('{total}', String(COMMAND_DEFINITIONS.length))
      .replace('{shown}', String(COMMAND_DEFINITIONS.length)).replace('{conflicts}', '2'));
    expect(markup).toContain('role="alert"');
  });
});
