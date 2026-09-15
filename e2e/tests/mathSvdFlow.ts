import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { uiMessage } from './uiMessages.js';
import { captureManualDetail } from './captureManualDetail.js';

export async function mathSvdFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('分解した行列の成分'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  const input = dialog.locator('textarea'), apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  await input.fill('svdu([[3,0],[4,0]])');
  const picker = dialog.getByRole('group', { name: uiMessage('math','math.component.title'), exact: true });
  await expect(picker).toBeVisible(); await expect(apply).toBeDisabled();
  await picker.getByRole('spinbutton', { name: `${uiMessage('math','math.component.axis')} 1`, exact: true }).fill('1');
  await picker.getByRole('spinbutton', { name: `${uiMessage('math','math.component.axis')} 2`, exact: true }).fill('1');
  await picker.getByRole('button', { name: uiMessage('math','math.component.choose'), exact: true }).click();
  const source = 'tensorelement(svdu([[3,0],[4,0]]),[1,1])';
  await expect(input).toHaveValue(source); await expect(dialog.locator('[role="status"]')).toHaveText('= 0.6');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('特異値分解の3つの行列を使う');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('math-svd-selected-component.png'), fullPage: true });
  await captureManualDetail(page, info, {
    name: 'math-svd-selected-component', dialog, script: new URL(import.meta.url),
    fixture: { kind: 'mathematics-input-example', parameter: '分解した行列の成分',
      source: await input.inputValue(), result: await dialog.locator('[role="status"]').innerText() },
  });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const saved = await savePart(page,info,'math-svd.pcad',app);
  expect(saved.parameters.find(parameter => parameter.name === '分解した行列の成分')?.value).toMatchObject({ value: 0.6, source });
  await reopenPart(page,info,'math-svd.pcad',app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(input).toHaveValue(source);
  const edited = 'tensorelement(svds([[3,0],[4,0]]),[1,1])';
  await input.fill(edited); await expect(dialog.locator('[role="status"]')).toHaveText('= 5');
  await apply.click(); await expect(dialog).toHaveCount(0);
  const value = row.locator('.pcad-field').nth(1).locator('input');
  await expect(value).toHaveValue(edited);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(value).toHaveValue(source);
  await page.keyboard.press('Control+y'); await expect(value).toHaveValue(edited);
}
