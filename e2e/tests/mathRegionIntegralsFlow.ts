import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

/** Area, oriented flux and volume retain source domains through real file operations. */
export async function mathRegionIntegralsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('面積分の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const angle = dialog.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
  await input.fill('surfaceintegral(1/z,[x,y,z],[u,v,0],[u,v],[0,0],[1,1])');
  await expect(result).toHaveText('式の成立条件または計算結果を確認してください。', { timeout: 225_000 });
  await expect(apply).toBeDisabled();
  await input.fill('surfaceintegral(1,[x,y,z],[u/u,v,0],[u,v],[0,0],[1,1])');
  await expect(result).toHaveText(uiMessage('math', 'math.unresolved'), { timeout: 225_000 });
  await expect(apply).toBeDisabled();
  for (const [source, value] of [
    ['surfaceintegral(1,[x,y,z],[2*u,3*v,0],[u,v],[1,0],[0,1])', 6],
    ['fluxintegral([0,0,4],[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1])', 24],
    ['fluxintegral([0,0,4],[x,y,z],[2*v,3*u,0],[u,v],[0,0],[1,1])', -24],
    ['volumeintegral(1,[x,y,z],[-2*u,3*v,4*w],[u,v,w],[0,0,0],[1,1,1])', 24],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(`= ${value}`, { timeout: 225_000 });
  }
  await input.fill('surfaceintegral(1,[x,y,z],[cos(u),sin(u),v],[u,v],[0,0],[360,2])');
  await expect(result).toHaveText(/^= 12\.5663706143/u, { timeout: 225_000 });
  await angle.selectOption('radian');
  await expect(result).toHaveText('= 720', { timeout: 225_000 });
  await angle.selectOption('degree');
  const source = 'surfaceintegral(1,[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1])';
  const changedSource = 'surfaceintegral(1,[x,y,z],[2*u,3*v,0],[u,v],[0,0],[2,1])';
  await input.fill(source); await expect(result).toHaveText('= 6', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= 6', { timeout: 225_000 });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-region-integrals', dialog,
    script: new URL(import.meta.url), fixture: { source, expected: 6, field: 1, mapping: ['2*u', '3*v', '0'], parameters: ['u', 'v'], lower: [0, 0], upper: [1, 1] } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("面積分の値")';
  const ySource = 'volumeintegral(1,[x,y,z],[-2*u,3*v,4*w],[u,v,w],[0,0,0],[1,1,1])';
  const zSource = 'fluxintegral([0,0,4],[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1])';
  for (const [axis, expression, expected] of [[0, coordinate, '6'], [1, ySource, '24'], [2, zSource, '24']] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog); await input.fill(expression);
    await expect(result).toHaveText(`= ${expected}`, { timeout: 225_000 });
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'region-integrals.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '面積分の値')?.value).toMatchObject({
    value: 6, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('面積分から作った点がありません。');
  expect(point.at.x).toMatchObject({ value: 6, source: coordinate });
  expect(point.at.y).toMatchObject({ value: 24, source: ySource });
  expect(point.at.z).toMatchObject({ value: 24, source: zSource });
  await reopenPart(page, info, 'region-integrals.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 6', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('面や体積に沿って量を積分する');
  await page.keyboard.press('Escape');
  await input.fill(changedSource); await expect(result).toHaveText('= 12', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'region-integrals-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 12, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'region-integrals-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '面積分の値')?.value).toMatchObject({ value: 6, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 6, source: coordinate } } });
}
