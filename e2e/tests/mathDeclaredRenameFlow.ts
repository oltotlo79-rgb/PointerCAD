import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { waitForMathEditorText } from './mathEditorReady.js';
import { readRecomputeStats } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';

export async function mathDeclaredRenameFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  const panel = page.getByRole('region', { name: '未解決の式', exact: true }), dialog = page.locator('.pcad-math-dialog');
  const input = dialog.locator('textarea'), apply = dialog.getByRole('button', { name: '式と条件を保存', exact: true });
  await panel.getByRole('button', { name: '未解決の式を追加', exact: true }).click();
  await waitForMathEditorText(dialog); await input.fill('sum(a_1,a_1,1,3)+a_1');
  await dialog.locator('.pcad-math-declarations summary').click();
  const add = dialog.getByRole('form', { name: '記号を定義', exact: true });
  await add.getByLabel('記号名', { exact: true }).fill('a_1');
  await add.getByLabel('記号の意味', { exact: true }).fill('未指定の長さ');
  await add.getByRole('button', { name: '記号を定義', exact: true }).click();
  await expect(apply).toBeEnabled(); await apply.click(); await expect(dialog).toHaveCount(0);
  const before = await savePart(page, info, 'rename-before.pcad', app);
  const open = async () => {
    await panel.getByRole('button', { name: '式と条件を編集', exact: true }).click();
    await waitForMathEditorText(dialog); await expect(apply).toBeEnabled();
    await dialog.locator('.pcad-math-declarations summary').click();
    await expect(dialog.locator('.pcad-math-declarations')).toHaveAttribute('open', '');
  };
  await open();
  const rename = (name: string) => dialog.getByRole('form', { name: `記号の名前を変更 ${name}`, exact: true });
  await rename('a_1').getByLabel('新しい記号名', { exact: true }).fill('pi');
  await rename('a_1').getByRole('button', { name: '記号の名前を変更', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('元の式を保持');
  await expect(input).toHaveValue('sum(a_1,a_1,1,3)+a_1');
  await rename('a_1').getByLabel('新しい記号名', { exact: true }).fill('b_2');
  await rename('a_1').getByRole('button', { name: '記号の名前を変更', exact: true }).click();
  await expect(input).toHaveValue(/b_2/u); await expect(input).toHaveValue(/a_1/u); await expect(apply).toBeEnabled();
  await expect(dialog.getByRole('form', { name: '記号の定義を編集 b_2', exact: true })
    .getByLabel('記号名', { exact: true })).toHaveValue('b_2');
  await expect(dialog.getByRole('form', { name: '記号の定義を編集 b_2', exact: true })
    .getByLabel('記号の意味', { exact: true })).toHaveValue('未指定の長さ');
  await captureManualDetail(page, info, { name: 'math-declared-symbol-rename', dialog, script: new URL(import.meta.url),
    fixture: { before: 'sum(a_1,a_1,1,3)+a_1', afterFreeSymbol: 'b_2', unchangedBoundSymbol: 'a_1' } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const after = await savePart(page, info, 'rename-after.pcad', app);
  expect(after.unresolvedMathProblems?.[0].definition.declarations).toEqual(
    before.unresolvedMathProblems?.[0].definition.declarations?.map(value => ({ ...value, label: 'b_2' })));
  expect(after.parameters).toEqual(before.parameters); expect(after.sketches).toEqual(before.sketches);
  // Stored unresolved expressions do not change a shape. Observe the restored
  // expression and saved document, and reject an unnecessary geometry request.
  const beforeUndo = await readRecomputeStats(page);
  expect(beforeUndo.isComputing).toBe(false);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(panel).toContainText('sum(a_1,a_1,1,3)+a_1');
  expect((await savePart(page, info, 'rename-undone.pcad', app)).unresolvedMathProblems).toEqual(before.unresolvedMathProblems);
  expect(await readRecomputeStats(page)).toEqual(beforeUndo);
  await reopenPart(page, info, 'rename-after.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click(); await open();
  await expect(input).toHaveValue(/b_2/u); await expect(input).toHaveValue(/a_1/u);
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('記号の名前を変更する');
  await page.keyboard.press('Escape');
  await rename('b_2').getByLabel('新しい記号名', { exact: true }).fill('c_3');
  await rename('b_2').getByRole('button', { name: '記号の名前を変更', exact: true }).click();
  await expect(input).toHaveValue(/c_3/u); await expect(apply).toBeEnabled();
  await expect(dialog.getByRole('form', { name: '記号の定義を編集 c_3', exact: true })
    .getByLabel('記号名', { exact: true })).toHaveValue('c_3');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await savePart(page, info, 'rename-cancelled.pcad', app)).unresolvedMathProblems).toEqual(after.unresolvedMathProblems);
}
