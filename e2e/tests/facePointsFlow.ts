import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { resolveSketch, type CoordinateInput, type PartDocument, type SketchFaceFeature, type SketchLineFeature,
  type Vec3 } from '../../packages/model/src/index.js';
import { tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openTarget } from './electronAppFlow.js';
import { uiMessage } from './uiMessages.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { propertySection, propertyValue } from './measurementCaptureSupport.js';
import { createPoint, pointOnScreen } from './connectPointsFlow.js';

const menu = (page: Page) => page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
const faceItem = (page: Page) => menu(page).locator('[data-command-id="sketch.faceFromPoints"]');
const connectItem = (page: Page) => menu(page).locator('[data-command-id="sketch.connectPoints"]');
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const treeAlerts = (page: Page) => page.locator('.pcad-panel--left .pcad-tree__alert');

/** The new outline and face, read from the actually saved file. */
function createdFace(document: PartDocument, before: PartDocument): {
  readonly lines: readonly SketchLineFeature[]; readonly face: SketchFaceFeature;
} {
  const added = document.sketches[0].features.slice(before.sketches[0].features.length);
  const lines = added.filter((feature): feature is SketchLineFeature => feature.kind === 'line');
  const face = added.find((feature): feature is SketchFaceFeature => feature.kind === 'face');
  if (face === undefined) throw new Error('面が保存されていません。');
  expect(added).toEqual([...lines, face]);
  expect(face.boundary).toEqual(lines.map(line => ({ featureId: line.id })));
  expect(face.planeId).toBe(lines[0].planeId);
  for (const line of lines) {
    expect(line.planeId).toBe(face.planeId);
    for (const coordinate of [line.from, line.to]) {
      expect(coordinate).toMatchObject({ mode: 'relative', dx: { value: 0 }, dy: { value: 0 }, dz: { value: 0 } });
    }
  }
  // Each line starts where the previous one ends, and the last returns to the first.
  for (const [index, line] of lines.entries()) expect(line.to).toEqual(lines[(index + 1) % lines.length].from);
  return { lines, face };
}

function pointIdOf(coordinate: CoordinateInput): string {
  if (coordinate.mode !== 'relative' || coordinate.base.kind !== 'point') throw new Error('点の参照ではありません。');
  return coordinate.base.pointId;
}

function vertexOf(coordinate: CoordinateInput): Vec3 {
  if (coordinate.mode !== 'relative' || coordinate.base.kind !== 'subShape' || coordinate.base.ref.fingerprint.kind !== 'vertex') {
    throw new Error('頂点の参照ではありません。');
  }
  return coordinate.base.ref.fingerprint.position;
}

/** Actual UI/OCCT result: the first outline line's live length in the property panel. */
async function expectFirstLineLength(page: Page, from: Vec3, to: Vec3): Promise<void> {
  await tree(page, '線分1').click();
  const length = propertyValue(page, uiMessage('propertyPanel', 'propertyPanel.length'));
  await expect(length).toBeVisible();
  expect(Number(await length.textContent())).toBeCloseTo(Math.hypot(...from.map((value, axis) => value - to[axis])), 3);
}

async function reopen(page: Page, info: TestInfo, name: string, app?: ElectronApplication): Promise<void> {
  const path = info.outputPath(name);
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page); await page.getByRole('button', { name: '開く', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecompute(page, token);
}

async function undoRedo(page: Page, info: TestInfo, before: PartDocument, created: PartDocument, prefix: string,
  app?: ElectronApplication): Promise<void> {
  let token = await beginRecompute(page);
  await canvas(page).focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
  expect(await savePart(page, info, `${prefix}-undone.pcad`, app)).toEqual(before);
  token = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
  expect(await savePart(page, info, `${prefix}-redone.pcad`, app)).toEqual(created);
}

/**
 * Four sketch points on the XY plane. The selection order folds back along one line, so the face
 * is made in the corrected order. Then Undo/Redo, a coefficient edit, reopening, and a second face
 * from the tree selection and the keyboard menu (Shift+F10, Tab, Enter).
 */
export async function facePointsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const positions: readonly Vec3[] = [[0, 0, 0], [30, 0, 0], [60, 0, 0], [30, 20, 0]];
  for (const [index, position] of positions.entries()) await createPoint(page, info, position, index + 1, app);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  const before = await savePart(page, info, 'face-before.pcad', app);
  const [p1, p2, p3, p4] = await Promise.all(positions.map(position => pointOnScreen(page, position)));
  // Three points on one line: the menu offers the face in the connection's place, with the reason.
  await page.mouse.click(...p1);
  await page.keyboard.down('Shift'); await page.mouse.click(...p3); await page.mouse.click(...p2); await page.keyboard.up('Shift');
  await page.mouse.click(...p1, { button: 'right' });
  await expect(faceItem(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(connectItem(page)).toHaveCount(0);
  await faceItem(page).focus();
  await expect(menu(page).locator('#pcad-radial-hint')).toContainText(uiMessage('sketch', 'sketch.facePoints.collinear'));
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  // The fourth point leaves the line; holding Shift while right-clicking also opens the menu.
  await page.keyboard.down('Shift'); await page.mouse.click(...p4);
  await page.mouse.click(...p1, { button: 'right' }); await page.keyboard.up('Shift');
  await expect(faceItem(page)).not.toHaveAttribute('aria-disabled', 'true');
  let token = await beginRecompute(page);
  await faceItem(page).click(); await waitForRecompute(page, token);
  await expect(tree(page, '面1')).toBeVisible();
  await expect(page.locator('.pcad-statusbar')).toContainText(uiMessage('sketch', 'sketch.facePoints.createdReordered'));
  await expect(treeAlerts(page)).toHaveCount(0);
  const created = await savePart(page, info, 'face-created.pcad', app);
  const { lines, face } = createdFace(created, before);
  expect(created.sketches[0].features.slice(0, positions.length)).toEqual(before.sketches[0].features);
  expect(created.solids).toEqual(before.solids);
  expect(face.planeId).toBe('xy');
  expect(lines.map(line => [pointIdOf(line.from), pointIdOf(line.to)])).toEqual([
    ['point-1', 'point-2'], ['point-2', 'point-3'], ['point-3', 'point-4'], ['point-4', 'point-1']]);
  const resolved = resolveSketch(created.sketches[0]);
  expect(resolved.errors).toEqual([]);
  expect(resolved.faces).toHaveLength(1);
  expect(resolved.faces[0].curves).toMatchObject(positions.map((position, index) =>
    ({ kind: 'segment', from: position, to: positions[(index + 1) % positions.length] })));
  await expectFirstLineLength(page, positions[0], positions[1]);
  await undoRedo(page, info, before, created, 'face', app);

  // Coefficient edits move the corner; the saved references stay the same.
  await tree(page, '点1').click();
  const x = page.locator('.pcad-panel--right .pcad-coordinate__fields input.pcad-field__input').first();
  token = await beginRecompute(page); await x.fill('7*3'); await x.press('Enter'); await waitForRecompute(page, token);
  await expect(treeAlerts(page)).toHaveCount(0);
  const changed = await savePart(page, info, 'face-changed.pcad', app);
  expect(createdFace(changed, before)).toEqual({ lines, face });
  expect(resolveSketch(changed.sketches[0]).faces[0].curves[0]).toMatchObject({ from: [21, 0, 0], to: positions[1] });
  await expectFirstLineLength(page, [21, 0, 0], positions[1]);
  await reopen(page, info, 'face-changed.pcad', app);
  expect(await savePart(page, info, 'face-reopened.pcad', app)).toEqual(changed);
  await expect(tree(page, '面1')).toBeVisible();
  await expect(treeAlerts(page)).toHaveCount(0);

  // Tree selection and the keyboard menu make a second face from three of the points.
  await tree(page, '点1').click(); await tree(page, '点2').click({ modifiers: ['Shift'] });
  await tree(page, '点4').click({ modifiers: ['Shift'] });
  await canvas(page).focus(); await page.keyboard.press('Shift+F10');
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Tab'); await expect(faceItem(page)).toBeFocused();
  token = await beginRecompute(page); await page.keyboard.press('Enter'); await waitForRecompute(page, token);
  await expect(tree(page, '面2')).toBeVisible();
  await expect(treeAlerts(page)).toHaveCount(0);
  const second = createdFace(await savePart(page, info, 'face-second.pcad', app), changed);
  expect(second.lines.map(line => [pointIdOf(line.from), pointIdOf(line.to)])).toEqual([
    ['point-1', 'point-2'], ['point-2', 'point-4'], ['point-4', 'point-1']]);
}

const BOX: Readonly<Record<'a' | 'b' | 'c' | 'd' | 'e', Vec3>> = {
  a: [-10, -10, -10], b: [10, -10, -10], c: [10, 10, 10], d: [-10, 10, 10], e: [10, 10, -10],
};
const edgeKey = (from: Vec3, to: Vec3): string => [from, to].map(position => position.join(',')).sort().join(' / ');

/**
 * Four box vertices on a slanted plane, chosen with Ctrl in a crossing order, after refusing a
 * selection that does not lie on one plane. The face follows a change of the box size and reopens.
 */
export async function faceVerticesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '作る', '箱');
  let token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
  await waitForRecompute(page, token); await expect(tree(page, '箱1')).toBeVisible();
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  await canvas(page).focus(); await page.keyboard.press('1');
  await expect(page.locator('.pcad-statusbar__state').first()).toContainText('頂点');
  const before = await savePart(page, info, 'face-vertices-before.pcad', app);
  const a = await pointOnScreen(page, BOX.a), b = await pointOnScreen(page, BOX.b);
  const c = await pointOnScreen(page, BOX.c), d = await pointOnScreen(page, BOX.d), e = await pointOnScreen(page, BOX.e);
  await page.mouse.move(...a); await page.mouse.click(...a);
  await page.keyboard.down('Control');
  await page.mouse.click(...c); await page.mouse.click(...b); await page.mouse.click(...e);
  await page.keyboard.up('Control');
  await page.mouse.click(...a, { button: 'right' });
  await expect(faceItem(page)).toHaveAttribute('aria-disabled', 'true');
  await faceItem(page).focus();
  await expect(menu(page).locator('#pcad-radial-hint')).toContainText(uiMessage('sketch', 'sketch.facePoints.notPlanar'));
  await page.keyboard.press('Escape');
  await page.keyboard.down('Control');
  await page.mouse.click(...e); await page.mouse.click(...d);
  await page.mouse.click(...a, { button: 'right' }); await page.keyboard.up('Control');
  await expect(faceItem(page)).not.toHaveAttribute('aria-disabled', 'true');
  token = await beginRecompute(page); await faceItem(page).click(); await waitForRecompute(page, token);
  await expect(tree(page, '面1')).toBeVisible();
  await expect(treeAlerts(page)).toHaveCount(0);
  const created = await savePart(page, info, 'face-vertices-created.pcad', app);
  expect(created.solids).toEqual(before.solids);
  const { lines, face } = createdFace(created, before);
  expect(face.planeId).toBe('free');
  for (const line of lines) {
    expect(line.from).toMatchObject({ base: { kind: 'subShape', ref: { bodyFeatureId: created.solids[0].id } } });
  }
  expect(vertexOf(lines[0].from)).toEqual(BOX.a);
  expect(lines.map(line => edgeKey(vertexOf(line.from), vertexOf(line.to))).sort())
    .toEqual([[BOX.a, BOX.b], [BOX.b, BOX.c], [BOX.c, BOX.d], [BOX.d, BOX.a]].map(([from, to]) => edgeKey(from, to)).sort());
  const firstTo = vertexOf(lines[0].to);
  await expectFirstLineLength(page, BOX.a, firstTo);
  await undoRedo(page, info, before, created, 'face-vertices', app);

  // A wider box moves every corner; the slanted outline stays on one plane and follows.
  await tree(page, '箱1').click();
  const sizeX = propertySection(page, uiMessage('propertyPanel', 'propertyPanel.sectionPrimitive')).locator('input.pcad-field__input').first();
  await expect(sizeX).toHaveValue('20'); token = await beginRecompute(page); await sizeX.fill('22'); await sizeX.press('Enter');
  await waitForRecompute(page, token);
  await expect(treeAlerts(page)).toHaveCount(0);
  const wider = (position: Vec3): Vec3 => [position[0] * 1.1, position[1], position[2]];
  await expectFirstLineLength(page, wider(BOX.a), wider(firstTo));
  const changed = await savePart(page, info, 'face-vertices-changed.pcad', app);
  expect(createdFace(changed, before)).toEqual({ lines, face });
  await reopen(page, info, 'face-vertices-changed.pcad', app);
  expect(await savePart(page, info, 'face-vertices-reopened.pcad', app)).toEqual(changed);
  await expect(treeAlerts(page)).toHaveCount(0);
  await expectFirstLineLength(page, wider(BOX.a), wider(firstTo));
}
