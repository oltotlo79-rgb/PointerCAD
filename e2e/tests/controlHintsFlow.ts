import { expect, type Page, type TestInfo } from '@playwright/test';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { tree } from './sheetUiFlow.js';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';
import { uiMessage } from './uiMessages.js';
import { captureManualDetail } from './captureManualDetail.js';
import { installSaveCapture, savedDocument } from './usabilityKeyboardFlow.js';

/** IDREF lists require exact tokens and live references in this control's own document. */
export function descriptionIdrefsValid(value: string | null, required: readonly string[], available: readonly string[]): boolean {
  const ids = value === null ? [] : value.trim().split(/[\t\n\f\r ]+/).filter(Boolean);
  return ids.length > 0 && new Set(ids).size === ids.length && required.length > 0 && required.every(id => id.length > 0 && ids.includes(id))
    && ids.every(id => available.includes(id));
}

async function expectDescriptionReferences(control: ReturnType<Page['locator']>, required: readonly string[], reason?: string): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await control.evaluate(element => {
      const description = element.getAttribute('aria-describedby');
      const ids = (description ?? '').trim().split(/[\t\n\f\r ]+/).filter(Boolean);
      const references = ids.map(id => {
        const target = element.ownerDocument.getElementById(id);
        return { id, exists: target !== null, text: target?.textContent ?? '' };
      });
      return { description, references };
    });
    return descriptionIdrefsValid(snapshot.description, required, snapshot.references.filter(reference => reference.exists).map(reference => reference.id))
      && (reason === undefined || snapshot.references.filter(reference => required.includes(reference.id)).map(reference => reference.text).join(' ').includes(reason));
  }).toBe(true);
}

async function keyboardFocus(page: Page, control: ReturnType<Page['locator']>): Promise<void> {
  await control.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(control).toBeFocused();
}

/** Actual point-tool commits and real tree selection; no store/geometry injection. */
async function radialSelectionReasons(page: Page, info: TestInfo, originalDocument: unknown): Promise<void> {
  const viewport = page.locator('canvas.pcad-viewport__canvas');
  for (const [number, position] of [[1, [0, 0, 0]], [2, [20, 0, 0]], [3, [0, 0, 0]]] as const) {
    await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
    await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '点を作る', exact: true });
    await panel.getByRole('button', { name: '絶対', exact: true }).click();
    const fields = panel.locator('input.pcad-field__input'); await expect(fields).toHaveCount(3);
    for (const [index, coordinate] of position.entries()) await fields.nth(index).fill(String(coordinate));
    const token = await beginRecompute(page); await fields.first().press('Enter');
    await expect(tree(page, `点${number}`)).toBeVisible();
    await panel.locator('input.pcad-field__input').first().press('Escape');
    await expect(panel).toHaveCount(0); await waitForRecompute(page, token);
  }
  // Two actual coordinate stages commit one line, as in sketchDrawCaptureSupport.drawLine.
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '線分', exact: true }).click();
  for (const [title, position] of [['線分の始点', [40, -20, 0]], ['線分の終点', [70, -20, 0]]] as const) {
    const panel = page.getByRole('dialog', { name: title, exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '絶対', exact: true }).click();
    const fields = panel.locator('input.pcad-field__input'); await expect(fields).toHaveCount(3);
    for (const [index, coordinate] of position.entries()) await fields.nth(index).fill(String(coordinate));
    if (title === '線分の終点') {
      const token = await beginRecompute(page); await fields.first().press('Enter');
      await expect(tree(page, '線分1')).toBeVisible();
      await page.locator('.pcad-popover input.pcad-field__input').first().press('Escape');
      await expect(page.locator('.pcad-popover')).toHaveCount(0); await waitForRecompute(page, token);
    } else await fields.first().press('Enter');
  }
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  const fixture = await savedDocument(page, 'part');
  const historyState = () => page.locator('.pcad-toolbar [data-command-id="history.undo"], .pcad-toolbar [data-command-id="history.redo"]')
    .evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-command-id'), disabled: element.getAttribute('aria-disabled') })));
  const history = await historyState();
  const menu = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
  const choose = async (names: readonly string[]): Promise<void> => {
    for (const [index, name] of names.entries()) await tree(page, name).click(index === 0 ? undefined : { modifiers: ['Control'] });
    await viewport.focus(); await page.keyboard.press('Shift+F10'); await expect(menu).toBeVisible();
  };
  const reasons: { readonly selection: readonly string[]; readonly command: string; readonly reason: string }[] = [];
  for (const [names, command, reasonKey] of [
    [['点1'], 'sketch.connectPoints', 'sketch.connect.selectTwo'],
    [['点1', '点3'], 'sketch.connectPoints', 'sketch.connect.samePoint'],
    [['点1', '線分1'], 'sketch.connectPoints', 'sketch.connect.pointFeaturesOnly'],
    [['点1', '点3', '点2'], 'sketch.faceFromPoints', 'sketch.facePoints.samePoint'],
  ] as const) {
    const generation = (await readRecomputeStats(page)).requestedGeneration;
    await choose(names);
    const control = menu.locator(`[data-command-id="${command}"]`);
    await expect(control).toHaveAttribute('aria-disabled', 'true');
    await control.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(control).toBeFocused();
    const reason = uiMessage('sketch', reasonKey);
    await expect(menu.locator('#pcad-radial-hint')).toContainText(reason);
    await expectDescriptionReferences(control, ['pcad-radial-hint'], reason);
    await control.press('Enter'); await expect(menu).toHaveCount(0);
    await expect(page.locator('.pcad-statusbar')).toContainText(reason);
    expect(await savedDocument(page, 'part')).toEqual(fixture);
    expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
    expect(await historyState()).toEqual(history);
    reasons.push({ selection: names, command, reason });
  }
  // A distinct pair is available; cancellation still must not execute the command.
  await choose(['点1', '点2']);
  await expect(menu.locator('[data-command-id="sketch.connectPoints"]')).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  expect(await savedDocument(page, 'part')).toEqual(fixture);
  expect(await historyState()).toEqual(history);
  for (let index = 0; index < 4; index += 1) {
    const token = await beginRecompute(page); await viewport.focus(); await page.keyboard.press('Control+z');
    await waitForRecompute(page, token);
  }
  expect(await savedDocument(page, 'part')).toEqual(originalDocument);
  await info.attach('r20-radial-selection-reasons', { contentType: 'application/json', body: JSON.stringify({
    environment: info.project.name, reasons, validPairCancelled: true, fixtureUndoneToOriginal: true,
    nativeHoverCertified: false, unknown: ['busy Part transitions: radial opening is blocked while computing', 'OS IME candidate window'],
  }) });
}

export async function controlHintsFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSaveCapture(page);
  const originalDocument = await savedDocument(page, 'part');
  const disabledReasons: { readonly name: string; readonly renderedReason: string; readonly commandId: string | null }[] = [];

  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const save = page.getByRole('button', { name: '保存', exact: true });
  const hint = page.locator('.pcad-keyboard-control-hint');
  const before = await readRecomputeStats(page);
  // Real unavailable controls remain focusable, so their reason must be visible as text.
  for (const name of ['元に戻す', 'やり直す']) {
    const control = page.getByRole('button', { name, exact: true });
    await expect(control).toHaveAttribute('aria-disabled', 'true');
    await keyboardFocus(page, control); await expect(hint).toBeVisible();
    const renderedReason = (await hint.innerText()).trim();
    expect(renderedReason).not.toBe('');
    await expect(hint).toContainText((await control.getAttribute('title')) ?? 'missing-disabled-reason');
    await control.press('Enter');
    await expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(await savedDocument(page, 'part')).toEqual(originalDocument);
    const afterRefusal = await readRecomputeStats(page);
    expect(afterRefusal.requestedGeneration).toBe(before.requestedGeneration);
    // Pointer refusal is also a real click; the browser's native hover bubble needs independent manual evidence.
    const pointerBounds = await control.boundingBox();
    if (pointerBounds === null) throw new Error('Unavailable control has no actual pointer target');
    await page.mouse.click(pointerBounds.x + pointerBounds.width / 2, pointerBounds.y + pointerBounds.height / 2);
    expect(await savedDocument(page, 'part')).toEqual(originalDocument);
    disabledReasons.push({ name, renderedReason, commandId: await control.getAttribute('data-command-id') });
  }
  await info.attach('r20-disabled-text-controls', { contentType: 'application/json', body: JSON.stringify({
    environment: info.project.name, controls: disabledReasons, documentUnchanged: true,
    coverage: 'empty part Undo/Redo only; all other entries remain unverified', nativeHoverCertified: false,
  }) });

  await keyboardFocus(page, save);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText((await save.getAttribute('title')) ?? 'missing-save-title');
  await expect(hint).toContainText('Ctrl');
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(before.requestedGeneration);
  await page.keyboard.press('Escape'); await expect(hint).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const input = page.locator('.pcad-popover input.pcad-field__input').first();
  await input.fill('12/2');
  const originalDescription = await input.getAttribute('aria-describedby');
  if (originalDescription === null) throw new Error('The numeric input must keep its existing result description');
  await keyboardFocus(page, input);
  await expect(hint).toContainText((await input.getAttribute('title')) ?? 'missing-input-title');
  await expect(input).toHaveValue('12/2');
  await expectDescriptionReferences(input, originalDescription.trim().split(/[\t\n\f\r ]+/).filter(Boolean));
  const bounds = await hint.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds !== null) { expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440); }
  await page.screenshot({ path: info.outputPath('keyboard-input-explanation.png') });
  await captureManualDetail(page, info, { name: 'keyboard-numeric-input-hint', dialog: hint,
    fixture: { operation: 'point', pendingCoordinate: '12/2', inputTitle: await input.getAttribute('title') },
    script: new URL('./controlHintsFlow.ts', import.meta.url) });
  await input.click(); await expect(hint).toHaveCount(0);
  // The real field already has the same title on its label. Exercise that legacy route
  // and restore the actual input title before proceeding with document operations.
  const inputTitle = await input.getAttribute('title');
  if (inputTitle === null) throw new Error('The actual field explanation is missing');
  const label = page.locator(`label[for="${await input.getAttribute('id')}"]`);
  const labelDescription = await label.getAttribute('aria-describedby');
  try {
    await input.evaluate(element => element.removeAttribute('title'));
    await keyboardFocus(page, input);
    await expect(hint).toContainText(inputTitle);
    const tooltipId = await hint.getAttribute('id');
    if (tooltipId === null) throw new Error('The keyboard explanation needs an accessible id');
    await expectDescriptionReferences(input, [tooltipId]);
    expect(await label.getAttribute('aria-describedby')).toBe(labelDescription);
  } finally {
    await input.evaluate((element, title) => element.setAttribute('title', title), inputTitle);
  }
  await input.click(); await expect(hint).toHaveCount(0);
  await expect(input).toHaveAttribute('aria-describedby', originalDescription);
  await expect(input).toHaveValue('12/2');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(input).toHaveValue('12/2');
  await page.keyboard.press('Escape');

  await radialSelectionReasons(page, info, originalDocument);

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await assertRenderedControlDescriptions(page.getByRole('form', { name: uiMessage('commands', 'settings.shortcuts.title'), exact: true }));
  await assertRenderedControlDescriptions(page.getByRole('form', { name: uiMessage('view', 'settings.toolDefaults.title'), exact: true }));
  await keyboardFocus(page, page.getByLabel(uiMessage('commands', 'settings.shortcuts.command'), { exact: true }));
  await expect(hint).toHaveText(`${uiMessage('commands', 'settings.shortcuts.command')}: ${uiMessage('commands', 'settings.shortcuts.commandGuide')}`);
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await keyboardFocus(page, save);
  await expect(hint).toBeVisible();
  const scaled = await hint.boundingBox();
  if (scaled === null) throw new Error('Scaled keyboard explanation is missing');
  expect(scaled.x).toBeGreaterThanOrEqual(0); expect(scaled.y).toBeGreaterThanOrEqual(0);
  expect(scaled.x + scaled.width).toBeLessThanOrEqual(1440);
  expect(scaled.y + scaled.height).toBeLessThanOrEqual(900);
  expect(errors).toEqual([]);
}
