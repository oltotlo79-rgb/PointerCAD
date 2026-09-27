import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathDeclaredValuesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('記号の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  await input.fill('a_1*3'); await dialog.locator('.pcad-math-declarations summary').click();
  const add = dialog.getByRole('form', { name: '記号を定義', exact: true });
  await add.getByLabel('記号名', { exact: true }).fill('a_1');
  await add.getByLabel('記号の意味', { exact: true }).fill('分数の長さ');
  await add.getByRole('combobox', { name: '記号の種類', exact: true }).selectOption('rational');
  await add.getByLabel('値の式（省略可）', { exact: true }).fill('1/3');
  await add.getByRole('button', { name: '記号を定義', exact: true }).click();
  await expect(result).toHaveText('= 1');
  const edit = dialog.getByRole('form', { name: '記号の定義を編集 a_1', exact: true });
  const update = async (type: string, source: string) => {
    await edit.getByRole('combobox', { name: '記号の種類', exact: true }).selectOption(type);
    await edit.getByLabel('値の式（省略可）', { exact: true }).fill(source);
    await edit.getByRole('button', { name: '定義を更新', exact: true }).click();
  };
  await update('integer', '1/3');
  await expect(result).toHaveClass(/pcad-math-editor__result--error/u); await expect(apply).toBeDisabled();
  await update('rational', '1/0');
  await expect(result).toHaveClass(/pcad-math-editor__result--error/u); await expect(apply).toBeDisabled();
  await update('rational', '1/3'); await expect(result).toHaveText('= 1');
  await captureManualDetail(page, info, { name: 'math-declared-values', dialog, script: new URL(import.meta.url),
    fixture: { source: 'a_1*3', declaration: { label: 'a_1', type: 'rational', valueSource: '1/3' }, expected: 1 } });
  await dialog.locator('.pcad-math-declarations summary').click();
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused(); await expect(result).toHaveText('= 1');
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(result).toHaveText('= 1'); await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover');
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill('coef("記号の値")');
  await expect(result).toHaveText('= 1'); await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'declared-values.pcad', app);
  const declaration = saved.parameters.find(value => value.name === '記号の値')?.value.mathDefinition?.declarations?.[0];
  expect(declaration).toMatchObject({ label: 'a_1', meaning: '分数の長さ', type: 'rational', valueSource: '1/3' });
  const pointValue = (document: typeof saved) => {
    const point = document.sketches[0].features.find(value => value.kind === 'point');
    if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
    return point.at.x.value;
  };
  expect(pointValue(saved)).toBe(1);
  await reopenPart(page, info, 'declared-values.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(result).toHaveText('= 1');
  await dialog.locator('.pcad-math-declarations summary').click();
  await expect(edit.getByLabel('値の式（省略可）', { exact: true })).toHaveValue('1/3');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('記号に値を指定する');
  await page.keyboard.press('Escape');
  await update('rational', '2/3'); await expect(result).toHaveText('= 2'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'declared-values-edited.pcad', app);
  expect(pointValue(edited)).toBe(2);
  expect(edited.parameters.find(value => value.name === '記号の値')?.value.mathDefinition?.declarations?.[0])
    .toEqual({ ...declaration, valueSource: '2/3' });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'declared-values-undone.pcad', app);
  expect(pointValue(undone)).toBe(1);
  expect(undone.parameters.find(value => value.name === '記号の値')?.value.mathDefinition?.declarations?.[0]).toEqual(declaration);
}
