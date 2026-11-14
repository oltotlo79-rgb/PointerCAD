import { describe, expect, it, vi } from 'vitest';
import { settingsCloseRequest, submitSettingsDrafts } from './settingsDrafts.js';

/*
 * 設定の窓の下書き(報告の指摘 7、統括の決定 2)。適用していない変更を持つ form は印(data-settings-draft="true")を
 * 付け、その印が 1 つでもある間は、窓の外を押す・Esc・歯車で閉じずに、窓の中で確かめる。
 * DOM の代わりに、印の問い合わせだけを持つ小さな偽物で確かめる。
 */
function panel(drafts: number) {
  const forms = Array.from({ length: drafts }, () => ({ requestSubmit: vi.fn() }));
  const queries: string[] = [];
  return {
    forms, queries,
    querySelector: (selector: string) => { queries.push(selector); return drafts > 0 ? forms[0] : null; },
    querySelectorAll: (selector: string) => { queries.push(selector); return forms; },
  };
}

describe('設定の窓を閉じる求め', () => {
  it('下書きが無ければそのまま閉じる', () => {
    expect(settingsCloseRequest(panel(0))).toBe('close');
    expect(settingsCloseRequest(null)).toBe('close');
  });

  it('下書きの印のある form が 1 つでもあれば閉じずに確かめる', () => {
    const scope = panel(1);
    expect(settingsCloseRequest(scope)).toBe('confirm');
    expect(scope.queries).toEqual(['form[data-settings-draft="true"]']);
  });

  it('「適用して閉じる」は下書きのある form だけを送り、その数を返す', () => {
    const scope = panel(2);
    expect(submitSettingsDrafts(scope)).toBe(2);
    for (const form of scope.forms) expect(form.requestSubmit).toHaveBeenCalledOnce();
    expect(scope.queries).toEqual(['form[data-settings-draft="true"]']);
    expect(submitSettingsDrafts(panel(0))).toBe(0);
  });
});
