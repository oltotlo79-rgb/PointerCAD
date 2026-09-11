import { readFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeScriptFile, readPcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem, openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';

export const panel = (page: Page): Locator => page.getByRole('region', { name: '自動作図', exact: true });
export const source = (page: Page): Locator => panel(page).getByRole('textbox', { name: 'JavaScript user-script.js', exact: true });
export async function writeDraft(page: Page, name: string, code: string): Promise<void> {
  await panel(page).getByRole('textbox', { name: '処理の名前', exact: true }).fill(name);
  await source(page).fill(code);
}
export async function savePart(page: Page, info: TestInfo, name: string, app?: ElectronApplication) {
  const path = info.outputPath(name);
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+Shift+s');
  if (download !== undefined) await (await download).saveAs(path); else await diskFile(path);
  const file = await readPcadFile(new Uint8Array(await readFile(path)));
  if (!file.ok) throw new Error(JSON.stringify(file.error)); return file.document;
}
export async function successfulRun(page: Page): Promise<void> {
  const token = await beginRecompute(page);
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  await expect(panel(page).getByRole('status').filter({ hasText: /^実行が完了しました$/u })).toBeVisible({ timeout: 35000 });
  await waitForRecompute(page, token);
}
export async function scriptsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '新規', exact: true })).toBeVisible();
  await chooseToolMenuItem(page, '見た目', '簡易強度計算');
  const strengthPanel = page.getByRole('form', { name: '簡易強度計算', exact: true });
  await expect(strengthPanel).toBeVisible();
  await chooseToolMenuItem(page, '自動作図', '自動作図');
  await expect(panel(page)).toBeVisible();
  await expect(strengthPanel).toHaveCount(0);
  await panel(page).getByLabel('例を開く', { exact: true }).selectOption('plate');
  // The editor must allow keyboard users to reach Run without changing source text.
  const originalSource = await source(page).inputValue();
  await source(page).focus();
  await page.keyboard.press('Tab');
  await expect(panel(page).getByRole('button', { name: '実行', exact: true }).first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(source(page)).toBeFocused();
  await expect(source(page)).toHaveValue(originalSource);
  await panel(page).getByText('再実行の入力', { exact: true }).click();
  await panel(page).getByLabel('乱数の種（0〜4294967295）', { exact: true }).fill('123');
  await panel(page).getByLabel('処理へ渡す時刻（UTC）', { exact: true }).fill('2026-09-11T00:00:00.000Z');
  await panel(page).getByText('再実行の入力', { exact: true }).click();
  await successfulRun(page);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  await page.screenshot({ path: info.outputPath('script-plate-created.png') });
  const plate = await savePart(page, info, 'script-plate.pcad', app);
  expect(plate.parameters.find(parameter => parameter.name === '板厚')?.value.source).toBe('5');
  expect(plate.solids.map(solid => solid.kind)).toEqual(['primitive', 'primitive', 'boolean']);
  const undoToken = await beginRecompute(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForRecompute(page, undoToken);
  const undone = await savePart(page, info, 'script-undo.pcad', app);
  expect(undone.parameters).toEqual([]); expect(undone.solids).toEqual([]);
  const redoToken = await beginRecompute(page);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await waitForRecompute(page, redoToken);
  expect(await savePart(page, info, 'script-redo.pcad', app)).toEqual(plate);
  // File save uses the real browser download/native dialog boundary, never a script executor mock.
  const scriptPath = info.outputPath('plate.pcadscript');
  if (app !== undefined) await saveTarget(app, scriptPath);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await panel(page).getByRole('button', { name: '処理ファイルを保存', exact: true }).click();
  if (download !== undefined) await (await download).saveAs(scriptPath); else await diskFile(scriptPath);
  const loaded = await decodeScriptFile(new Uint8Array(await readFile(scriptPath)));
  expect(loaded.ok).toBe(true);
  await writeDraft(page, '変更', 'throw new Error("実行しない");');
  if (app !== undefined) await openTarget(app, scriptPath);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const beforeOpen = await readRecomputeStats(page);
  await panel(page).getByRole('button', { name: '処理ファイルを開く', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(scriptPath);
  await expect(panel(page).getByRole('textbox', { name: '処理の名前', exact: true })).toHaveValue('穴あき板');
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(beforeOpen.requestedGeneration);
  await panel(page).getByRole('button', { name: '道具に登録・更新', exact: true }).click();
  await expect(panel(page)).toContainText('道具を保存しました');
  await page.screenshot({ path: info.outputPath('script-tool-registered.png') });
  await openToolMenu(page, '自動作図');
  await expect(toolMenuPanel(page, '自動作図').getByRole('button', { name: '穴あき板', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('script-tool-menu.png') });
  await page.keyboard.press('Escape');
  await page.reload(); await expect(page.getByRole('button', { name: '新規', exact: true })).toBeVisible();
  // Loading the library does not run it. Explicit toolbar execution restores its input and creates the part.
  await chooseToolMenuItem(page, '自動作図', '穴あき板');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('実行が完了しました', { timeout: 35000 });
  await expect.poll(async () => (await readRecomputeStats(page)).lastOutcome).toBe('success');
  // Error line is the user's original source, and an earlier successful command is discarded.
  const beforeFailure = await savePart(page, info, 'script-before-failure.pcad', app);
  await writeDraft(page, '失敗の例', "cad.solid.box({x:'3',y:'3',z:'3'});\nthrow new Error('2行目の停止');");
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  await expect(panel(page).getByRole('alert')).toContainText('2行目の停止');
  await panel(page).getByRole('button', { name: /エラーの行へ移動 user-script.js:2/u }).click();
  expect(await source(page).evaluate(element => element instanceof HTMLTextAreaElement ? element.value.slice(0, element.selectionStart).split('\n').length : -1)).toBe(2);
  await page.screenshot({ path: info.outputPath('script-error-line.png') });
  expect(await savePart(page, info, 'script-after-failure.pcad', app)).toEqual(beforeFailure);
  // Real user cancellation while VM execution is active.
  await writeDraft(page, '中止の例', 'while (true) {}');
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  await expect(panel(page).getByRole('status').filter({ hasText: /^処理を実行中$/u })).toBeVisible();
  await panel(page).getByRole('button', { name: '中止', exact: true }).click();
  await expect(panel(page)).toContainText('中止しました。文書は変更していません');
  expect(await savePart(page, info, 'script-after-cancel.pcad', app)).toEqual(beforeFailure);
  // Browser APIs are absent in the real dedicated VM; failed calls cause no outgoing request.
  const remote: string[] = [];
  const listener = (request: { url(): string }): void => { if (request.url().startsWith('https://example.invalid')) remote.push(request.url()); };
  page.context().on('request', listener);
  await writeDraft(page, '隔離の例', "fetch('https://example.invalid/secret');");
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  await expect(panel(page).getByRole('alert')).toContainText('fetch');
  expect(remote).toEqual([]); page.context().off('request', listener);
  await source(page).focus(); await page.keyboard.press('F1');
  const help = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
  await expect(help.getByRole('heading', { level: 1 })).toHaveText('JavaScriptで自動作図する');
  await expect(help).toContainText('30秒');
  await expect.poll(() => help.locator('img').evaluateAll(images => images.filter(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0).length)).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');
  for (const chapter of [{ button: 'APIの説明', title: '自動作図APIリファレンス', images: 1 }, { button: '道具登録の説明', title: '処理を保存し、道具として登録する', images: 2 }]) {
    await panel(page).getByRole('button', { name: chapter.button, exact: true }).click();
    await expect(help.getByRole('heading', { level: 1 })).toHaveText(chapter.title);
    await expect.poll(() => help.locator('img').evaluateAll(images => images.filter(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0).length)).toBeGreaterThanOrEqual(chapter.images);
    await page.keyboard.press('Escape');
  }
}
