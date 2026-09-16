import { describe, expect, it, vi } from 'vitest';

// Settings must be readable before the application store exists. This fails on a runtime import cycle.
vi.mock('../store/useAppStore.js', () => { throw new Error('Command metadata must not initialize the application store'); });

describe('操作の定義を読み取るだけではアプリの状態を初期化しない', () => {
  it('現在のメニューの全項目を、名前・説明を保持して設定用に読める', async () => {
    const { TOOLBAR_COMMAND_CATALOG } = await import('./toolbarCommandCatalog.js');
    expect(TOOLBAR_COMMAND_CATALOG.length).toBeGreaterThan(100);
    expect(new Set(TOOLBAR_COMMAND_CATALOG.map(item => item.id)).size).toBe(TOOLBAR_COMMAND_CATALOG.length);
    expect(TOOLBAR_COMMAND_CATALOG.every(item => item.labelKey.length > 0 && item.tooltipKey.length > 0)).toBe(true);
    const { COMMAND_DEFINITIONS } = await import('./commandDefinitions.js');
    const { validateShortcutAssignments } = await import('./shortcutAssignments.js');
    expect(COMMAND_DEFINITIONS.length).toBeGreaterThan(TOOLBAR_COMMAND_CATALOG.length);
    expect(validateShortcutAssignments({ 'toolbar.drawing.note': { key: 'f2', primary: false, shift: false, alt: false } }).ok).toBe(true);
  });
});
