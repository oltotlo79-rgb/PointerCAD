import { readFile } from 'node:fs/promises';
import { expect, test, type Locator } from '@playwright/test';
import { readDrawingBundle, readDrawingTemplateFile } from '../../packages/io/src/index.js';
import { createBox, drawingFromBox, chooseDrawingMenu, waitForDrawingReady } from './drawingManufacturingFixture.js';
import { drawingMessage as m } from './drawingMessages.js';

async function openFields(settings: Locator): Promise<void> {
  const details = settings.locator('.pcad-drawing-settings details');
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

test('FIX-13 用紙の原式を再編集・Undo・保存再開・ひな形で保ち、入力欄に不成立の理由を示す', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await drawingFromBox(page);
  const settings = page.locator('.pcad-drawing-property-section[data-property-kind="sheet"]');
  if (await settings.getAttribute('open') === null) await settings.locator(':scope > summary').click();
  const scale = settings.getByLabel(m('drawing.sheet.scale'), { exact: true });
  const height = settings.getByLabel(m('drawing.table.textHeight'), { exact: true });
  const options = settings.getByLabel(m('drawing.sheet.scales'), { exact: true });
  const width = settings.getByLabel(m('drawing.sheet.fieldWidth'), { exact: true }).first();
  const apply = settings.getByRole('button', { name: m('drawing.sheet.apply'), exact: true });
  const originalScale = await scale.inputValue();

  await scale.fill('1/2');
  await height.fill('7/2');
  await options.fill('1/2, 1, root(8, 3)');
  await openFields(settings);
  await width.fill('1+1');
  await apply.click();
  await waitForDrawingReady(page);
  await expect(scale).toHaveValue('1/2');
  await expect(height).toHaveValue('7/2');
  await expect(options).toHaveValue('1/2, 1, root(8, 3)');
  await openFields(settings);
  await expect(width).toHaveValue('1+1');
  await expect(page.getByTestId('drawing-status-scale')).toHaveText(m('drawing.status.scale').replace('{ratio}', '1:2'));

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await waitForDrawingReady(page);
  await expect(scale).toHaveValue(originalScale);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await waitForDrawingReady(page);
  await expect(scale).toHaveValue('1/2');
  await scale.fill('1/4');
  await apply.click();
  await waitForDrawingReady(page);
  await expect(scale).toHaveValue('1/4');
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await waitForDrawingReady(page);
  await expect(scale).toHaveValue('1/2');

  for (const [input, bad, good] of [[scale, '1/0', '1/2'], [height, '0', '7/2'], [options, '1, 1/0', '1/2, 1, root(8, 3)']] as const) {
    await input.fill(bad);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const errorId = await input.getAttribute('aria-describedby');
    if (errorId === null) throw new Error('入力欄と理由が結びついていません');
    await expect(settings.locator(`[id="${errorId}"]`)).toBeVisible();
    await apply.click();
    await expect(page.getByTestId('drawing-status-scale')).toHaveText(m('drawing.status.scale').replace('{ratio}', '1:2'));
    await input.fill(good);
    await expect(input).toHaveAttribute('aria-invalid', 'false');
  }
  await openFields(settings);
  await width.fill('-1');
  await expect(width).toHaveAttribute('aria-invalid', 'true');
  await apply.click();
  await expect(width).toHaveValue('-1');
  await width.fill('1+1');
  await apply.click();
  await waitForDrawingReady(page);

  const sheetExpectation = { scale: 0.5, scaleExpression: '1/2', textHeight: 3.5, textHeightExpression: '7/2',
    scaleOptions: [0.5, 1, 2], scaleOptionExpressions: ['1/2', '1', 'root(8, 3)'] };
  const drawingSheet = page.locator('.pcad-drawing-sheet');
  await drawingSheet.focus();
  await expect(drawingSheet).toBeFocused();
  const [saved] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const path = await saved.path();
  if (path === null) throw new Error('図面の保存なし');
  const bytes = await readFile(path), parsed = await readDrawingBundle(bytes);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(parsed.document.sheet).toMatchObject(sheetExpectation);
  expect(parsed.document.sheet.titleBlockFields?.[0]).toMatchObject({ widthWeight: 2, widthExpression: '1+1' });

  await page.reload();
  const [opening] = await Promise.all([page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '開く', exact: true }).click()]);
  await opening.setFiles({ name: '数式の用紙.pcadd', mimeType: 'application/zip', buffer: bytes });
  await waitForDrawingReady(page);
  if (await settings.getAttribute('open') === null) await settings.locator(':scope > summary').click();
  await expect(scale).toHaveValue('1/2');
  await expect(height).toHaveValue('7/2');
  await openFields(settings);
  await expect(width).toHaveValue('1+1');
  await settings.getByLabel(m('drawing.template.name'), { exact: true }).fill('数式の標準');
  const [templateDownload] = await Promise.all([page.waitForEvent('download'),
    settings.getByRole('button', { name: m('drawing.template.save'), exact: true }).click()]);
  const templatePath = await templateDownload.path();
  if (templatePath === null) throw new Error('ひな形の保存なし');
  const templateBytes = await readFile(templatePath), template = readDrawingTemplateFile(templateBytes);
  if (!template.ok) throw new Error(template.error.message);
  expect(template.template.sheet).toMatchObject(sheetExpectation);
  expect(template.template.sheet.titleBlockFields?.[0]).toMatchObject({ widthWeight: 2, widthExpression: '1+1' });

  await chooseDrawingMenu(page, 'ファイル', '部品へ戻る');
  await expect(page.locator('canvas.pcad-viewport__canvas')).toHaveCount(1);
  // 図面だけを開き直した後の部品は空なので、ひな形が参照する立体を用意する。
  await createBox(page);
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true })).toBeVisible();
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  const [choosing] = await Promise.all([page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '図面ひな形から作成', exact: true }).click()]);
  await choosing.setFiles({ name: '数式の標準.pcadt', mimeType: 'application/zip', buffer: templateBytes });
  await waitForDrawingReady(page);
  if (await settings.getAttribute('open') === null) await settings.locator(':scope > summary').click();
  await expect(scale).toHaveValue('1/2');
  await expect(height).toHaveValue('7/2');
  await openFields(settings);
  await expect(width).toHaveValue('1+1');
});
