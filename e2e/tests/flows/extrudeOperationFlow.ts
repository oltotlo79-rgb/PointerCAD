/// <reference lib="dom" />
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../../packages/io/src/index.js';
import { openToolMenu, toolMenuPanel } from '../assemblyTestSupport.js';
import { drawRectangle, extrudeFace, fillFields, makeFace, popover, popoverInputs,
  popoverTitle, propertyPanel, treeRow } from '../solidCaptureSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from '../recompute.js';
import { openSaveFlowFile, saveFlowFile } from '../saveResponsivenessFlow.js';
import { waitForStartupHealth } from '../startupHealth.js';
import { readViewportRenderStats } from '../viewportRenderStats.js';
import { captureManualDetail } from '../captureManualDetail.js';

export type ExtrudeOperation = 'new' | 'join' | 'cut';
const LABELS = { new: '新しい立体', join: '結合', cut: '切り抜き' } as const;
const READY = '計算した形を表示しています。この形で確定するには「決定」を押します。';

function solidRows(page: Page) {
  return page.locator('.pcad-panel--left .pcad-tree__sections > li').filter({ hasText: 'ソリッド' })
    .locator('.pcad-tree__children > li');
}

async function framedBodies(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const read = window.pcadViewportFramedBodies;
    if (read === undefined) throw new Error('Actual admitted viewport body observation missing');
    return [...read()].sort();
  });
}

async function geometry(page: Page, name: string, volume: number): Promise<void> {
  await treeRow(page, name).click();
  const value = (key: string) => propertyPanel(page).locator('dt.pcad-properties__key')
    .filter({ hasText: new RegExp(`^${key}$`, 'u') }).locator('xpath=following-sibling::dd[1]');
  await expect(value('体積')).toHaveText(`${String(volume)} mm³`, { timeout: KERNEL_TIMEOUT_MS });
  await expect.poll(async () => Number(await value('三角形の数').innerText()),
    { timeout: KERNEL_TIMEOUT_MS, message: 'Actual OCCT result has rendered triangles' }).toBeGreaterThan(0);
  await expect.poll(async () => (await framedBodies(page)).length,
    { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
}

async function stored(page: Page, info: TestInfo, name: string, app?: ElectronApplication) {
  const bytes = await saveFlowFile(page, info.outputPath(`${name}.pcad`), app);
  const parsed = readPcadFile(bytes);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.document;
}

async function fixture(page: Page, info: TestInfo, operation: ExtrudeOperation): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await drawRectangle(page, ['0', '0'], ['20', '20']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '20');
  await waitForRecompute(page);
  await geometry(page, '押し出し1', 8000);
  // Lift only the join profile above the base sketch; the solids still overlap by 500 mm³.
  await drawRectangle(page, operation === 'join' ? ['15', '5'] : ['5', '5'], ['10', '10'],
    operation === 'join' ? '5' : '0');
  await makeFace(page, ['線分5', '線分6', '線分7', '線分8']);
  await waitForRecompute(page);
  await expect(treeRow(page, '面2')).toBeVisible();
}

async function openExtrusion(page: Page, operation: ExtrudeOperation): Promise<void> {
  await treeRow(page, '面2').click();
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '押し出し', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await fillFields(page, ['10']);
  const choices = popover(page).getByRole('group', { name: '押し出しの結果', exact: true });
  await expect(choices.getByRole('button')).toHaveText(['新しい立体', '結合', '切り抜き']);
  await choices.getByRole('button', { name: LABELS[operation], exact: true }).click();
  await expect(choices.getByRole('button', { name: LABELS[operation], exact: true })).toHaveAttribute('aria-pressed', 'true');
  if (operation !== 'new') {
    // No implicit first-body target: the actual commit is refused until the user chooses.
    await popoverInputs(page).first().press('Enter');
    await expect(popover(page)).toBeVisible();
    await expect(page.locator('.pcad-statusbar__text')).toContainText('対象となる立体を選んでください');
    const target = popover(page).locator('.pcad-popover__choice').filter({ hasText: '対象の立体' });
    await target.getByRole('button', { name: '対象を選んでください', exact: true }).click();
    await target.getByRole('menuitem', { name: '押し出し1', exact: true }).click();
    await expect(target.getByRole('button', { name: '押し出し1', exact: true })).toBeVisible();
  }
}

async function preview(page: Page, expectedCount: number): Promise<readonly string[]> {
  const original = await framedBodies(page);
  const render = await readViewportRenderStats(page);
  await popover(page).getByRole('button', { name: '形を確かめる', exact: true }).click();
  await expect(popover(page).getByRole('status')).toHaveText(READY, { timeout: KERNEL_TIMEOUT_MS });
  await expect.poll(() => framedBodies(page), { timeout: KERNEL_TIMEOUT_MS }).not.toEqual(original);
  await expect.poll(async () => (await framedBodies(page)).length).toBe(expectedCount);
  await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders).toBeGreaterThan(render.completedRenders);
  return original;
}

/** Real title drag stays inside the clipped CAD viewport (draggableWindowLayout's 8px inset). */
async function framePreviewForCapture(page: Page, operation: 'join' | 'cut'): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const panel = popover(page), title = panel.locator('.pcad-window-title').first();
  const view = await canvas.boundingBox(), window = await panel.boundingBox(), heading = await title.boundingBox();
  if (view === null || window === null || heading === null) throw new Error('Preview capture rectangles are missing');
  // Keep the whole central/right two-thirds free for the model; Root judges actual image readability.
  const protectedLeft = view.x + view.width / 3;
  const target = { x: view.x + 8, y: view.y + 8 };
  expect(target.x + window.width).toBeLessThanOrEqual(protectedLeft);
  expect(target.y + window.height).toBeLessThanOrEqual(view.y + view.height - 8);
  await expect(title).toHaveCSS('cursor', 'grab');
  const grab = { x: heading.x + 16, y: heading.y + heading.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  try {
    await page.mouse.move(grab.x + target.x - window.x, grab.y + target.y - window.y, { steps: 8 });
  } finally { await page.mouse.up(); }
  await expect(title).toHaveCSS('cursor', 'grab');
  const previewBodies = await framedBodies(page);
  expect(previewBodies.length).toBeGreaterThan(0);
  // Existing camera-control flows use real wheel input. No camera/DOM state is injected.
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  for (let notch = 0; notch < 2; notch += 1) {
    const rendered = await readViewportRenderStats(page);
    await page.mouse.wheel(0, -300);
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
      .toBeGreaterThan(rendered.completedRenders);
  }
  if (operation === 'cut') {
    // The actual cut opens at z=0: tilt the real view cube below the base to expose that cavity.
    // cameraMath.orbit adds vertical pointer movement to elevation; an upward drag lowers the view.
    const cube = page.locator('canvas.pcad-viewcube'), bounds = await cube.boundingBox();
    if (bounds === null) throw new Error('View cube missing for the underside cut preview');
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const rendered = await readViewportRenderStats(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x, Math.max(1, y - 145), { steps: 8 });
      await expect(cube).toHaveAttribute('data-interaction', 'dragging');
    } finally { await page.mouse.up(); }
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
      .toBeGreaterThan(rendered.completedRenders);
  }
  await expect.poll(async () => {
    const currentView = await canvas.boundingBox(), currentWindow = await panel.boundingBox();
    if (currentView === null || currentWindow === null) return false;
    return currentWindow.x >= currentView.x && currentWindow.y >= currentView.y
      && currentWindow.x + currentWindow.width <= currentView.x + currentView.width / 3
      && currentWindow.y + currentWindow.height <= currentView.y + currentView.height;
  }, 'The real preview window is inside the viewport and outside the central model display area').toBe(true);
  await expect(panel.getByRole('status')).toHaveText(READY);
  expect(await framedBodies(page), 'Framing must retain the actual preview bodies').toEqual(previewBodies);
}

/** Actual UI + OCCT, with preview bytes/history separated from one atomic commit. */
export async function extrudeOperationFlow(page: Page, info: TestInfo, operation: ExtrudeOperation,
  app?: ElectronApplication): Promise<void> {
  await fixture(page, info, operation);
  const before = await stored(page, info, `${operation}-before`, app);
  const beforeRows = await solidRows(page).allTextContents();
  await openExtrusion(page, operation);
  const baseline = await preview(page, operation === 'new' ? 2 : 1);
  await expect(solidRows(page)).toHaveText(beforeRows);
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => framedBodies(page)).toEqual(baseline);
  expect(await stored(page, info, `${operation}-cancelled`, app), 'Preview/cancel never changes serialized document').toEqual(before);
  const cancelUndo = await beginRecompute(page);
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, cancelUndo);
  await expect(treeRow(page, '面2'), 'Cancel added no Undo entry; the prior face is removed immediately').toHaveCount(0);
  await geometry(page, '押し出し1', 8000);
  const cancelRedo = await beginRecompute(page);
  await page.keyboard.press('Control+y');
  await waitForRecompute(page, cancelRedo);
  await expect(treeRow(page, '面2')).toBeVisible();
  expect(await stored(page, info, `${operation}-cancel-redo`, app)).toEqual(before);

  await openExtrusion(page, operation);
  await preview(page, operation === 'new' ? 2 : 1);
  if (operation !== 'new') await framePreviewForCapture(page, operation);
  if (operation === 'join') {
    await captureManualDetail(page, info, { name: 'solid-basics-join-preview', dialog: popover(page),
      fixture: { operation, before }, script: new URL(import.meta.url) });
  }
  if (operation === 'cut') {
    await captureManualDetail(page, info, { name: 'solid-basics-cut-preview', dialog: popover(page),
      fixture: { operation, before }, script: new URL(import.meta.url) });
  }
  await popoverInputs(page).first().press('Enter');
  await expect(popover(page)).toHaveCount(0, { timeout: KERNEL_TIMEOUT_MS });
  const result = operation === 'new' ? '押し出し2' : operation === 'join' ? '和1' : '差1';
  const volume = operation === 'new' ? 1000 : operation === 'join' ? 8500 : 7000;
  await geometry(page, result, volume);
  const committed = await stored(page, info, `${operation}-committed`, app);
  expect(committed.solids.length - before.solids.length).toBe(operation === 'new' ? 1 : 2);
  const added = committed.solids.slice(before.solids.length);
  const extrusion = added[0];
  if (extrusion?.kind !== 'extrude') throw new Error('Committed extrusion feature missing');
  expect(extrusion.distance.source).toBe('10');
  expect(committed.solids.slice(0, before.solids.length)).toEqual(before.solids);
  if (operation !== 'new') {
    const combined = added[1];
    if (combined?.kind !== 'boolean') throw new Error('Atomic Boolean feature missing');
    expect(combined.operation).toBe(operation === 'join' ? 'union' : 'subtract');
    expect(combined.targetFeatureId).toBe(before.solids[0]?.id);
    expect(combined.toolFeatureId).toBe(extrusion.id);
  }
  const token = await beginRecompute(page);
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, token);
  await expect(solidRows(page)).toHaveText(beforeRows);
  expect(await stored(page, info, `${operation}-one-undo`, app), 'One Undo removes both Boolean and temporary extrusion').toEqual(before);
  const redo = await beginRecompute(page);
  await page.keyboard.press('Control+y');
  await waitForRecompute(page, redo);
  await geometry(page, result, volume);
  expect(await stored(page, info, `${operation}-redo`, app)).toEqual(committed);
  await openSaveFlowFile(page, info.outputPath(`${operation}-committed.pcad`), app);
  await geometry(page, result, volume);
  expect(await stored(page, info, `${operation}-reopened`, app)).toEqual(committed);
}

/** Remove the explicitly chosen live target through its ordinary tree Delete action. */
export async function extrudeStaleTargetFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await fixture(page, info, 'cut');
  await openExtrusion(page, 'cut');
  await preview(page, 1);
  await treeRow(page, '押し出し1').press('Delete');
  await expect(treeRow(page, '押し出し1')).toHaveCount(0);
  await waitForRecompute(page);
  await expect(popover(page)).toBeVisible();
  const rows = await solidRows(page).allTextContents();
  await popoverInputs(page).first().press('Enter');
  await expect(popover(page)).toBeVisible();
  await expect(page.locator('.pcad-statusbar__text')).toContainText('対象の立体が見つからないか');
  await expect(solidRows(page)).toHaveText(rows);
  await expect(treeRow(page, '押し出し2')).toHaveCount(0);
  await expect(treeRow(page, '差1')).toHaveCount(0);
  await popoverInputs(page).first().press('Escape');
  const refused = await stored(page, info, 'stale-refused', app);
  expect(refused.solids).toHaveLength(0);
  const undo = await beginRecompute(page);
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, undo);
  await geometry(page, '押し出し1', 8000);
  expect((await stored(page, info, 'stale-one-undo', app)).solids).toHaveLength(1);
}
