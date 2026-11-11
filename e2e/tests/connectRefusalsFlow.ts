import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { absoluteCoordinate, appendFeature, createEmptyPartDocument, createPointFeature, nextFeatureId, nextFeatureName,
  replaceSketch, type PartDocument, type SketchDocument } from '../../packages/model/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute, waitForRecomputeOutcome } from './recompute.js';
import { openTarget } from './electronAppFlow.js';
import { reopenPart } from './reopenPart.js';
import { uiMessage } from './uiMessages.js';

const menu = (page: Page) => page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
const commandItem = (page: Page, id: string) => menu(page).locator(`[data-command-id="${id}"]`);
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const hint = (page: Page) => menu(page).locator('#pcad-radial-hint');
const CONNECT = 'sketch.connectPoints';
const FACE = 'sketch.faceFromPoints';
const connectCount = (count: number) => uiMessage('sketch', 'sketch.connect.count').replace('{count}', String(count));
const faceCount = (count: number) => uiMessage('sketch', 'sketch.facePoints.count').replace('{count}', String(count));
const sketchText = (key: string) => uiMessage('sketch', key);

function withPoints(positions: readonly (readonly [number, number, number])[]): SketchDocument {
  let sketch = createEmptyPartDocument().sketches[0];
  for (const position of positions) sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(...position), 'xy'));
  return sketch;
}

/** 点1 and 点3 share a position; 線分1 is not a point. */
function refusalFixture(): PartDocument {
  let sketch = withPoints([[0, 0, 0], [30, 20, 0], [0, 0, 0], [60, 0, 0]]);
  sketch = appendFeature(sketch, { id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'), kind: 'line',
    planeId: 'xy', from: absoluteCoordinate(40, -20, 0), to: absoluteCoordinate(70, -20, 0), construction: false });
  return replaceSketch(createEmptyPartDocument(), sketch);
}

/** 点2 refers to a point that does not exist, so its current position cannot be resolved. */
function unresolvedFixture(): PartDocument {
  let sketch = withPoints([[0, 0, 0]]);
  const zero = expressionValueFromNumber(0);
  sketch = appendFeature(sketch, createPointFeature(sketch,
    { mode: 'relative', base: { kind: 'point', pointId: 'point-9' }, dx: zero, dy: zero, dz: zero }, 'xy'));
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(30, 20, 0), 'xy'));
  return replaceSketch(createEmptyPartDocument(), sketch);
}

/** Tree selection: the first item replaces the selection, the rest are added with Ctrl. */
async function choose(page: Page, names: readonly string[]): Promise<void> {
  for (const [index, name] of names.entries()) {
    await tree(page, name).click(index === 0 ? undefined : { modifiers: ['Control'] });
  }
}

async function openByKey(page: Page, key: 'Shift+F10' | 'ContextMenu'): Promise<void> {
  await canvas(page).focus(); await page.keyboard.press(key);
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
}

/** The disabled item explains the count and the reason; activating it changes nothing. */
async function expectRefused(page: Page, id: string, count: string, reason: string, key: 'Shift+F10' | 'ContextMenu'): Promise<void> {
  await openByKey(page, key);
  const item = commandItem(page, id);
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Tab'); await expect(item).toBeFocused();
  await expect(hint(page)).toContainText(count); await expect(hint(page)).toContainText(reason);
  await page.keyboard.press('Enter');
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('.pcad-statusbar')).toContainText(reason);
}

async function rememberView(page: Page, name: string): Promise<void> {
  const views = page.locator('.pcad-named-views');
  await views.locator('summary').click();
  await views.getByRole('textbox', { name: uiMessage('view', 'view.named.name'), exact: true }).fill(name);
  await views.getByRole('button', { name: uiMessage('view', 'view.named.save'), exact: true }).click();
  await expect(views.getByRole('option', { name, exact: true })).toHaveCount(1);
  await views.locator('summary').click();
}

/** A right drag of 100 pixels from an empty place pans the view and never opens or runs the menu. */
async function rightDrag(page: Page, start: { readonly x: number; readonly y: number }): Promise<void> {
  await page.mouse.move(start.x, start.y); await page.mouse.down({ button: 'right' });
  await page.mouse.move(start.x + 100, start.y, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await expect(menu(page)).toHaveCount(0);
}

async function emptyPlace(page: Page): Promise<{ readonly x: number; readonly y: number }> {
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error('作図画面がありません。');
  return { x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.25 };
}

/** Ctrl+O, also while the radial menu is open. A file with an unresolved point finishes as failed. */
async function openWithKey(page: Page, path: string, outcome: 'success' | 'failed', app?: ElectronApplication): Promise<void> {
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page); await page.keyboard.press('Control+o');
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecomputeOutcome(page, token, outcome);
}

const menuItems = (locator: Locator) => locator.getByRole('menuitem');

/**
 * R29/R30 refusals in the real UI: the seven invalid classes, a 100-pixel right drag, ordinary
 * selection, cancel, text entry and IME composition, the menu key and Shift+F10, and switching
 * documents. None of them runs an earlier selection; the saved document stays the same.
 */
export async function connectRefusalsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await writeFile(info.outputPath('refusals.pcad'), writePcadFile(refusalFixture()), { flag: 'wx' });
  await writeFile(info.outputPath('refusals-same-ids.pcad'), writePcadFile(replaceSketch(createEmptyPartDocument(),
    withPoints([[5, 5, 0], [25, 5, 0], [5, 25, 0]]))), { flag: 'wx' });
  await writeFile(info.outputPath('refusals-unresolved.pcad'), writePcadFile(unresolvedFixture()), { flag: 'wx' });
  await reopenPart(page, info, 'refusals.pcad', app);
  await expect(tree(page, '線分1')).toBeVisible();
  const before = await savePart(page, info, 'refusals-before.pcad', app);

  // 0 points: the menu offers the ordinary line tool, not an operation on points.
  await openByKey(page, 'Shift+F10');
  await expect(menuItems(menu(page))).toHaveCount(8);
  await expect(menu(page).locator('[data-radial-slot="1"]')).toHaveAttribute('data-command-id', 'toolbar.sketch.line');
  await expect(commandItem(page, CONNECT)).toHaveCount(0); await expect(commandItem(page, FACE)).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0);
  // 1 point, and the same point chosen again (the second choice removes it).
  await choose(page, ['点1']);
  await expectRefused(page, CONNECT, connectCount(1), sketchText('sketch.connect.selectTwo'), 'ContextMenu');
  await tree(page, '点1').click({ modifiers: ['Control'] });
  await openByKey(page, 'Shift+F10');
  await expect(commandItem(page, CONNECT)).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Two points at the same coordinates, and a point with a line.
  await choose(page, ['点1', '点3']);
  await expectRefused(page, CONNECT, connectCount(2), sketchText('sketch.connect.samePoint'), 'Shift+F10');
  await choose(page, ['点1', '線分1']);
  await expectRefused(page, CONNECT, connectCount(1), sketchText('sketch.connect.pointFeaturesOnly'), 'ContextMenu');
  // Three points offer the face in the connection's place; the face has the same refusals.
  await choose(page, ['点1', '点2', '点4']);
  await openByKey(page, 'Shift+F10');
  await expect(commandItem(page, CONNECT)).toHaveCount(0);
  await expect(commandItem(page, FACE)).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await choose(page, ['点1', '点3', '点2']);
  await expectRefused(page, FACE, faceCount(3), sketchText('sketch.facePoints.samePoint'), 'Shift+F10');
  await choose(page, ['点1', '点2', '線分1']);
  await expectRefused(page, FACE, faceCount(2), sketchText('sketch.facePoints.pointFeaturesOnly'), 'ContextMenu');

  // A 100-pixel right drag with a usable selection pans the view and creates nothing.
  await rememberView(page, 'before-drag');
  const place = await emptyPlace(page);
  await choose(page, ['点1', '点2']);
  await rightDrag(page, place);
  await choose(page, ['点1', '点2', '点4']);
  await rightDrag(page, { x: place.x + 100, y: place.y });
  await rememberView(page, 'after-drag');

  // Ordinary selection, cancel, text entry and IME composition do not run the earlier selection.
  await choose(page, ['点1', '点2']);
  await page.mouse.click(place.x, place.y, { button: 'right' });
  await expect(commandItem(page, CONNECT)).not.toHaveAttribute('aria-disabled', 'true');
  // A click outside the open menu only closes it; the next ordinary click replaces the selection.
  await tree(page, '点4').click();
  await expect(menu(page)).toHaveCount(0);
  await tree(page, '点4').click();
  await expectRefused(page, CONNECT, connectCount(1), sketchText('sketch.connect.selectTwo'), 'Shift+F10');
  await choose(page, ['点1', '点2']);
  await page.mouse.click(place.x, place.y, { button: 'right' });
  await expect(commandItem(page, CONNECT)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  const line = page.locator('#pcad-command-line-input');
  await line.click(); await line.fill('ab'); await line.press('Shift+F10'); await line.press('ContextMenu');
  await expect(menu(page)).toHaveCount(0);
  await line.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
  });
  await line.fill(''); await line.press('Escape');
  await canvas(page).focus();
  await canvas(page).dispatchEvent('keydown', { key: 'ContextMenu', isComposing: true, bubbles: true, cancelable: true });
  await canvas(page).dispatchEvent('keydown', { key: 'F10', shiftKey: true, isComposing: true, bubbles: true, cancelable: true });
  await expect(menu(page)).toHaveCount(0);
  await expect(tree(page, '線分2')).toHaveCount(0); await expect(tree(page, '面1')).toHaveCount(0);
  const unchanged = await savePart(page, info, 'refusals-unchanged.pcad', app);
  expect(unchanged.sketches).toEqual(before.sketches);
  expect(unchanged.solids).toEqual(before.solids);
  const view = (name: string) => {
    const found = unchanged.namedViews.find(candidate => candidate.name === name);
    if (found === undefined) throw new Error(`保存した視点がありません: ${name}`);
    return found;
  };
  expect(view('after-drag').target).not.toEqual(view('before-drag').target);

  // The valid selection still works from the menu key: one line, and one Undo restores the document.
  await choose(page, ['点1', '点2']);
  await openByKey(page, 'ContextMenu');
  await page.keyboard.press('Tab'); await expect(commandItem(page, CONNECT)).toBeFocused();
  await expect(hint(page)).toContainText(connectCount(2));
  let token = await beginRecompute(page); await page.keyboard.press('Enter'); await waitForRecompute(page, token);
  await expect(tree(page, '線分2')).toBeVisible();
  token = await beginRecompute(page); await canvas(page).focus(); await page.keyboard.press('Control+z');
  await waitForRecompute(page, token);
  expect((await savePart(page, info, 'refusals-undone.pcad', app)).sketches).toEqual(before.sketches);

  // Switching documents with the menu open closes the menu. The next document has points with the
  // same IDs; opening it starts a new selection and history (2026-10-05), so the earlier selection
  // is empty, the menu offers no operation on points, and Undo does not bring back the earlier document.
  await choose(page, ['点1', '点2']);
  await page.mouse.click(place.x, place.y, { button: 'right' });
  await expect(commandItem(page, CONNECT)).not.toHaveAttribute('aria-disabled', 'true');
  await openWithKey(page, info.outputPath('refusals-same-ids.pcad'), 'success', app);
  await expect(menu(page)).toHaveCount(0);
  await expect(tree(page, '点4')).toHaveCount(0); await expect(tree(page, '点3')).toBeVisible();
  await expect(tree(page, '点1')).toHaveAttribute('aria-pressed', 'false');
  await expect(tree(page, '点2')).toHaveAttribute('aria-pressed', 'false');
  const undoButton = page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true });
  await expect(undoButton).toBeDisabled();
  const other = await savePart(page, info, 'refusals-same-ids-before.pcad', app);
  await openByKey(page, 'ContextMenu');
  await expect(menuItems(menu(page))).toHaveCount(8);
  await expect(commandItem(page, CONNECT)).toHaveCount(0); await expect(commandItem(page, FACE)).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0);
  await canvas(page).focus(); await page.keyboard.press('Control+z'); await expect(undoButton).toBeDisabled();
  expect(await savePart(page, info, 'refusals-same-ids-after.pcad', app)).toEqual(other);
  // An unresolved point is refused by both operations.
  await openWithKey(page, info.outputPath('refusals-unresolved.pcad'), 'failed', app);
  const unresolved = await savePart(page, info, 'refusals-unresolved-before.pcad', app);
  await choose(page, ['点1', '点2']);
  await expectRefused(page, CONNECT, connectCount(2), sketchText('sketch.connect.unresolved'), 'Shift+F10');
  await choose(page, ['点1', '点2', '点3']);
  await expectRefused(page, FACE, faceCount(3), sketchText('sketch.connect.unresolved'), 'ContextMenu');
  expect(await savePart(page, info, 'refusals-unresolved-after.pcad', app)).toEqual(unresolved);
}
