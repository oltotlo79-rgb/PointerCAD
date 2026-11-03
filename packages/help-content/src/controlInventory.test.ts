import { describe, expect, it } from 'vitest';
import { buildNativeControlInventory, assertNativeControlDescriptions } from '../../../scripts/manual/control-inventory.mjs';

const inspect = (source: string) => buildNativeControlInventory([{ path: 'example.tsx', source }]);
describe('操作欄の説明漏れを実際の画面ソースから見つける', () => {
  it('名前・無関係な外枠・空の説明で不足を隠さない', () => {
    const inventory = inspect(`<div title="外枠"><input aria-label="長さ" /><button title="">保存</button>
      <textarea title={' '} /><select title={null} /></div>`);
    expect(inventory.missing.map(control => control.tag)).toEqual(['input', 'button', 'textarea', 'select']);
    expect(() => assertNativeControlDescriptions(inventory)).toThrow('example.tsx:');
  });
  it('同じ欄のラベルの説明を拾い、明示した空titleは上書きしない', () => {
    const inventory = inspect('<label title="距離をmmで指定します"><input /><input title="" /></label>');
    expect(inventory.controls[0].titleSource).toBe('label');
    expect(inventory.missing).toHaveLength(1);
  });
  it('確実に隠れた欄だけを除外し、動的な説明は実画面の確認を残す', () => {
    const inventory = inspect(`<><input type="hidden" /><input hidden /><input hidden={true} />
      <input hidden={false} /><input hidden={visible} /><select title={t('choice.hint')} {...props} /></>`);
    expect(inventory.missing).toHaveLength(2);
    expect(inventory.requiresRenderedCheck).toHaveLength(1);
    expect(inventory.contentCertified).toBe(false);
  });
  it('Windows の CRLF と配布 CI の LF の取り出しで同じ一覧を作る（説明書の照合が改行で落ちない）', () => {
    const lf = `<div>\n  <button title={ready\n    ? t('save.ready') : t('save.wait')}>保存</button>\n  <input title="長さ" />\n</div>`;
    const inventory = inspect(lf);
    expect(inspect(lf.replaceAll('\n', '\r\n'))).toEqual(inventory);
    expect(inventory.controls.map(control => control.line)).toEqual([2, 4]);
    expect(inventory.controls[0].sourceExpression).toContain('\n');
  });
  it('重複した読み元・壊れた画面・空の検査を拒否する', () => {
    expect(() => buildNativeControlInventory([{ path: 'x.tsx', source: '' }, { path: 'x.tsx', source: '' }])).toThrow('Duplicate');
    expect(() => inspect('<input')).toThrow('invalid JSX');
    expect(() => assertNativeControlDescriptions(inspect('export const value = 1;'))).toThrow('No native controls');
  });

});
