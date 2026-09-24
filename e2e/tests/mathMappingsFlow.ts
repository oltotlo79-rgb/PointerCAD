import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathMappingsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('逆写像の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('mapping(2*x+1,x,ℝ,ℝ)');
  await expectResult(result).toContainText('関数です'); await expect(apply).toBeDisabled();
  for (const invalid of [
    'mapping(x/x,x,ℝ,ℝ)',
    'inversemap(mapping(x^2,x,set(-1,1),set(1)))',
    'mapat(mapping(x,x,interval(open(0),1),ℝ),0)',
  ]) {
    await input.fill(invalid);
    await expectResult(result).toHaveClass(/pcad-math-editor__result--error/u);
    await expect(apply).toBeDisabled();
  }
  await input.fill('mapat(composemaps(mapping(x+1,x,ℝ,ℝ),mapping(2*x,x,ℝ,ℝ)),3)');
  await expectResult(result).toHaveText('= 7');
  const source = 'mapat(inversemap(mapping(2*x+1,x,ℝ,ℝ)),9)';
  const changed = 'mapat(inversemap(mapping(2*x+1,x,ℝ,ℝ)),13)';
  await input.fill(source); await expectResult(result).toHaveText('= 4');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-mappings', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 4, domain: 'real', codomain: 'real', angleUnit: 'degree' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 4');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("逆写像の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 4');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'mappings.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '逆写像の値')?.value).toMatchObject({ source, mathDefinition: { source }, value: 4 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(4);
  await reopenPart(page, info, 'mappings.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 4');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('写像・合成・逆写像');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 6'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'mappings-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(6);
  expect(edited.parameters.find(parameter => parameter.name === '逆写像の値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'mappings-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(4);
  expect(undone.parameters.find(parameter => parameter.name === '逆写像の値')?.value.source).toBe(source);
}
