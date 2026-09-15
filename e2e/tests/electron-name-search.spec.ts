import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { partNameSearchFlow, assemblyNameSearchFlow } from './nameSearchFlow.js';

for (const [name, flow] of [['200要素の別スケッチ同名点', partNameSearchFlow], ['50部品の入れ子と非表示部品', assemblyNameSearchFlow]] as const) {
  test(`P12-15 実Electronの名前検索から${name}の階層と対象行を示す`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await flow(page, info, app); expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}
