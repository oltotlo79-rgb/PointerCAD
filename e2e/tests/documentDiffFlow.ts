import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { evaluateExpression, expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { createEmptyPartDocument, createPrimitiveFeature, type PrimitiveFeature } from '../../packages/model/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { openTarget } from './electronAppFlow.js';
import { savePart } from './scriptsFlow.js';
import { captureManualDetail } from './captureManualDetail.js';

async function selectFile(page: Page, button: Locator, path: string, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) { await openTarget(app, path); await button.click(); }
  else {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    await chooser.setFiles(path);
  }
}
function box(id: string, name: string, x = '20', z = 20): PrimitiveFeature {
  const value = evaluateExpression(x); if (!value.ok) throw new Error('比較用の寸法式が不正');
  return { ...createPrimitiveFeature(createEmptyPartDocument(), 'box'), id, name,
    shape: { kind: 'box', sizeX: value.value, sizeY: expressionValueFromNumber(20), sizeZ: expressionValueFromNumber(z) } };
}

export async function documentDiffFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '作る', '箱');
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  const baseline = await savePart(page, info, 'comparison-current-before.pcad', app);
  const generation = (await readRecomputeStats(page)).requestedGeneration;
  const empty = { ...createEmptyPartDocument(), name: '取付部品' };
  const before = { ...empty, solids: [box('base', '台座'), box('old', '旧補助箱')] };
  const after = { ...empty, solids: [box('base', '台座', '10+10', 30), box('new', '追加の補助箱')] };
  const beforePath = info.outputPath('比較前.pcad'), afterPath = info.outputPath('比較後.pcad'), brokenPath = info.outputPath('破損.pcad');
  const beforeBytes = writePcadFile(before), afterBytes = writePcadFile(after);
  await writeFile(beforePath, beforeBytes, { flag: 'wx' }); await writeFile(afterPath, afterBytes, { flag: 'wx' });
  await writeFile(brokenPath, 'not a part archive', { flag: 'wx' });
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '2つの保存ファイルを比較');
  const dialog = page.getByRole('dialog', { name: '2つの保存ファイルを比較', exact: true });
  const pickBefore = dialog.getByRole('button', { name: '変更前のファイルを選ぶ', exact: true });
  const pickAfter = dialog.getByRole('button', { name: '変更後のファイルを選ぶ', exact: true });
  const compare = dialog.getByRole('button', { name: '変更を比較する', exact: true });
  const relation = dialog.getByLabel('2つのファイルの関係', { exact: true });
  await expect(compare).toBeDisabled();
  await selectFile(page, pickBefore, beforePath, app); await expect(dialog.getByText('比較前.pcad', { exact: true })).toBeVisible();
  await selectFile(page, pickAfter, afterPath, app); await expect(dialog.getByText('比較後.pcad', { exact: true })).toBeVisible();
  await expect(relation).toHaveValue(''); await expect(compare).toBeDisabled();
  await relation.selectOption('versions'); await compare.click();
  const results = dialog.getByRole('region', { name: '比較結果', exact: true });
  await expect(results.getByRole('status')).toHaveText('追加 1件・削除 1件・変更 1件');
  await expect(results.locator('[data-diff-status="added"]')).toContainText('追加の補助箱');
  await expect(results.locator('[data-diff-status="removed"]')).toContainText('旧補助箱');
  const changed = results.locator('[data-diff-status="changed"]');
  await captureManualDetail(page, info, { name: 'document-definition-diff', dialog, script: new URL(import.meta.url),
    fixture: { kind: 'two-saved-part-definitions', before, after, relationship: 'versions' } });
  await changed.locator('summary').click();
  await expect(changed).toContainText('式変更（保存値は同じ）'); await expect(changed).toContainText('式と保存値の変更');
  await expect(changed).toContainText('10+10'); await expect(changed).toContainText('30');
  await captureManualDetail(page, info, { name: 'document-definition-fields', dialog: changed, script: new URL(import.meta.url),
    fixture: { kind: 'two-saved-part-definitions', before, after, relationship: 'versions' } });
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('2つの保存ファイルの変更を比較する');
  await page.keyboard.press('Escape'); await expect(results).toBeVisible();
  // 読めない候補と選択の取消では、前に選び終えた2ファイル・関係・結果を保持する。
  await selectFile(page, pickAfter, brokenPath, app); await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByText('比較後.pcad', { exact: true })).toBeVisible(); await expect(results.getByRole('status')).toHaveText('追加 1件・削除 1件・変更 1件');
  await expect(relation).toHaveValue('versions');
  if (app !== undefined) {
    await app.evaluate(({ dialog: nativeDialog }) => { nativeDialog.showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] }); });
    await pickAfter.click(); await expect(pickAfter).toBeEnabled();
    await expect(dialog.getByText('比較後.pcad', { exact: true })).toBeVisible();
    await expect(results.getByRole('status')).toHaveText('追加 1件・削除 1件・変更 1件');
  }
  await relation.selectOption('unrelated'); await compare.click();
  await expect(results.locator('[data-diff-status="added"]')).not.toHaveCount(0);
  await expect(results.locator('[data-diff-status="removed"]')).not.toHaveCount(0);
  await expect(results.locator('[data-diff-status="changed"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: '比較を閉じる', exact: true }).focus(); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
  expect(await savePart(page, info, 'comparison-current-after.pcad', app)).toEqual(baseline);
  expect(new Uint8Array(await readFile(beforePath))).toEqual(beforeBytes); expect(new Uint8Array(await readFile(afterPath))).toEqual(afterBytes);
  // 比較がUndoの履歴へ紛れず、直前に作った箱を一回で戻せる。
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true })).toHaveCount(0);
}
