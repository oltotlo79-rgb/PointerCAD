import { expect, test } from '@playwright/test';
import { partNameSearchFlow, assemblyNameSearchFlow } from './nameSearchFlow.js';

for (const [name, flow] of [['200要素の別スケッチ同名点', partNameSearchFlow], ['50部品の入れ子と非表示部品', assemblyNameSearchFlow]] as const) {
  test(`P12-15 名前検索から${name}の所属を開いて対象行へ移動し、取消でも文書を保つ`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); await flow(page, info); expect(errors).toEqual([]);
  });
}
