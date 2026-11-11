import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { resolveSketch, type Vec3 } from '../../packages/model/src/index.js';
import { command, tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openTarget } from './electronAppFlow.js';
import { captureManualDetail } from './captureManualDetail.js';
import { uiMessage } from './uiMessages.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { propertySection, propertyValue } from './measurementCaptureSupport.js';

const menu = (page: Page) => page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
const item = (page: Page) => menu(page).locator('[data-command-id="sketch.connectPoints"]');
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');

/** Independent projection of the unchanged initial home camera, as in intersectionsFlow. */
export async function pointOnScreen(page: Page, world: Vec3): Promise<readonly [number, number]> {
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error('作図画面がありません。');
  const depth = 200 - (world[0] - world[1] + world[2]) / Math.sqrt(3);
  const scale = bounds.height / (2 * Math.tan(25 * Math.PI / 180) * depth);
  return [bounds.x + bounds.width / 2 + scale * (world[0] + world[1]) * Math.SQRT1_2,
    bounds.y + bounds.height / 2 - scale * (-world[0] + world[1] + 2 * world[2]) / Math.sqrt(6)];
}

/** Confirm the coordinates in the point tool's visible numeric dialog. */
export async function createPoint(page: Page, info: TestInfo, position: Vec3, number: number, app?: ElectronApplication): Promise<void> {
  const before = await savePart(page, info, `point-${number}-before.pcad`, app);
  await command(page, 'PO');
  const panel = page.getByRole('dialog', { name: '点を作る', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '絶対', exact: true }).click();
  const fields = panel.locator('input.pcad-field__input');
  await expect(fields).toHaveCount(3);
  for (const [index, coordinate] of position.entries()) await fields.nth(index).fill(String(coordinate));
  let token = await beginRecompute(page);
  await fields.first().press('Enter');
  await expect(page.locator('.pcad-statusbar--error')).toHaveCount(0);
  await expect(tree(page, `点${number}`)).toBeVisible();
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: /^点\d+$/u })).toHaveCount(number);
  // Continued drawing opens the next point. Escape belongs to that input, not the command line.
  await panel.locator('input.pcad-field__input').first().press('Escape');
  await expect(panel).toHaveCount(0);
  await waitForRecompute(page, token);
  const created = await savePart(page, info, `point-${number}-created.pcad`, app);
  const features = created.sketches[0].features;
  expect(features.slice(0, -1)).toEqual(before.sketches[0].features);
  expect(features.at(-1)).toMatchObject({ kind: 'point', id: `point-${number}` });
  expect(created.solids).toEqual(before.solids);
  expect(resolveSketch(created.sketches[0]).points.at(-1)).toMatchObject({ position });
  // One coordinate submission must be one document commit, including in continued drawing.
  token = await beginRecompute(page); await canvas(page).focus(); await page.keyboard.press('Control+z');
  await waitForRecompute(page, token);
  expect(await savePart(page, info, `point-${number}-undone.pcad`, app)).toEqual(before);
  token = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
  expect(await savePart(page, info, `point-${number}-redone.pcad`, app)).toEqual(created);
}

export const CONNECTED_ENDPOINT_CASES = ['vertices', 'mixed', 'planes'] as const;
export type ConnectedEndpointCase = typeof CONNECTED_ENDPOINT_CASES[number];

/** Actual UI/OCCT result, independent of saved fingerprint coordinates or model fallback resolution. */
async function expectLiveLength(page: Page, from: Vec3, to: Vec3): Promise<void> {
  await tree(page, '線分1').click();
  const length = propertyValue(page, uiMessage('propertyPanel', 'propertyPanel.length'));
  await expect(length).toBeVisible();
  expect(Number(await length.textContent())).toBeCloseTo(Math.hypot(...from.map((value, axis) => value - to[axis])), 3);
}

/** Three definitions run independently in Web functional, Firefox, and real Electron (nine paths). */
export async function connectedVerticesFlow(page: Page, info: TestInfo, mode: ConnectedEndpointCase,
  app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const first: Vec3 = mode === 'planes' ? [0, 0, 0] : [-10, -10, -10];
  const second: Vec3 = mode === 'vertices' ? [10, 10, 10] : mode === 'mixed' ? [40, 0, 25] : [30, 20, 25];
  if (mode !== 'planes') {
    await chooseToolMenuItem(page, '作る', '箱');
    const token = await beginRecompute(page);
    await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
    if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
    await expect(page.locator('.pcad-popover')).toHaveCount(0);
    await waitForRecompute(page, token); await expect(tree(page, '箱1')).toBeVisible();
  }
  if (mode === 'planes') {
    await createPoint(page, info, first, 1, app);
  }
  if (mode !== 'vertices') {
    await page.getByRole('group', { name: '作図面', exact: true }).locator('.pcad-menu__trigger').first().click();
    await page.locator('.pcad-menu__panel[aria-label="作図面"]').getByRole('button', { name: '3D', exact: true }).click();
    await createPoint(page, info, second, mode === 'planes' ? 2 : 1, app);
  }
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  await canvas(page).focus(); await page.keyboard.press('1');
  await expect(page.locator('.pcad-statusbar__state').first()).toContainText('頂点');
  const before = await savePart(page, info, `${mode}-before.pcad`, app);
  const a = await pointOnScreen(page, first), b = await pointOnScreen(page, second);
  // First prove the disabled single-point reason, then actual mouse hits plus modifier addition.
  await page.mouse.move(...a); await page.mouse.click(...a); await page.mouse.click(...a, { button: 'right' });
  await expect(item(page)).toHaveAttribute('aria-disabled', 'true');
  await item(page).focus(); await expect(menu(page).locator('#pcad-radial-hint')).toContainText('2つ');
  await page.keyboard.press('Escape');
  if (mode === 'mixed') {
    // The real tree path and then the real canvas path must both accept the same point owner.
    await tree(page, '点1').click({ modifiers: ['Control'] });
    await page.mouse.click(...a, { button: 'right' });
    await expect(item(page)).not.toHaveAttribute('aria-disabled', 'true'); await page.keyboard.press('Escape');
    await page.mouse.click(...a);
  }
  const modifier = mode === 'mixed' ? 'Control' : 'Shift';
  await page.mouse.move(...b); await page.keyboard.down(modifier); await page.mouse.click(...b);
  await page.mouse.click(...a, { button: 'right' }); await page.keyboard.up(modifier);
  await expect(item(page)).not.toHaveAttribute('aria-disabled', 'true');
  let token = await beginRecompute(page); await item(page).click(); await waitForRecompute(page, token);
  const connected = await savePart(page, info, `${mode}-connected.pcad`, app);
  const line = connected.sketches[0].features.find(feature => feature.kind === 'line');
  if (line?.kind !== 'line') throw new Error('参照線分が保存されていません。');
  expect(line.planeId).toBe('free');
  expect(connected.solids).toEqual(before.solids);
  expect(connected.sketches[0].features.filter(feature => feature.id !== line.id)).toEqual(before.sketches[0].features);
  for (const [coordinate, position, vertex] of [[line.from, first, mode !== 'planes'], [line.to, second, mode === 'vertices']] as const) {
    expect(coordinate).toMatchObject({ mode: 'relative', dx: { value: 0 }, dy: { value: 0 }, dz: { value: 0 } });
    if (coordinate.mode !== 'relative') throw new Error('相対参照ではありません。');
    expect(coordinate.base.kind).toBe(vertex ? 'subShape' : 'point');
    if (coordinate.base.kind === 'subShape') expect(coordinate.base.ref).toMatchObject({
      bodyFeatureId: connected.solids[0].id, fingerprint: { kind: 'vertex', position },
    });
  }
  await expectLiveLength(page, first, second);
  token = await beginRecompute(page); await canvas(page).focus(); await page.keyboard.press('Control+z');
  await waitForRecompute(page, token); expect(await savePart(page, info, `${mode}-undo.pcad`, app)).toEqual(before);
  token = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
  expect(await savePart(page, info, `${mode}-redo.pcad`, app)).toEqual(connected);
  let changedFirst: Vec3, changedSecond: Vec3;
  if (mode === 'planes') {
    await tree(page, '点1').click(); token = await beginRecompute(page);
    const x = page.locator('.pcad-panel--right .pcad-coordinate__fields input.pcad-field__input').first();
    await x.fill('7'); await x.press('Enter'); changedFirst = [7, 0, 0]; changedSecond = second;
  } else {
    await tree(page, '箱1').click();
    const sizeX = propertySection(page, uiMessage('propertyPanel', 'propertyPanel.sectionPrimitive')).locator('input.pcad-field__input').first();
    await expect(sizeX).toHaveValue('20'); token = await beginRecompute(page); await sizeX.fill('22'); await sizeX.press('Enter');
    changedFirst = [-11, -10, -10]; changedSecond = mode === 'vertices' ? [11, 10, 10] : second;
  }
  await waitForRecompute(page, token);
  await expectLiveLength(page, changedFirst, changedSecond);
  const changed = await savePart(page, info, `${mode}-changed.pcad`, app);
  expect(changed.sketches[0].features.find(feature => feature.id === line.id)).toEqual(line);
  // Reopen through the actual file UI and native Electron gateway, then observe the new result again.
  const path = info.outputPath(`${mode}-changed.pcad`);
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  token = await beginRecompute(page); await page.getByRole('button', { name: '開く', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecompute(page, token);
  expect(await savePart(page, info, `${mode}-reopened.pcad`, app)).toEqual(changed);
  await expectLiveLength(page, changedFirst, changedSecond);
}

export async function connectPointsFlow(page: Page, info: TestInfo, app?: ElectronApplication, spatial = false): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (spatial) {
    await page.getByRole('group', { name: '作図面', exact: true }).locator('.pcad-menu__trigger').first().click();
    await page.locator('.pcad-menu__panel[aria-label="作図面"]').getByRole('button', { name: '3D', exact: true }).click();
  }
  const positions: readonly Vec3[] = [[0, 0, 0], [30, 20, spatial ? 25 : 0]];
  for (const [index, position] of positions.entries()) {
    await createPoint(page, info, position, index + 1, app);
  }
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  const before = await savePart(page, info, 'connect-before.pcad', app);
  const first = await pointOnScreen(page, positions[0]), second = await pointOnScreen(page, positions[1]);
  const modifier = spatial ? 'Control' : 'Shift';
  await page.mouse.click(...first);
  await page.keyboard.down(modifier); await page.mouse.click(...second); await page.mouse.click(...second); await page.keyboard.up(modifier);
  await page.mouse.click(...first, { button: 'right' });
  await expect(item(page)).toHaveAttribute('aria-disabled', 'true');
  await item(page).focus(); await expect(menu(page).locator('#pcad-radial-hint')).toContainText('2つ');
  await page.keyboard.press('Escape');
  await page.keyboard.down(modifier); await page.mouse.click(...second);
  await page.mouse.click(...first, { button: 'right' }); await page.keyboard.up(modifier);
  await expect(item(page)).not.toHaveAttribute('aria-disabled', 'true');
  await captureManualDetail(page, info, { name: `connect-points-${spatial ? '3d' : '2d'}`, dialog: menu(page),
    fixture: before, script: new URL(import.meta.url) });
  const connectedToken = await beginRecompute(page);
  await item(page).click(); await waitForRecompute(page, connectedToken);
  await expect(tree(page, '線分1')).toBeVisible();
  const connected = await savePart(page, info, 'connected.pcad', app);
  const sketch = connected.sketches[0], line = sketch.features.find(feature => feature.kind === 'line');
  if (line?.kind !== 'line') throw new Error('線分がありません。');
  expect(sketch.features.filter(feature => feature.kind === 'point')).toEqual(before.sketches[0].features);
  expect(line.from).toMatchObject({ mode: 'relative', base: { kind: 'point', pointId: 'point-1' } });
  expect(line.to).toMatchObject({ mode: 'relative', base: { kind: 'point', pointId: 'point-2' } });
  expect(resolveSketch(sketch).segments[0]).toMatchObject({ from: positions[0], to: positions[1] });
  let token = await beginRecompute(page);
  await canvas(page).focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
  expect(await savePart(page, info, 'connect-undone.pcad', app)).toEqual(before);
  token = await beginRecompute(page);
  await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
  expect(await savePart(page, info, 'connect-redone.pcad', app)).toEqual(connected);

  await tree(page, '点1').click();
  const x = page.locator('.pcad-panel--right .pcad-coordinate__fields input.pcad-field__input').first();
  token = await beginRecompute(page); await x.fill('7*3'); await x.press('Enter'); await waitForRecompute(page, token);
  const changed = await savePart(page, info, 'connect-changed.pcad', app);
  expect(resolveSketch(changed.sketches[0]).segments[0]).toMatchObject({ from: [21, 0, 0], to: positions[1] });
  expect(changed.sketches[0].features.find(feature => feature.id === line.id)).toEqual(line);
  const path = info.outputPath('connect-changed.pcad');
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  token = await beginRecompute(page); await page.getByRole('button', { name: '開く', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecompute(page, token);
  expect(await savePart(page, info, 'connect-reopened.pcad', app)).toEqual(changed);

  // 125% and the actual Japanese explanation must fit, including the hint below the ring.
  await tree(page, '点1').click(); await tree(page, '点2').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '125%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const bounds = await canvas(page).boundingBox(); if (bounds === null) throw new Error('canvas');
  await page.mouse.click(bounds.x + bounds.width - 2, bounds.y + bounds.height - 2, { button: 'right' });
  await item(page).focus();
  const allBounds = await menu(page).evaluate(element => [element, ...Array.from(element.children)].map(child => {
    const rect = child.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }));
  for (const box of allBounds) {
    expect(box.left).toBeGreaterThanOrEqual(bounds.x - 1); expect(box.top).toBeGreaterThanOrEqual(bounds.y - 1);
    expect(box.right).toBeLessThanOrEqual(bounds.x + bounds.width + 1); expect(box.bottom).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  }
  await page.keyboard.press('Escape'); await canvas(page).focus(); await page.keyboard.press('Shift+F10');
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Tab'); await expect(item(page)).toBeFocused();
  token = await beginRecompute(page); await page.keyboard.press('Enter'); await waitForRecompute(page, token);
  await expect(tree(page, '線分2')).toBeVisible();
}
