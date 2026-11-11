import { expect, test } from '@playwright/test';
import { namedSavePointCapacityFlow } from './namedSavePointCapacityFlow.js';
import { namedSavePointsAssemblyFlow, namedSavePointsDrawingFlow, namedSavePointsPartFlow, runNamedSavePointsWebCold } from './namedSavePointsFlow.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
});

test('R16 部品の名前付き保存点を作り、複製・比較・復元し、復元のUndo1回と端末の保存先での保持を通す', async ({ playwright, browserName }, info) => {
  const errors = await runNamedSavePointsWebCold(playwright[browserName], info, 'part', page => namedSavePointsPartFlow(page)); expect(errors).toEqual([]);
});

test('R16 組立の名前付き保存点を作り、複製・比較・復元を通す', async ({ playwright, browserName }, info) => {
  const errors = await runNamedSavePointsWebCold(playwright[browserName], info, 'assembly', page => namedSavePointsAssemblyFlow(page)); expect(errors).toEqual([]);
});

test('R16 図面の名前付き保存点を作り、別の種類の保存点は戻せず、複製・比較・復元を通す', async ({ playwright, browserName }, info) => {
  const errors = await runNamedSavePointsWebCold(playwright[browserName], info, 'drawing', page => namedSavePointsDrawingFlow(page)); expect(errors).toEqual([]);
});

test('R16 実100保存点から101件目の作成と複製を拒否し、既存全byteを自動削除せず保持する', async ({ page }, info) => {
  await page.goto('/');
  const { namedSavePointsCountLimitFlow } = await import('./namedSavePointsFlow.js');
  await namedSavePointsCountLimitFlow(page, info);
});

test('R16 非空2コンポーネント同1部品参照の実PNG共有保存点を別processで復元し全文書添付とUndo1回を保持する', async ({ playwright, browserName }, info) => {
  const { runNamedSavePointsSharedWebCold } = await import('./namedSavePointsFlow.js');
  expect(await runNamedSavePointsSharedWebCold(playwright[browserName], info)).toEqual([]);
});

test('R16 実一意blob512MiB超過の作成を拒否し、既存全byteと全文書添付Undoを保持し複製は追加実体0で成功する', async ({ page }, info) => {
  await page.goto('/');
  await namedSavePointCapacityFlow(page, info);
});
