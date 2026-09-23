import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Real Airy values and slopes, original source and document edits. */
export async function mathAiryFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('Airyの値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const [source, reason] of [
    ['airyai(1/0)', '0では割れません。'],
    ['airybi([1])', 'Airy関数の引数は一つの実数の式で指定してください。'],
    ['0*airyai(i)', 'Airy関数の複素引数の数値計算にはまだ対応していません。'],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(reason, { timeout: 15_000 });
    await expect(apply).toBeDisabled();
  }
  for (const [formula, value] of [['airyai(1)', '0.135292416'], ['airybi(1)', '1.207423594'],
    ['airyaiprime(1)', '-0.159147441'], ['airybiprime(1)', '0.932435933'], ['airyai(0)', '0.355028053']] as const) {
    await input.fill(formula); await expect(result).toContainText(value); await expect(apply).toBeEnabled();
  }
  await input.fill('derivativeat(airyai(x),x,0,2)');
  await expect(result).toContainText('= 0', { timeout: 225_000 }); await expect(apply).toBeEnabled();
  const source = 'airyai(1)', changed = 'airybi(1)';
  const initialValue = Number('0.13529241631288141'), changedValue = Number('1.2074235949528713');
  await input.fill(source); await expect(result).toContainText('0.135292416');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '関数' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('Airy');
  await expect(dialog.getByRole('button', { name: 'Airy Ai（Airy関数）', exact: true })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toContainText('0.135292416');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-airy', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: initialValue, arguments: [1] } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("Airyの値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expect(result).toContainText('0.135292416');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'airy.pcad', app);
  const parameter = saved.parameters.find(parameter => parameter.name === 'Airyの値');
  expect(parameter?.value).toMatchObject({ source, mathDefinition: { source } });
  expect(parameter?.value.value).toBeCloseTo(initialValue, 14);
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBeCloseTo(initialValue, 14);
  await reopenPart(page, info, 'airy.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expect(result).toContainText('0.135292416');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('Airy関数の値と傾きを求める');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expect(result).toContainText('1.207423594'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'airy-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBeCloseTo(changedValue, 14);
  expect(edited.parameters.find(parameter => parameter.name === 'Airyの値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'airy-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBeCloseTo(initialValue, 14);
  expect(undone.parameters.find(parameter => parameter.name === 'Airyの値')?.value.source).toBe(source);
}
