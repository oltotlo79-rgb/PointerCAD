import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathNumericalRootFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('解の区間から選んだ値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('numericroots(x^2-2,x,-2,2,0.000001)');
  await expectResult(result.locator(':scope > p').first()).toHaveText('指定範囲の解を区間で確認しました。');
  const detail = result.locator(':scope > p').nth(1);
  await expectResult(detail).toContainText('候補 2:');
  const intervals = [...(await detail.innerText()).matchAll(/候補 (\d+): (\S+) ≤ x ≤ (\S+)/gu)];
  expect(intervals).toHaveLength(2);
  for (const [index, match] of intervals.entries()) {
    const lower = Number(match[2]), upper = Number(match[3]), root = (index === 0 ? -1 : 1) * Math.sqrt(2);
    expect(match[1]).toBe(String(index + 1)); expect(lower).toBeLessThan(root); expect(upper).toBeGreaterThan(root);
    expect(upper - lower).toBeLessThanOrEqual(0.000001);
  }
  await expect(detail).toContainText('上下限は解そのものの正確な値ではありません。');
  await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-numerical-roots', dialog, script: new URL(import.meta.url),
    fixture: { source: 'numericroots(x^2-2,x,-2,2,0.000001)', expectedRoots: ['-sqrt(2)', 'sqrt(2)'], angleUnit: 'degree' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await input.fill('numericroots(x^2+1,x,-1,1,0.000001)');
  await expectResult(result.locator(':scope > p').first()).toHaveText('指定した範囲に解はありません。');
  await expect(apply).toBeDisabled();
  await input.fill('numericroots(0,x,-1,1,0.000001)');
  await expectResult(result.locator(':scope > p').first()).toHaveText('判定できない範囲が残っています。解なしとは限りません。');
  await expect(detail).toContainText('範囲全体で0になる'); await expect(apply).toBeDisabled();
  for (const source of [
    'numericroots(x,x,-1,1,0)',
    'component(rootinterval(numericroots((x-1)/x,x,-2,2,0.000001),1),1)',
    'component(rootinterval(numericroots(x^2-2,x,-2,2,0.000001),3),1)',
  ]) {
    await input.fill(source); await expectResult(result).toHaveClass(/pcad-math-editor__result--error/u);
    await expect(apply).toBeDisabled();
  }
  const source = 'ceil(component(rootinterval(numericroots(x^2-2,x,0,3,0.000001),1),2))',
    changed = 'ceil(component(rootinterval(numericroots(x^2-5,x,0,3,0.000001),1),2))';
  await input.fill(source); await expectResult(result).toHaveText('= 2');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("解の区間から選んだ値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'numerical-roots.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '解の区間から選んだ値')?.value).toMatchObject({ source, mathDefinition: { source }, value: 2 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(2);
  await reopenPart(page, info, 'numerical-roots.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('数値で解を探し、区間を確認する');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 3'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'numerical-roots-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(3);
  expect(edited.parameters.find(parameter => parameter.name === '解の区間から選んだ値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'numerical-roots-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(2);
  expect(undone.parameters.find(parameter => parameter.name === '解の区間から選んだ値')?.value.source).toBe(source);
}
