import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Local index, ordered seeds, source notation and edits survive the document flow. */
export async function mathSequenceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('数列の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  // Notation changes and document reopen can prepare a new exact engine too.
  const expectResult = expect.configure({ timeout: 225_000 });
  for (const source of ['sequencevalue(n/n,n,0)', 'recurrencevalue(1/(n-1),[n,a],0,[0],3)',
    'differenceat(n,n,0,1,0)', 'product(sequencevalue(n/(n-2),n,k),k,0,3)']) {
    await input.fill(source); await expectResult(result).toContainText('式の成立条件または計算結果'); await expect(apply).toBeDisabled();
  }
  for (const [formula, value] of [['sequencevalue(n^2,n,5)', '25'], ['differenceat(n^3,n,3,3,2)', '48'],
    ['recurrencevalue(a+b,[n,a,b],0,[0,1],10)', '55'], ['sequencevalue(n!,n,5)', '120'],
    ['differenceat(floor(n/2),n,3,1,1)', '1'], ['product(sequencevalue(n+1,n,k),k,1,4)', '120'],
    ['recurrencevalue(a*a,[n,a],0,[2],3)', '256'], ['recurrencevalue(a+n,[n,a],-2,[10],1)', '7']] as const) {
    await input.fill(formula); await expectResult(result).toHaveText('= ' + value);
  }
  const source = 'sum(recurrencevalue(a+b,[n,a,b],0,[0,1],k),k,0,10)',
    changed = 'sum(recurrencevalue(a+b,[n,a,b],0,[1,1],k),k,0,10)';
  await input.fill(source); await expectResult(result).toHaveText('= 143');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '数列・総和・総積' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('漸化式の指定項');
  await expect(dialog.getByRole('button', { name: /漸化式の指定項/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 143');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-sequence-sum', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 143, initial: [0, 1], index: 10 } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("数列の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 143');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'sequence-sum.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '数列の値')?.value).toMatchObject({ value: 143, source, mathDefinition: { source } });
  expect(saved.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 143, source: coordinate } } });
  await reopenPart(page, info, 'sequence-sum.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 143');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('数列の値・差分・漸化式');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 232'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'sequence-sum-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 232, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'sequence-sum-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '数列の値')?.value).toMatchObject({ value: 143, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 143, source: coordinate } } });
}
