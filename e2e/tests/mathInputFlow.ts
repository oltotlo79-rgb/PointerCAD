import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { openTarget } from './electronAppFlow.js';
import { uiMessage } from './uiMessages.js';
import { focusField } from './mathEditorReady.js';
import { mathCoordinateFlow } from './mathCoordinateFlow.js';
import { mathStatisticsFlow } from './mathStatisticsFlow.js';

/** Shared real MathLive + calculation Worker + file persistence flow in Chromium, Firefox, and Electron. */
export async function mathInputFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await expect(page.getByRole('tab', { name: 'パラメータ', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  const row = (index: number) => page.locator('.pcad-parameter').nth(index);
  const name = (index: number) => row(index).locator('.pcad-field').nth(0).locator('input');
  const source = (index: number) => row(index).locator('.pcad-field').nth(1).locator('input');
  const result = (index: number) => row(index).locator('.pcad-field').nth(1).locator('.pcad-field__message');
  const add = () => page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  await add(); await name(0).fill('幅'); await name(0).press('Enter');
  await expect(name(0)).toHaveValue('幅'); await source(0).fill('3'); await source(0).press('Enter');
  await expect(result(0)).toHaveText('= 3'); await add(); await name(1).fill('計算値'); await name(1).press('Enter');
  await row(1).getByRole('button', { name: '数式で入力', exact: true }).click();
  const dialog = page.locator('.pcad-math-dialog');
  await expect(dialog.locator('textarea')).toBeVisible();
  await dialog.locator('textarea').fill('coef("幅")*2+sin(30)');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('係数と数学記号を区別する');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcad-help')).toHaveCount(0);
  await expect(dialog.locator('textarea')).toHaveValue('coef("幅")*2+sin(30)');
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, Symbol.for('io.cortexjs.compute-engine')) === undefined)).toBe(true);
  expect(await dialog.locator('math-field').evaluate(field => Reflect.get(field.constructor, 'computeEngine') === null)).toBe(true);
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
  await page.screenshot({ path: info.outputPath('math-coefficients.png'), fullPage: true });
  await dialog.getByRole('button', { name: '数式入力のヘルプ', exact: true }).click();
  await expect(page.locator('.pcad-help__article')).toContainText('係数と数学記号を区別する');
  await page.locator('.pcad-help').getByRole('button', { name: uiMessage('help', 'help.close'), exact: true }).click();
  // OPS-11b: math-fieldへの直接の.press()はMathLiveの焦点処理と競合するため、focusFieldで焦点の
  // 処理が終わるのを待ってからキーを送る(rules/06 §10.329、mathEditorReady.ts)。
  await focusField(dialog.locator('math-field'));
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0); await expect(result(1)).toHaveText('= 6.5');
  const adopted = await savePart(page, info, 'math-adopted.pcad', app);
  expect(adopted.parameters[1].value.mathDefinition).toMatchObject({ inputNotation: 'latex', angleUnit: 'degree' });
  expect(adopted.parameters.every(parameter => parameter.mathId !== undefined)).toBe(true);
  expect(adopted.parameters[1].value.value).toBe(6.5);
  await source(0).fill('4'); await source(0).press('Enter');
  await expect(result(1)).toHaveText('= 8.5');
  await name(0).fill('板幅'); await name(0).press('Enter');
  await expect(source(1)).toHaveValue(/板幅/u);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(name(0)).toHaveValue('幅'); await expect(result(1)).toHaveText('= 8.5');
  const saved = await savePart(page, info, 'math-reopen.pcad', app);
  await row(1).getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeVisible();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(dialog.locator('textarea')).toBeVisible(); await dialog.locator('textarea').fill('999');
  await dialog.locator('textarea').press('Escape');
  await expect(dialog).toHaveCount(0); await expect(result(1)).toHaveText('= 8.5');
  expect(await savePart(page, info, 'math-cancelled.pcad', app)).toEqual(saved);
  await page.reload();
  if (app !== undefined) {
    await openTarget(app, info.outputPath('math-reopen.pcad'));
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
  } else {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
    await (await chooser).setFiles(info.outputPath('math-reopen.pcad'));
  }
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await expect(result(1)).toHaveText('= 8.5');
  await row(1).getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await mathCoordinateFlow(page, info, app);
  await mathStatisticsFlow(page, info, app);
}
