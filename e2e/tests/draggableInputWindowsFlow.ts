import { expect, type Locator, type Page } from '@playwright/test';
import { waitForMathEditorText } from './mathEditorReady.js';
import { chooseSketchTool } from './sketchDrawCaptureSupport.js';

async function rectangle(locator: Locator) {
  await expect(locator).toBeVisible();
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error('入力の窓の位置を取得できません。');
  return rect;
}

async function dragHeading(page: Page, panel: Locator, dx: number, dy: number): Promise<void> {
  const title = panel.locator('.pcad-window-title').first();
  const start = await rectangle(title);
  await expect(title).toHaveCSS('cursor', 'grab');
  await expect(title).toHaveCSS('touch-action', 'none');
  const x = start.x + 16, y = start.y + start.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await expect(title).toHaveCSS('cursor', 'grabbing');
  // Real Electron cannot receive a mouse event beyond its content window (rules/06 §10.157).
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.move(Math.max(1, Math.min(view.width - 1, x + dx)), Math.max(1, Math.min(view.height - 1, y + dy)), { steps: 8 });
  await page.mouse.up();
  await expect(title).toHaveCSS('cursor', 'grab');
}

async function expectContained(panel: Locator): Promise<void> {
  await expect.poll(() => panel.evaluate(element => {
    const box = element.getBoundingClientRect();
    const parent = getComputedStyle(element).position === 'fixed' ? null : element instanceof HTMLElement ? element.offsetParent : null;
    const container = parent !== null && parent !== document.body ? parent.getBoundingClientRect() : null;
    return box.left >= Math.max(0, container?.left ?? 0) + 7
      && box.top >= Math.max(0, container?.top ?? 0) + 7
      && box.right <= Math.min(innerWidth, container?.right ?? innerWidth) - 7
      && box.bottom <= Math.min(innerHeight, container?.bottom ?? innerHeight) - 7;
  }), '入力の窓の四辺が画面と作図領域の内側にある').toBe(true);
}

const sketchTool = (page: Page, name: string) => page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name, exact: true });
const panelFor = (page: Page) => page.locator('.pcad-popover[role="dialog"]').filter({ has: page.locator('.pcad-popover__fields') });

/** Real point/line forms, click placement, retained focus, keyboard commit and the stored expression. */
export async function draggableCoordinatesFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await sketchTool(page, '点').click();
  const viewport = page.locator('canvas.pcad-viewport__canvas');
  // A viewport click supplies the initial coordinates and the local anchor.
  await viewport.click({ position: { x: 80, y: 90 } });
  const panel = panelFor(page), inputs = panel.locator('input.pcad-field__input');
  await inputs.nth(0).fill('12'); await inputs.nth(1).fill('3*4'); await inputs.nth(2).fill('0');
  await inputs.nth(0).focus();
  const original = await rectangle(panel);
  await dragHeading(page, panel, 100, 60);
  const moved = await rectangle(panel);
  expect(moved.x - original.x).toBeCloseTo(100, 0); expect(moved.y - original.y).toBeCloseTo(60, 0);
  await expect(inputs.nth(0)).toBeFocused();
  await expect(inputs.nth(0)).toHaveValue('12'); await expect(inputs.nth(1)).toHaveValue('3*4');
  await page.keyboard.press('Tab'); await expect(inputs.nth(1)).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(inputs.nth(0)).toBeFocused();

  // A text-selection drag must retain normal input behaviour and leave the window in place.
  const field = await rectangle(inputs.nth(0));
  await page.mouse.move(field.x + 5, field.y + field.height / 2); await page.mouse.down();
  await page.mouse.move(field.x + field.width - 5, field.y + field.height / 2); await page.mouse.up();
  const afterSelection = await rectangle(panel);
  expect(afterSelection.x).toBeCloseTo(moved.x, 1); expect(afterSelection.y).toBeCloseTo(moved.y, 1);
  await inputs.nth(0).press('Enter');
  const tree = page.locator('.pcad-panel--left');
  await expect(tree.getByRole('button', { name: '点1', exact: true })).toBeVisible();
  await inputs.nth(0).press('Escape'); await expect(panel).toHaveCount(0);
  await tree.getByRole('button', { name: '点1', exact: true }).click();
  await expect(page.locator('.pcad-panel--right input.pcad-field__input').nth(0)).toHaveValue('12');
  await expect(page.locator('.pcad-panel--right input.pcad-field__input').nth(1)).toHaveValue('3*4');

  // Reopen by the same click: the previous drag is not a persistent preference.
  // Escape closes the input but leaves the tool active; select it through the shared reset path.
  await chooseSketchTool(page, '点');
  await expect(sketchTool(page, '点')).toHaveAttribute('aria-pressed', 'true');
  await viewport.click({ position: { x: 80, y: 90 } });
  const reopened = await rectangle(panel);
  expect(reopened.x).toBeCloseTo(original.x, 1); expect(reopened.y).toBeCloseTo(original.y, 1);
  await inputs.nth(0).press('Escape');
  await sketchTool(page, '線分').click(); await viewport.click({ position: { x: 80, y: 90 } });
  await expect(panel.locator('.pcad-popover__title')).toHaveText('線分の始点');
  for (const input of await inputs.all()) await input.fill('0');
  await inputs.nth(0).focus();
  await dragHeading(page, panel, 100, 40);
  const lineStart = await rectangle(panel);
  await page.keyboard.press('Enter');
  await expect(panel.locator('.pcad-popover__title')).toHaveText('線分の終点');
  const lineEnd = await rectangle(panel);
  expect(lineEnd.x).toBeCloseTo(lineStart.x, 1); expect(lineEnd.y).toBeCloseTo(lineStart.y, 1);
  await inputs.nth(0).fill('25'); await inputs.nth(1).fill('0'); await inputs.nth(2).fill('0');
  await inputs.nth(0).press('Enter');
  await expect(tree.getByRole('button', { name: '線分1', exact: true })).toBeVisible();
  await inputs.nth(0).press('Escape');
}

export async function draggableWindowBoundsFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await sketchTool(page, '点').click();
  const panel = panelFor(page), inputs = panel.locator('input.pcad-field__input');
  await dragHeading(page, panel, 2000, 2000); await expectContained(panel);
  const beforeError = await rectangle(panel);
  await inputs.nth(0).fill('1/0');
  await inputs.nth(1).fill('未定義の長い変数名'.repeat(6)); await inputs.nth(2).fill('1/0');
  await expect(panel.locator('.pcad-field__message--error')).toHaveCount(3);
  await expectContained(panel);
  const afterError = await rectangle(panel);
  expect(afterError.height).toBeGreaterThan(beforeError.height);
  expect(afterError.y).toBeLessThan(beforeError.y);
  await page.setViewportSize({ width: 1008, height: 681 }); await expectContained(panel);
  await expect(inputs.nth(0)).toHaveValue('1/0');
  await dragHeading(page, panel, -2000, -2000); await expectContained(panel);
  for (const input of await inputs.all()) await input.fill('0');
  await inputs.nth(0).fill('20');
  // Button activation still confirms after moving and resizing the window.
  await panel.getByRole('button', { name: '決定', exact: true }).click();
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true })).toBeVisible();
  await inputs.nth(0).press('Escape');
}

export async function draggableMathWindowFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await sketchTool(page, '点').click();
  const panel = panelFor(page), inputs = panel.locator('input.pcad-field__input');
  await panel.locator('.pcad-field__math').first().click();
  const dialog = page.locator('.pcad-math-dialog');
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea');
  await input.fill('3+4');
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  const before = await rectangle(dialog);
  await dragHeading(page, dialog, 80, 0);
  const after = await rectangle(dialog);
  expect(after.x - before.x).toBeCloseTo(80, 0);
  await expect(input).toBeFocused(); await expect(input).toHaveValue('3+4'); await expectContained(dialog);
  await page.setViewportSize({ width: 1008, height: 681 }); await expectContained(dialog);
  await input.press('Control+Enter'); await expect(dialog).toHaveCount(0);
  await expect(panel.locator('.pcad-field__message').first()).toHaveText('= 7');
  await inputs.nth(0).press('Enter');
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true })).toBeVisible();
  await inputs.nth(0).press('Escape');
}
