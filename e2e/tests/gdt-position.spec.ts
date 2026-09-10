/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { readPcaddFile } from '../../packages/io/src/index.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { offsetHolePartFile } from './drawingTestSupport.js';
import { chooseDrawingMenu, expectDrawingStroke } from './drawingManufacturingFixture.js';
import { drawingMessage as m } from './drawingMessages.js';

test.describe('P9 サイズ形体の幾何公差', () => {
  test('実際の穴に直径0.1M/A/B/Cを付け、二面幅の中心平面・多段・失われた参照も編集して保存する', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); const opening = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '開く', exact: true }).click(); const token = await beginRecompute(page);
    await (await opening).setFiles({ name: '位置度の基準部品.pcad', mimeType: 'application/zip', buffer: Buffer.from(offsetHolePartFile()) });
    await waitForRecompute(page, token);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    const owner = (id: string) => page.locator(`.pcad-drawing-svg [data-owner-id="${id}"]`);
    const strokes = (id: string) => page.locator(`.pcad-drawing-svg [data-owner-id="${id}"][data-layer-id="layer-1"] path`);
    await expectDrawingStroke(strokes('view-2'));
    await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
    const tree = page.locator('.pcad-panel--left'), sheet = page.locator('.pcad-drawing-sheet');
    const form = page.getByRole('form', { name: m('drawing.gdt.title'), exact: true });
    const datum = page.getByRole('form', { name: m('drawing.gdt.datum'), exact: true });
    const apply = () => form.getByRole('button', { name: m('drawing.action.apply'), exact: true }).click();
    async function circle(): Promise<void> {
      const point = await strokes('view-2').evaluateAll((elements) => {
        const curve = elements.find((element) => element instanceof SVGPathElement && /C/u.test(element.getAttribute('d') ?? ''));
        if (!(curve instanceof SVGPathElement)) throw new Error('穴の実円周なし');
        const local = curve.getPointAtLength(curve.getTotalLength() / 2), matrix = curve.getScreenCTM();
        if (matrix === null) throw new Error('円周の座標なし');
        const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix); return { x: screen.x, y: screen.y };
      });
      await page.mouse.click(point.x, point.y);
    }
    for (const [index, view] of ['view-1', 'view-2', 'view-3'].entries()) {
      await chooseDrawingMenu(page, m('drawing.toolbar.annotations'), m('drawing.gdt.datum'));
      const point = await strokes(view).evaluateAll((paths) => {
        const bounds = paths.map((path) => path.getBoundingClientRect());
        const left = Math.min(...bounds.map((box) => box.left)), right = Math.max(...bounds.map((box) => box.right));
        const top = Math.min(...bounds.map((box) => box.top)), bottom = Math.max(...bounds.map((box) => box.bottom));
        return { x: left + (right - left) * 0.2, y: top + (bottom - top) * 0.25 };
      });
      await page.mouse.click(point.x, point.y);
      await datum.getByLabel(m('drawing.note.x'), { exact: true }).fill(String([85, 90, 255][index]));
      await datum.getByLabel(m('drawing.note.y'), { exact: true }).fill(String([150, 245, 150][index]));
      await datum.getByRole('button', { name: m('drawing.action.apply'), exact: true }).click();
      await expect(owner(`datum-${index + 1}`).locator(`[aria-label="${'ABC'[index]}"]`)).toHaveCount(1);
    }
    await chooseDrawingMenu(page, '寸法', m('drawing.dimension.diameter')); await circle();
    await expect(owner('dim-1').locator('[aria-label="φ4"]')).toHaveCount(1);
    await chooseDrawingMenu(page, m('drawing.toolbar.annotations'), m('drawing.gdt.title')); await circle();
    await form.getByLabel(m('drawing.gdt.feature'), { exact: true }).selectOption('axis');
    await form.getByLabel(m('drawing.gdt.characteristic'), { exact: true }).selectOption('position');
    await form.getByLabel(m('drawing.gdt.value'), { exact: true }).fill('0.2/2');
    await form.getByLabel(m('drawing.gdt.maximum'), { exact: true }).check();
    await expect(form.getByLabel(m('drawing.gdt.sizeDimension'), { exact: true })).toHaveValue('dim-1');
    for (const [index, label] of ['A', 'B', 'C'].entries()) {
      await form.getByRole('group', { name: m('drawing.gdt.order').replace('{number}', String(index + 1)), exact: true })
        .getByLabel(m('drawing.gdt.datum'), { exact: true }).selectOption({ label });
    }
    await form.getByLabel(m('drawing.note.x'), { exact: true }).fill('135');
    await form.getByLabel(m('drawing.note.y'), { exact: true }).fill('250');
    await apply();
    for (const label of ['0.1', 'A', 'B', 'C']) await expect(owner('gdt-1').locator(`[aria-label="${label}"]`)).toHaveCount(1);
    await tree.getByRole('button', { name: '幾何公差 1', exact: true }).click(); await form.locator('strong').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('gdt-position-abc.png'), fullPage: true });
    // 幅を表す2本の実投影辺から、裏面を直接選ばず二面の中心平面を指定する。
    const edges = await strokes('view-1').evaluateAll((paths) => {
      const lines = paths.flatMap((path) => {
        if (!(path instanceof SVGPathElement) || /C/u.test(path.getAttribute('d') ?? '')) return [];
        const a = path.getPointAtLength(0), b = path.getPointAtLength(path.getTotalLength()), matrix = path.getScreenCTM();
        if (matrix === null || Math.abs(a.x - b.x) > 0.01 || Math.abs(a.y - b.y) < 10) return [];
        const p = new DOMPoint((a.x + b.x) / 2, (a.y + b.y) / 2).matrixTransform(matrix); return [{ x: p.x, y: p.y }];
      }).sort((a, b) => a.x - b.x);
      if (lines.length < 2) throw new Error('幅を示す辺がありません'); return [lines[0], lines[lines.length - 1]];
    });
    await chooseDrawingMenu(page, '寸法', m('drawing.dimension.length'));
    await page.keyboard.down('Control');
    for (const point of edges) await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
    await expect(owner('dim-2').locator('[aria-label="20"]')).toHaveCount(1);
    await chooseDrawingMenu(page, m('drawing.toolbar.annotations'), m('drawing.gdt.title'));
    await page.mouse.click(edges[0].x, edges[0].y); await page.keyboard.down('Control');
    await page.mouse.click(edges[1].x, edges[1].y); await page.keyboard.up('Control');
    await form.getByLabel(m('drawing.gdt.feature'), { exact: true }).selectOption('medianPlane');
    await form.getByLabel(m('drawing.gdt.maximum'), { exact: true }).check();
    await expect(form.getByLabel(m('drawing.gdt.sizeDimension'), { exact: true })).toHaveValue('dim-2');
    await form.getByLabel(m('drawing.note.x'), { exact: true }).fill('150');
    await form.getByLabel(m('drawing.note.y'), { exact: true }).fill('80'); await apply();
    await expect(owner('gdt-2').locator('[aria-label="0.05"]')).toHaveCount(1);
    await tree.getByRole('button', { name: '幾何公差 1', exact: true }).click();
    await form.getByRole('button', { name: m('drawing.gdt.addRow'), exact: true }).click();
    const second = form.getByRole('group', { name: m('drawing.gdt.row').replace('{number}', '2'), exact: true });
    await second.getByLabel(m('drawing.gdt.characteristic'), { exact: true }).selectOption('straightness');
    await second.getByLabel(m('drawing.gdt.value'), { exact: true }).fill('0.03'); await apply();
    await expect(owner('gdt-1').locator('[aria-label="0.03"]')).toHaveCount(1);
    await form.locator('strong').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('gdt-position-median-multirow.png'), fullPage: true });
    // 不足参照を保存し、再読込から編集して復旧できることを確かめる。
    await tree.getByRole('button', { name: 'データム 2 B', exact: true }).click(); await sheet.focus(); await page.keyboard.press('Delete');
    await expect(page.getByRole('alert').filter({ hasText: m('drawing.manufacturing.outputUnresolved') })).toBeVisible();
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const savedPath = await (await saving).path(); if (savedPath === null) throw new Error('図面保存なし'); const bytes = await readFile(savedPath);
    const saved = readPcaddFile(bytes); if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.document.gdtFrames[0].segments[0]).toMatchObject({ characteristic: 'position', material: 'maximum', tolerance: { expression: { source: '0.2/2' } } });
    expect(saved.document.gdtFrames[1].feature).toMatchObject({ kind: 'medianPlane', targets: [
      { ref: { fingerprint: { kind: 'face' } } }, { ref: { fingerprint: { kind: 'face' } } },
    ] });
    await page.reload(); const reopening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
    await (await reopening).setFiles({ name: '修復する公差.pcadd', mimeType: 'application/zip', buffer: bytes });
    await expect(owner('gdt-2').locator('[aria-label="0.05"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await tree.getByRole('button', { name: /幾何公差 1/u }).click();
    const primary = form.getByRole('group', { name: m('drawing.gdt.row').replace('{number}', '1'), exact: true });
    const secondDatum = primary.getByRole('group', { name: m('drawing.gdt.order').replace('{number}', '2'), exact: true });
    await expect(secondDatum.getByLabel(m('drawing.gdt.datum'), { exact: true })).toHaveValue('datum-2');
    await expect(secondDatum.getByRole('option', { name: m('drawing.gdt.missingDatum'), exact: true })).toHaveCount(1);
    await secondDatum.getByLabel(m('drawing.gdt.datum'), { exact: true }).selectOption(''); await apply();
    await expect(owner('gdt-1').locator('[aria-label="0.1"]')).toHaveCount(1);
    await expect(page.getByRole('alert').filter({ hasText: m('drawing.manufacturing.outputUnresolved') })).toHaveCount(0);
    await tree.getByRole('button', { name: '幾何公差 1', exact: true }).click(); await form.locator('strong').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('gdt-position-median-repaired.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
});
