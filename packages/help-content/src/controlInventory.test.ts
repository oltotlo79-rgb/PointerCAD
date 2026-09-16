import { readFileSync, readdirSync } from 'node:fs';
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
  it('重複した読み元・壊れた画面・空の検査を拒否する', () => {
    expect(() => buildNativeControlInventory([{ path: 'x.tsx', source: '' }, { path: 'x.tsx', source: '' }])).toThrow('Duplicate');
    expect(() => inspect('<input')).toThrow('invalid JSX');
    expect(() => assertNativeControlDescriptions(inspect('export const value = 1;'))).toThrow('No native controls');
  });
  it('新しい画面も含む全ての通常欄から、説明を付け忘れた変更を検出する', () => {
    // Enumerate the actual source tree so a new component cannot be omitted from a manual allowlist.
    const root = new URL('../../ui/src/', import.meta.url), files: string[] = [];
    const collect = (folder: string): void => {
      for (const entry of readdirSync(new URL(folder, root), { withFileTypes: true })) {
        const path = folder + entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Unexpected source link: ${path}`);
        if (entry.isDirectory()) collect(path + '/');
        else if (entry.isFile() && path.endsWith('.tsx') && !path.endsWith('.test.tsx')) files.push(path);
      }
    };
    collect(''); files.sort();
    const inventory = buildNativeControlInventory(files.map(path => ({ path,
      source: readFileSync(new URL(`../../ui/src/${path}`, import.meta.url), 'utf8') })));
    expect(inventory.sources).toHaveLength(files.length);
    assertNativeControlDescriptions(inventory);
    expect(inventory.requiresRenderedCheck.length).toBeGreaterThan(0);
  });
});
