import { readFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { diskFile, saveTarget } from './electronAppFlow.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';

const handoff = (page: Page) => page.getByRole('dialog', { name: '加工ソフトへ渡す', exact: true });
async function exportFile(page: Page, info: TestInfo, format: 'STEP' | 'STL' | '3MF', app?: ElectronApplication): Promise<string> {
  const path = info.outputPath(`cam-output.${format.toLowerCase()}`);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '書き出す');
  const panel = page.getByRole('form', { name: '書き出し', exact: true });
  await panel.getByRole('radio', { name: format, exact: true }).click();
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await panel.getByRole('button', { name: '書き出す', exact: true }).click();
  if (download !== undefined) await (await download).saveAs(path);
  else await diskFile(path);
  await expect(panel).toHaveCount(0); await expect(handoff(page)).toBeVisible();
  const appearance = await handoff(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, align: style.textAlign };
  });
  expect(appearance.background).toMatch(/^rgb\(\d+, \d+, \d+\)$/u);
  expect(appearance.align).toBe('left');
  expect((await readFile(path)).length).toBeGreaterThan(100);
  return path;
}
async function nativeCalls(app: ElectronApplication): Promise<readonly string[]> {
  return app.evaluate(() => {
    const calls: unknown = Object.getOwnPropertyDescriptor(globalThis, 'pcadCamCalls')?.value;
    if (!Array.isArray(calls)) throw new Error('外部起動の記録なし');
    return calls.filter((value: unknown): value is string => typeof value === 'string');
  });
}
async function openWebsite(page: Page, label: string, url: string, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) {
    const before = (await nativeCalls(app)).length;
    await handoff(page).getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => nativeCalls(app)).toHaveLength(before + 1);
    expect((await nativeCalls(app)).at(-1)).toBe(url);
    return;
  }
  const requests: { method: string; url: string; data: string | null }[] = [];
  await page.context().route(url, async (route) => {
    const request = route.request(); requests.push({ method: request.method(), url: request.url(), data: request.postData() });
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>外部案内先のテスト用応答</title>' });
  });
  const opening = page.context().waitForEvent('page');
  await handoff(page).getByRole('button', { name: label, exact: true }).click();
  const popup = await opening; await expect(popup).toHaveURL(url); await popup.close();
  expect(requests).toEqual([{ method: 'GET', url, data: null }]);
  await page.context().unroute(url);
}
export async function camFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '新規', exact: true })).toBeVisible();
  if (app !== undefined) await app.evaluate(({ shell }) => {
    const calls: string[] = [];
    Object.defineProperty(globalThis, 'pcadCamCalls', { configurable: true, value: calls });
    shell.openPath = (path) => { calls.push(path); return Promise.resolve(''); };
    shell.openExternal = (url) => { calls.push(url); return Promise.resolve(); };
  });
  await chooseToolMenuItem(page, '作る', '箱');
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  const original = info.outputPath('cam-source.pcad');
  if (app !== undefined) await saveTarget(app, original);
  const saving = app === undefined ? page.waitForEvent('download') : undefined;
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+s');
  if (saving !== undefined) await (await saving).saveAs(original); else await diskFile(original);
  const sourceBytes = await readFile(original), before = await readRecomputeStats(page);
  const step = await exportFile(page, info, 'STEP', app);
  expect((await readFile(step, 'utf8')).startsWith('ISO-10303-21;')).toBe(true);
  await expect(handoff(page).getByRole('button', { name: 'Kiri:Motoを開く', exact: true })).toHaveCount(0);
  const nativeButton = handoff(page).getByRole('button', { name: '既定のアプリで開く', exact: true });
  if (app === undefined) await expect(nativeButton).toHaveCount(0);
  else {
    expect(await nativeCalls(app)).toEqual([]);
    await nativeButton.click(); await expect.poll(() => nativeCalls(app)).toEqual([step]);
  }
  await page.screenshot({ path: info.outputPath('cam-step-handoff.png') });
  await handoff(page).getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(handoff(page)).toHaveCount(0); expect((await readFile(step)).length).toBeGreaterThan(100);
  for (const format of ['STL', '3MF'] satisfies readonly ('STL' | '3MF')[]) {
    await exportFile(page, info, format, app);
    await expect(handoff(page)).toContainText('形はこのアプリからは送られません');
    await page.screenshot({ path: info.outputPath(`cam-${format.toLowerCase()}-handoff.png`) });
    await openWebsite(page, 'Kiri:Motoを開く', 'https://grid.space/kiri/', app);
    await openWebsite(page, 'PrusaSlicerの案内を開く', 'https://www.prusa3d.com/p/prusaslicer/', app);
    if (format === 'STL') { await handoff(page).getByRole('button', { name: '閉じる', exact: true }).click(); }
  }
  await handoff(page).getByRole('button', { name: '加工ソフトへの受け渡し手順', exact: true }).focus();
  await page.keyboard.press('F1');
  const help = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
  await expect(help.getByRole('heading', { level: 1 })).toHaveText('作った形を加工ソフトへ渡す');
  await expect(help.locator('img')).toHaveCount(2);
  await expect.poll(() => help.locator('img').evaluateAll((images) => images.every((image) =>
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  for (const title of ['Kiri:Motoで加工する', 'PrusaSlicerなどのスライサーで3Dプリントする', 'FreeCAD CAMで切削加工する', 'Autodesk Fusionの個人利用版で切削加工する']) {
    await expect(help.getByRole('heading', { name: title, exact: true })).toHaveCount(1);
  }
  if (app !== undefined) {
    const link = help.getByRole('link', { name: 'FreeCAD公式の機能紹介', exact: true });
    await link.click(); await expect.poll(async () => (await nativeCalls(app)).at(-1)).toBe('https://www.freecad.org/features.php');
  }
  await page.screenshot({ path: info.outputPath('cam-help.png') });
  await page.keyboard.press('Escape'); await expect(help).toHaveCount(0);
  if (app !== undefined) {
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' }); });
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '書き出す');
    const panel = page.getByRole('form', { name: '書き出し', exact: true });
    await panel.getByRole('button', { name: '書き出す', exact: true }).click();
    await expect(handoff(page)).toHaveCount(0); await expect(panel.getByRole('button', { name: '書き出す', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'やめる', exact: true }).click();
  }
  expect(await readRecomputeStats(page)).toEqual(before); expect(await readFile(original)).toEqual(sourceBytes);
  await page.getByRole('button', { name: '新規', exact: true }).click();
  await expect(handoff(page)).toHaveCount(0);
}
