/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readDrawingBundle, readPcadaFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { diskFile, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForDrawingReady } from './drawingManufacturingFixture.js';
import { uiMessage } from './uiMessages.js';

async function saved(page: Page, info: TestInfo, name: string, kind: 'assembly' | 'drawing', app?: ElectronApplication) {
  const path = info.outputPath(name);
  if (app !== undefined) await saveTarget(app, path);
  await page.locator(kind === 'drawing' ? '.pcad-drawing-sheet' : 'canvas.pcad-viewport__canvas').focus();
  if (app === undefined) {
    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+Shift+s')]);
    await file.saveAs(path);
  } else { await page.keyboard.press('Control+Shift+s'); await diskFile(path); }
  const bytes = await readFile(path);
  const result = kind === 'drawing' ? await readDrawingBundle(bytes) : await readPcadaFile(bytes);
  if (!result.ok) throw new Error('保存した文書を読み戻せません。');
  return result.document;
}

async function choose(page: Page, surface: string, commandId: string): Promise<void> {
  const bounds = await page.locator(surface).boundingBox();
  if (bounds === null) throw new Error('作業画面がありません。');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: 'right' });
  const menu = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
  await expect(menu.getByRole('menuitem')).toHaveCount(8);
  await menu.locator(`[data-command-id="${commandId}"]`).click();
  await expect(menu).toHaveCount(0);
}

export async function radialAssemblyFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const token = await beginRecompute(page);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: uiMessage('assembly', 'assembly.file.new'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  const before = await saved(page, info, 'radial-before.pcada', 'assembly', app);
  await choose(page, 'canvas.pcad-viewport__canvas', 'toolbar.assembly.placeStandardPart');
  const picker = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
  expect(await saved(page, info, 'radial-cancel.pcada', 'assembly', app)).toEqual(before);
  await choose(page, 'canvas.pcad-viewport__canvas', 'toolbar.view.home');
  expect(await saved(page, info, 'radial-home.pcada', 'assembly', app)).toEqual(before);
}

export async function radialDrawingFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '作る', '箱');
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input').first().press('Enter'); await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await waitForDrawingReady(page);
  const before = await saved(page, info, 'radial-before.pcadd', 'drawing', app);
  await choose(page, '.pcad-drawing-svg', 'toolbar.drawing.note');
  const position = await page.locator('.pcad-drawing-svg svg').evaluate(element => {
    if (!(element instanceof SVGSVGElement)) throw new Error('用紙がありません。');
    const matrix = element.getScreenCTM();
    if (matrix === null) throw new Error('用紙の位置がありません。');
    const point = new DOMPoint(80, 77).matrixTransform(matrix); return { x: point.x, y: point.y };
  });
  await page.mouse.click(position.x, position.y);
  const form = page.getByRole('form', { name: uiMessage('drawing', 'drawing.note.title'), exact: true });
  await form.getByLabel(uiMessage('drawing', 'drawing.note.text'), { exact: true }).fill('放射メニューからの注記');
  await form.getByRole('button', { name: '決定', exact: true }).click();
  await form.getByRole('button', { name: '閉じる', exact: true }).click();
  await waitForDrawingReady(page);
  await expect(page.locator('.pcad-drawing-svg [aria-label="放射メニューからの注記"]')).toHaveCount(1);
  expect(await saved(page, info, 'radial-note.pcadd', 'drawing', app)).not.toEqual(before);
  await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Control+z');
  await waitForDrawingReady(page);
  await expect(page.locator('.pcad-drawing-svg [aria-label="放射メニューからの注記"]')).toHaveCount(0);
  expect(await saved(page, info, 'radial-undo.pcadd', 'drawing', app)).toEqual(before);
}
