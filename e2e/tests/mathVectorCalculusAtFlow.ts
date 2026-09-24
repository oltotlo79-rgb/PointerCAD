import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

export async function mathVectorCalculusAtFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('勾配の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const angle = dialog.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
  for (const source of ['component(gradientat(x/x,[x],[0]),1)',
    'component(jacobianat([x,y/y],[x,y],[2,0]),1,1)', '0*component(jacobianat([x,y/y],[x,y],[2,0]),1,1)']) {
    await input.fill(source);
    await expect(result).toHaveText('式の成立条件または計算結果を確認してください。', { timeout: 225_000 });
    await expect(apply).toBeDisabled();
  }
  await input.fill('component(gradientat(sin(x),[x],[0]),1)');
  await expect.poll(async () => {
    const text = await result.innerText(); return /^= /u.test(text) ? Number(text.slice(2)) : NaN;
  }, { timeout: 225_000 }).toBeCloseTo(Math.PI / 180, 12);
  await angle.selectOption('radian'); await expect(result).toHaveText('= 1', { timeout: 225_000 });
  await angle.selectOption('degree');
  // Wait for the degree result first: typing or switching notation while it runs cancels it, and a cancelled
  // calculation part is replaced and prepares the exact runtime again (rules/06 §10.149).
  await expect.poll(async () => {
    const text = await result.innerText(); return /^= /u.test(text) ? Number(text.slice(2)) : NaN;
  }, { timeout: 225_000 }).toBeCloseTo(Math.PI / 180, 12);
  for (const [source, value] of [
    ['component(gradientat(x^2*y,[x,y],[2,3]),1)', 12],
    ['divergenceat([x*y,x^2],[x,y],[2,3])', 3],
    ['component(curlat([-y,x,0],[x,y,z],[2,3,4]),3)', 2],
    ['laplacianat(x^2*y,[x,y],[2,3])', 6],
    ['component(jacobianat([x*y,x^2],[x,y],[2,3]),2,1)', 4],
    ['component(hessianat(x^2*y,[x,y],[2,5]),1,1)', 10],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(`= ${value}`, { timeout: 225_000 });
  }
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= 10', { timeout: 225_000 });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  const source = 'component(gradientat(x^2*y,[x,y],[2,3]),1)';
  const changedSource = 'component(gradientat(x^2*y,[x,y],[3,3]),1)';
  await input.fill(source); await expect(result).toHaveText('= 12', { timeout: 225_000 });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-vector-calculus-at', dialog,
    script: new URL(import.meta.url), fixture: { source, expected: 12, variables: ['x', 'y'], point: [2, 3], component: 1 } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("勾配の値")';
  const ySource = 'component(hessianat(x^2*y,[x,y],[2,3]),1,2)';
  for (const [axis, expression, expected] of [[0, coordinate, '12'], [1, ySource, '4']] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog); await input.fill(expression);
    await expect(result).toHaveText(`= ${expected}`, { timeout: 225_000 });
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'vector-calculus-at.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '勾配の値')?.value).toMatchObject({
    value: 12, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('指定位置の勾配から作った点がありません。');
  expect(point.at.x).toMatchObject({ value: 12, source: coordinate });
  expect(point.at.y).toMatchObject({ value: 4, source: ySource });
  await reopenPart(page, info, 'vector-calculus-at.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 12', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('指定した位置の勾配や行列を座標に使う');
  await page.keyboard.press('Escape');
  await input.fill(changedSource); await expect(result).toHaveText('= 18', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'vector-calculus-at-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 18, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'vector-calculus-at-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '勾配の値')?.value).toMatchObject({ value: 12, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 12, source: coordinate } } });
  console.log('[確認] Undo後の保存内容を照合: 勾配の値=12（元の原式）、点のX=12（係数の参照）');
}
