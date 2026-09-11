import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { readPcadFile, readDrawingBundle, readDxf, parseDxfTags } from '../../packages/io/src/index.js';
import { launchDesktop, openTarget, saveTarget, diskFile } from './electronAppFlow.js';
import { tree, command, chooseSheet, volume, rectangleFace } from './sheetUiFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { sheetHelpFlow } from './sheetHelpFlow.js';

async function makeBase(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  expect(page.url()).toBe('app://pointercad/index.html');
  await rectangleFace(page); await tree(page, '面1').click(); await chooseSheet(page, '板金基板');
  const form = page.getByRole('form', { name: '板金基板', exact: true });
  await form.getByRole('textbox', { name: /^板厚/ }).fill('2');
  await form.getByRole('textbox', { name: /^内半径/ }).fill('3');
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await tree(page, '板金基板1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
}

test('P10 板金を実Electronで基板・フランジ・リリーフから作り、ネイティブ保存・展開出力・図面を通す', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await makeBase(page); await chooseSheet(page, 'フランジ');
    const flange = page.getByRole('form', { name: 'フランジ', exact: true });
    await flange.getByRole('checkbox', { name: 'パネル 1 / 縁 1', exact: true }).check();
    await flange.getByRole('button', { name: '作成', exact: true }).click();
    await tree(page, 'フランジ1').click();
    await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 200 * Math.PI, 4);
    await chooseSheet(page, '曲げリリーフ');
    const relief = page.getByRole('form', { name: '曲げリリーフ', exact: true });
    await relief.getByRole('combobox', { name: '切欠きの入口の縁', exact: true }).selectOption({ label: 'パネル 1 / 縁 1' });
    await relief.getByRole('combobox', { name: '切欠きの形', exact: true }).selectOption('slot');
    await relief.getByRole('textbox', { name: /^切欠きの幅/ }).fill('2*2');
    await relief.getByRole('textbox', { name: /^切欠きの深さ/ }).fill('5');
    await relief.getByRole('button', { name: 'プレビュー', exact: true }).click();
    await expect(relief.getByRole('status')).toContainText('体積:', { timeout: 60_000 });
    await relief.getByRole('button', { name: '作成', exact: true }).click(); await tree(page, '曲げリリーフ1').click();
    const folded = 5000 + 200 * Math.PI - 78 * (6 + Math.PI) / 19;
    await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(folded, 4);
    const part = join(directory, '板金の保存.pcad'); await saveTarget(app, part);
    await page.keyboard.press('Control+s');
    const decoded = readPcadFile(await diskFile(part)); if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.document.solids.map((feature) => feature.kind)).toEqual(['sheetBase', 'sheetFlange', 'sheetRelief']);
    expect(decoded.document.solids[2]).toMatchObject({ width: { source: '2*2', value: 4 } });
    await page.reload(); await openTarget(app, part);
    await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
    const reopening = await beginRecompute(page); await page.getByRole('button', { name: '開く', exact: true }).click(); await waitForRecompute(page, reopening);
    await tree(page, '曲げリリーフ1').click(); await expect.poll(() => volume(page)).toBeCloseTo(folded, 4);
    await chooseSheet(page, '板金の展開');
    const flat = page.getByRole('form', { name: '板金の展開', exact: true });
    await flat.getByRole('combobox', { name: '固定面', exact: true }).selectOption({ label: 'パネル 2' });
    await flat.getByRole('button', { name: '展開を表示', exact: true }).click();
    await expect(flat.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
    expect(Number((await flat.getByRole('status').textContent())?.match(/体積: ([\d.]+)/u)?.[1])).toBeCloseTo(4976 + 186 * Math.PI, 4);
    await sheetHelpFlow(page, '板金を展開し、穴表・図面・加工用ファイルを作る', info, 'native-sheet-help.png');
    for (const [label, filename] of [['展開DXF', '展開.dxf'], ['展開STEP', '展開.step'], ['折曲げSTEP', '折曲げ.step']]) {
      const path = join(directory, filename); await saveTarget(app, path);
      await flat.getByRole('button', { name: label, exact: true }).click();
      const bytes = await diskFile(path); await expect(flat.getByRole('button', { name: label, exact: true })).toBeEnabled();
      if (filename.endsWith('.dxf')) {
        const dxf = readDxf(parseDxfTags(bytes.toString())); expect(dxf.unit).toBe('mm');
        expect(dxf.entities.some((entity) => entity.layer === 'CUT_OUTER' && entity.kind === 'arc')).toBe(true);
        expect(dxf.entities.some((entity) => entity.layer === 'BEND_UP')).toBe(true);
      } else expect(bytes.toString()).toContain('ISO-10303-21;');
    }
    await flat.getByRole('button', { name: '展開から図面を作成', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="上 90° R3"]')).toHaveCount(1, { timeout: 60_000 });
    const drawing = join(directory, '板金の製作図.pcadd'); await saveTarget(app, drawing);
    await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Control+s');
    const bundle = await readDrawingBundle(await diskFile(drawing)); if (!bundle.ok) throw new Error(bundle.error.message);
    expect(bundle.document.views).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('native-sheet-drawing.png') });
    expect(errors).toEqual([]);
  } finally { await app.close(); await writeFile(info.outputPath('native-sheet-closed.json'), JSON.stringify({ closed: true })); }
});

test('P10 板金の指定線曲げを実Electronで取消・作成し、実ファイル再開・式編集・Undoを通す', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await makeBase(page); await command(page, 'L'); await command(page, '0,15'); await command(page, '@50,0');
    await page.locator('.pcad-popover input.pcad-field__input').first().press('Escape'); await tree(page, '線分1').click();
    await chooseSheet(page, '指定線で曲げる');
    const form = page.getByRole('form', { name: '指定線で曲げる', exact: true });
    for (const action of ['取消', '作成']) {
      if (action === '作成') await chooseSheet(page, '指定線で曲げる');
      await form.getByRole('textbox', { name: /^曲げ角/ }).fill('-45*2');
      await form.getByRole('combobox', { name: '固定する側', exact: true }).selectOption('left');
      await form.getByRole('button', { name: 'プレビュー', exact: true }).click();
      await expect(form.getByRole('status')).toContainText('体積:', { timeout: 60_000 });
      await form.getByRole('button', { name: action, exact: true }).click();
      if (action === '取消') await expect(tree(page, '指定線で曲げる1')).toHaveCount(0);
    }
    await tree(page, '指定線で曲げる1').click(); await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 10 * Math.PI, 4);
    const path = join(directory, '指定線曲げ.pcad'); await saveTarget(app, path); await page.keyboard.press('Control+s');
    const decoded = readPcadFile(await diskFile(path)); if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.document.solids[1]).toMatchObject({ kind: 'sheetBend', angle: { source: '-45*2', value: -90 }, fixedSide: 'left' });
    await page.reload(); await openTarget(app, path);
    await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
    const reopening = await beginRecompute(page); await page.getByRole('button', { name: '開く', exact: true }).click(); await waitForRecompute(page, reopening);
    await tree(page, '指定線で曲げる1').click();
    const angle = page.locator('.pcad-panel--right .pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: /^曲げ角$/ }) }).locator('input');
    await angle.fill('-45'); await angle.press('Tab'); await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 5 * Math.PI, 4);
    await page.locator('canvas.pcad-viewport__canvas').press('Control+z'); await expect(angle).toHaveValue('-45*2');
    await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 10 * Math.PI, 4);
    await page.screenshot({ path: info.outputPath('native-sheet-line.png') }); expect(errors).toEqual([]);
  } finally { await app.close(); await writeFile(info.outputPath('native-sheet-closed.json'), JSON.stringify({ closed: true })); }
});
