import { functionCoefficientMessage, functionPlotMessage } from './functionMessages.js';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { openTarget } from './electronAppFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

const plot = functionPlotMessage;
const coefficient = functionCoefficientMessage;

/** Real range-input gestures must keep their history identity through React renders and Worker replies. */
export async function functionCoefficientFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').first();
  const name = row.locator('.pcad-field').nth(0).locator('input');
  const source = row.locator('.pcad-field').nth(1).locator('input');
  await name.fill('高さ'); await name.press('Enter');
  await source.fill('2'); await source.press('Enter');
  await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 2');
  await page.getByRole('tab', { name: 'プロパティ', exact: true }).click();
  await chooseToolMenuItem(page, '作図', plot('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  await dialog.getByRole('textbox', { name: `Y ${plot('formula')}`, exact: true }).fill('coef("高さ")*X');
  await dialog.getByRole('textbox', { name: `Z ${plot('formula')}`, exact: true }).fill('0');
  for (const [axis, min, max] of [['X', '-2', '2'], ['Y', '-10', '10'], ['Z', '-1', '1']] as const) {
    await dialog.getByRole('textbox', { name: `${axis} ${plot('minimum')}`, exact: true }).fill(min);
    await dialog.getByRole('textbox', { name: `${axis} ${plot('maximum')}`, exact: true }).fill(max);
  }
  await dialog.getByRole('button', { name: plot('preview'), exact: true }).click();
  await expect(dialog.getByRole('button', { name: plot('apply'), exact: true })).toBeEnabled({ timeout: 60_000 });
  const created = await beginRecompute(page);
  await dialog.getByRole('button', { name: plot('apply'), exact: true }).click();
  await waitForRecompute(page, created);
  const original = await savePart(page, info, 'function-coefficient-original.pcad', app);
  const curve = original.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'functionCurve');
  if (curve?.kind !== 'functionCurve') throw new Error('The coefficient curve was not saved');
  const search = page.getByRole('searchbox', { name: uiMessage('toolbar', 'nameSearch.label'), exact: true });
  await search.fill('存在しない名前');
  await expect(page.locator('.pcad-name-search').getByRole('status')).toHaveText(uiMessage('toolbar', 'nameSearch.empty'));
  await search.fill(curve.name);
  await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  await expect(search).toBeFocused();
  await search.press('ArrowDown');
  const result = page.locator('.pcad-name-search').getByRole('button').filter({ hasText: curve.name });
  await expect(result).toBeFocused();
  await result.press('Escape');
  await expect(search).toHaveValue(''); await expect(search).toBeFocused();
  await search.fill(curve.name); await search.press('ArrowDown'); await result.press('Enter');
  await expect(search).toHaveValue('');
  // Exercise the scrollable property panel at the failing Electron window size on every host.
  await page.setViewportSize({ width: 1008, height: 681 });
  const panel = page.getByRole('region', { name: coefficient('title'), exact: true });
  const slider = panel.getByRole('slider', { name: `${coefficient('value')}: 高さ`, exact: true });
  await expect(slider).toBeVisible();
  await expect(panel).toContainText(coefficient('replacesExpression'));
  await panel.getByRole('spinbutton', { name: coefficient('minimum'), exact: true }).fill('0');
  await panel.getByRole('spinbutton', { name: coefficient('maximum'), exact: true }).fill('4');
  // Layout visibility alone also accepts a range input clipped below the scroll panel.
  // Raw mouse coordinates do not scroll it into view as locator.click() would.
  // Set focus before measuring: native focus can scroll the document horizontally.
  await slider.focus();
  await expect(slider).toBeFocused();
  await slider.scrollIntoViewIfNeeded();
  await expect(slider).toBeInViewport({ ratio: 1 });
  await expect.poll(() => slider.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
  }), { message: '係数のつまみへ実際のマウス操作が届くこと', timeout: 5_000 }).toBe(true);
  const box = await slider.boundingBox();
  if (box === null) throw new Error('The coefficient slider is not laid out');
  const dragLayout = () => slider.evaluate(element => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The coefficient slider is not an input');
    const body = document.querySelector('.pcad-shell__body');
    if (!(body instanceof HTMLElement)) throw new Error('The application layout is missing');
    const { x, y, width } = element.getBoundingClientRect();
    return { x, y, width, bodyWidth: body.getBoundingClientRect().width,
      viewportWidth: window.innerWidth, value: element.value };
  });
  const beforeDrag = await dragLayout();
  const changed = await beginRecompute(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(box.x + box.width * 0.74, box.y + box.height / 2, { steps: 24 });
  } finally { await page.mouse.up(); }
  const afterDrag = await dragLayout();
  console.log('[係数ドラッグ位置]', JSON.stringify({ before: beforeDrag, after: afterDrag }));
  expect(afterDrag.x, 'ドラッグ中に係数のつまみの横位置がずれないこと').toBeCloseTo(beforeDrag.x, 1);
  expect(afterDrag.width, 'ドラッグ中に係数のつまみの幅が変わらないこと').toBeCloseTo(beforeDrag.width, 1);
  expect(afterDrag.bodyWidth, '係数の変更で画面の内側が窓幅より広がらないこと').toBeLessThanOrEqual(afterDrag.viewportWidth);
  await expect(slider).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => {
    const value = Number(await slider.inputValue());
    return value > 2.7 && value < 3.3;
  }, { message: 'ドラッグで係数の値が変わってから再計算を待つこと', timeout: 5_000 }).toBe(true);
  await waitForRecompute(page, changed);
  const dragged = await savePart(page, info, 'function-coefficient-dragged.pcad', app);
  const draggedValue = dragged.parameters[0].value.value;
  expect(draggedValue).toBeGreaterThan(2.7); expect(draggedValue).toBeLessThan(3.3);
  expect(dragged.sketches).toEqual(original.sketches);
  await page.screenshot({ path: info.outputPath('function-coefficient-slider.png'), fullPage: true });

  const undone = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await waitForRecompute(page, undone);
  expect((await savePart(page, info, 'function-coefficient-undone.pcad', app)).parameters).toEqual(original.parameters);
  const redone = await beginRecompute(page);
  await page.keyboard.press('Control+y'); await waitForRecompute(page, redone);
  expect((await savePart(page, info, 'function-coefficient-redone.pcad', app)).parameters).toEqual(dragged.parameters);

  await slider.focus();
  const keyed = await beginRecompute(page);
  await page.keyboard.down('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('ArrowRight');
  await waitForRecompute(page, keyed);
  const keyboard = await savePart(page, info, 'function-coefficient-keyboard.pcad', app);
  expect(keyboard.parameters[0].value.value).toBeGreaterThan(draggedValue);
  const undoKey = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await waitForRecompute(page, undoKey);
  expect((await savePart(page, info, 'function-coefficient-key-undone.pcad', app)).parameters).toEqual(dragged.parameters);

  await page.reload();
  if (app !== undefined) {
    await openTarget(app, info.outputPath('function-coefficient-dragged.pcad'));
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
  } else {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
    await (await chooser).setFiles(info.outputPath('function-coefficient-dragged.pcad'));
  }
  await waitForRecompute(page); await page.getByText(curve.name, { exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBe(draggedValue);
  await panel.getByRole('spinbutton', { name: coefficient('minimum'), exact: true }).fill('999');
  await expect(slider).toBeDisabled(); await expect(panel.getByRole('status')).toContainText(coefficient('invalidRange'));
  expect((await savePart(page, info, 'function-coefficient-invalid.pcad', app)).parameters).toEqual(dragged.parameters);
}
