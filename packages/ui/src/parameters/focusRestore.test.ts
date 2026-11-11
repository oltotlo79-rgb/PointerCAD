import { describe, expect, it, vi, type Mock } from 'vitest';

import { focusByAriaLabel } from './focusRestore.js';

function element(label: string | null): { getAttribute: (name: string) => string | null; focus: Mock<() => void> } {
  return { getAttribute: (name: string) => (name === 'aria-label' ? label : null), focus: vi.fn<() => void>() };
}

describe('focusByAriaLabel', () => {
  it('moves focus to the field whose aria-label matches (renamed row, configuration select)', () => {
    const search = element('名前・説明を検索'), renamed = element('名前 基準寸法A'), select = element('構成');
    const root = { querySelectorAll: () => [search, renamed, select] };
    expect(focusByAriaLabel(root, '名前 基準寸法A')).toBe(true);
    expect(renamed.focus).toHaveBeenCalledTimes(1);
    expect(search.focus).not.toHaveBeenCalled();
    expect(select.focus).not.toHaveBeenCalled();
    expect(focusByAriaLabel(root, '構成')).toBe(true);
    expect(select.focus).toHaveBeenCalledTimes(1);
  });

  it('returns false and focuses nothing while the field is not rendered yet', () => {
    const other = element('構成の名前');
    expect(focusByAriaLabel({ querySelectorAll: () => [other] }, '構成')).toBe(false);
    expect(focusByAriaLabel(null, '構成')).toBe(false);
    expect(focusByAriaLabel(undefined, '構成')).toBe(false);
    expect(other.focus).not.toHaveBeenCalled();
  });
});
