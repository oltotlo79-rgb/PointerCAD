import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathFourierSeriesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('フーリエ部分和の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('fourierseries(x,x,-pi,pi,2)');
  // The status contains a heading paragraph and a separate explanation paragraph.
  // Check both full strings, rather than comparing their joined text with the heading.
  await expectResult(result.locator(':scope > p')).toHaveText([
    'フーリエ部分和（最高次数） N=2',
    '周期区間: [-1 * pi, pi]。定数項 a0/2: 0。a[1..N]=[0, 0]、b[1..N]=[2, -1]。'
      + '周期Pは上端−下端。部分和はa0/2＋Σ{a[n] cos(2πnx/P)＋b[n] sin(2πnx/P)}で、基底の角度はラジアンです。xは指定した変数を表します。 '
      + '無限級数は連続点で元の関数、不連続点で周期延長の左右極限の平均へ収束します。 周期の両端での収束先: 0。 '
      + '元の関数と部分和の誤差は保証しません。係数はfouriercos／fouriersin、部分和の値はfourieratで明示して選びます。',
  ]);
  await expect(dialog).toContainText('a[1..N]=[0, 0]、b[1..N]=[2, -1]');
  await expect(dialog).toContainText('周期の両端での収束先: 0。');
  await expect(dialog).toContainText('元の関数と部分和の誤差は保証しません。');
  await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-fourier-series', dialog, script: new URL(import.meta.url),
    fixture: { source: 'fourierseries(x,x,-pi,pi,2)', highestHarmonic: 2,
      expectedCosine: [0, 0], expectedSine: [2, -1], expectedEndpointMean: 0, angleUnit: 'degree' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const source of ['fourierseries(x,x,1,1,2)', 'fouriercos(fourierseries(x,x,-pi,pi,1),2)']) {
    await input.fill(source);
    await expectResult(result).toHaveText('式の成立条件または計算結果を確認してください。');
    await expect(apply).toBeDisabled();
  }
  await input.fill('0*fourierat(fourierseries(1/x,x,-1,1,1),1)');
  await expectResult(result).toHaveText('この計算は収束しません。有限の数値として座標には使えません。');
  await expect(apply).toBeDisabled();
  for (const [source, expected] of [
    ['fouriercos(fourierseries(3,x,-pi,pi,0),0)', '= 6'],
    ['fouriersin(fourierseries(x,x,-pi,pi,2),2)', '= -1'],
    ['fourierat(fourierseries(sin(x),x,-180,180,1),90)', '= 1'],
  ] as const) {
    await input.fill(source); await expectResult(result).toHaveText(expected); await expect(apply).toBeEnabled();
  }
  const source = 'fourierat(fourierseries(x,x,-pi,pi,2),pi/2)', changed = 'fourierat(fourierseries(2*x,x,-pi,pi,2),pi/2)';
  await input.fill(source); await expectResult(result).toHaveText('= 2');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  // Let the structured evaluation (about 4 s) finish: switching back while it runs cancels it, the cancelled
  // calculation part is replaced (rules/06 §10.149), and Firefox prepared the exact runtime a seventh time
  // (77.0 s, RUN 20260924-180749) against this flow's budget of six. The switch clears the result first.
  await expectResult(result).toHaveText('= 2');
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("フーリエ部分和の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'fourier-series.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === 'フーリエ部分和の値')?.value).toMatchObject({ source, mathDefinition: { source }, value: 2 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(2);
  await reopenPart(page, info, 'fourier-series.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('フーリエ級数の係数と部分和を使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 4'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'fourier-series-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(4);
  expect(edited.parameters.find(parameter => parameter.name === 'フーリエ部分和の値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'fourier-series-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(2);
  expect(undone.parameters.find(parameter => parameter.name === 'フーリエ部分和の値')?.value.source).toBe(source);
}
