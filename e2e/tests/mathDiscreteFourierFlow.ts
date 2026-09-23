import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathDiscreteFourierFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('離散変換の成分'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  // Each editor owns a separate exact runtime; every result may include its first load.
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('im(component(fft([1,2,3,4]),2))');
  await expectResult(result).toHaveText('= 2'); await expect(apply).toBeEnabled();
  for (const source of ['fft([1,2,3])', 'component(dft([1,1/0]),1)', '0*re(component(dft([1,1/0]),1))']) {
    await input.fill(source);
    await expectResult(result).toHaveText('式の成立条件または計算結果を確認してください。');
    await expect(apply).toBeDisabled();
  }
  await input.fill('dft([1,2,3,4])'); await expectResult(result).toContainText('ベクトル'); await expect(apply).toBeDisabled();
  await input.fill('component(dft([1,2,3,4]),2)'); await expectResult(result).toContainText('複素数'); await expect(apply).toBeDisabled();
  for (const [source, expected] of [['im(component(dft([1,2,3,4]),2))', '= 2'],
    ['component(ifft(fft([1,2,3,4])),3)', '= 3'], ['component(idft(dft([1,0,0])),1)', '= 1']] as const) {
    await input.fill(source); await expectResult(result).toHaveText(expected); await expect(apply).toBeEnabled();
  }
  const source = 'im(component(fft([1,2,3,4]),2))', changed = 'im(component(ifft([1,2,3,4]),2))';
  await input.fill(source); await expectResult(result).toHaveText('= 2');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-discrete-fourier', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 2, angleUnit: 'degree' } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("離散変換の成分")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'discrete-fourier.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '離散変換の成分')?.value).toMatchObject({ source, mathDefinition: { source }, value: 2 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(2);
  await reopenPart(page, info, 'discrete-fourier.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('数値の並びを離散フーリエ変換する');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= -0.5'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'discrete-fourier-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(-0.5);
  expect(edited.parameters.find(parameter => parameter.name === '離散変換の成分')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'discrete-fourier-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(2);
  expect(undone.parameters.find(parameter => parameter.name === '離散変換の成分')?.value.source).toBe(source);
}
