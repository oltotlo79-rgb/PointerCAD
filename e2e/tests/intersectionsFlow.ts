import { expect, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { resolveSketch } from '../../packages/model/src/index.js';
import { tree, command } from './sheetUiFlow.js';
import { sheetHelpFlow } from './sheetHelpFlow.js';

type Point = readonly [number, number, number];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Independent projection for the unchanged initial home view (Z up, -45 degree azimuth). */
async function screenPoint(page: Page, world: Point): Promise<readonly [number, number]> {
  const box = await page.locator('canvas.pcad-viewport__canvas').boundingBox();
  if (box === null) throw new Error('missing viewport');
  const z: Point = [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const x: Point = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const y: Point = [-1 / Math.sqrt(6), 1 / Math.sqrt(6), Math.sqrt(2 / 3)];
  const depth = 200 - dot(world, z);
  const scale = box.height / (2 * Math.tan(25 * Math.PI / 180) * depth);
  return [box.x + box.width / 2 + scale * dot(world, x), box.y + box.height / 2 - scale * dot(world, y)];
}
export function lineRows(page: Page) { return page.locator('.pcad-panel--left').getByRole('button', { name: /^線分\d+$/u }); }
function pointFields(page: Page) { return page.locator('.pcad-panel--right .pcad-coordinate__fields input.pcad-field__input'); }

export async function intersectionEditingFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  for (const [from, to] of [['-40,0', '@40*2<0'], ['0,-30', '@30*2<90']]) {
    await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
    await command(page, 'L'); await command(page, from);
    await expect(page.getByRole('switch', { name: '交点でつなぐ', exact: true })).toBeChecked();
    if (from === '-40,0') {
      await page.getByRole('switch', { name: '交点でつなぐ', exact: true }).focus();
      await sheetHelpFlow(page, '交点で線をつなぐ・曲げる・区間を消す', info, 'intersection-help.png');
    }
    await command(page, to);
    await page.locator('.pcad-popover input.pcad-field__input').first().press('Escape');
  }
  await expect(lineRows(page)).toHaveCount(4); await tree(page, '交点1').click();
  await page.screenshot({ path: info.outputPath('intersection-created.png') });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  const start = await screenPoint(page, [0, 0, 0]), end = await screenPoint(page, [8, 6, 0]);
  await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(...end, { steps: 12 }); await page.mouse.up();
  await tree(page, '交点1').click();
  // Firefox quantizes pointer coordinates to CSS pixels. Check the actual visible target
  // in pixels, then enter exact millimetres through the property UI for the saved oracle.
  await expect.poll(async () => {
    const at: Point = [Number(await pointFields(page).nth(0).inputValue()), Number(await pointFields(page).nth(1).inputValue()), 0];
    const projected = await screenPoint(page, at);
    return Math.hypot(projected[0] - end[0], projected[1] - end[1]);
  }).toBeLessThan(1);
  for (const [index, value] of ['8', '6'].entries()) {
    await pointFields(page).nth(index).fill(value); await pointFields(page).nth(index).press('Enter');
    await expect(pointFields(page).nth(index)).toHaveValue(value);
  }
  await page.screenshot({ path: info.outputPath('intersection-bent.png') });
  // The original polar formula remains editable on the named outer endpoint.
  await tree(page, '線分1 終点').click(); await expect(pointFields(page).nth(0)).toHaveValue('40*2');
  await page.getByRole('group', { name: 'スケッチ', exact: true }).locator('.pcad-menu__trigger').nth(1).click();
  await page.locator('.pcad-menu__panel[aria-label="編集"]').getByRole('button', { name: 'トリム', exact: true }).click();
  const trim = await screenPoint(page, [-16, 3, 0]);
  await page.mouse.move(...trim); await page.screenshot({ path: info.outputPath('intersection-trim-preview.png') });
  await page.mouse.click(...trim); await expect(lineRows(page)).toHaveCount(3);
  await expect(tree(page, '線分3')).toHaveCount(0);
  await expect(tree(page, '線分1')).toBeVisible();
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(lineRows(page)).toHaveCount(4);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  await tree(page, '線分3').click(); await page.keyboard.press('Delete'); await expect(lineRows(page)).toHaveCount(3);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(lineRows(page)).toHaveCount(4); await tree(page, '交点1').click();
}

export function verifyIntersectionFile(bytes: Uint8Array): void {
  const result = readPcadFile(bytes); if (!result.ok) throw new Error(result.error.message);
  const sketch = result.document.sketches[0], resolved = resolveSketch(sketch);
  expect(resolved.errors).toEqual([]); expect(resolved.segments).toHaveLength(4);
  const junction = sketch.features.find((feature) => feature.name === '交点1');
  expect(junction?.kind).toBe('point');
  const at = resolved.points.find((point) => point.id === junction?.id)?.position;
  if (at === undefined) throw new Error('saved junction missing');
  expect(at[0]).toBeCloseTo(8, 1); expect(at[1]).toBeCloseTo(6, 1);
  for (const segment of resolved.segments) {
    expect([segment.from, segment.to].some((point) => point.every((value, i) => Math.abs(value - at[i]) < 1e-8))).toBe(true);
  }
}

export async function editReopenedIntersection(page: Page): Promise<void> {
  await expect(lineRows(page)).toHaveCount(4); await tree(page, '交点1').click();
  await pointFields(page).nth(0).fill('4*3'); await pointFields(page).nth(0).press('Enter');
  await expect(pointFields(page).nth(0)).toHaveValue('4*3');
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await tree(page, '交点1').click();
  await expect.poll(async () => Number(await pointFields(page).nth(0).inputValue())).toBeCloseTo(8, 1);
}
