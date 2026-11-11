import { expect, test } from '@playwright/test';
import { boltPreloadFlow } from './boltPreloadFlow.js';
import { disableFilePickers } from './boltedJointTestSupport.js';

test('ボルト締付け: 現在への明示関連付け・別同意・実native・取消・入力保存1Undo', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await disableFilePickers(page); await page.goto('/'); await boltPreloadFlow(page, info); expect(errors).toEqual([]);
});
