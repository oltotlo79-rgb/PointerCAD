import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, readDrawingBundle, writePcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem, twoBoxAssemblyFile, installAssemblyFileGateway } from './assemblyTestSupport.js';
import { openAssemblyFixtureCapture, selectComponent } from './assemblyCaptureSupport.js';
import { chooseDrawingMenu, waitForDrawingReady } from './drawingManufacturingFixture.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { drawingMessage } from './drawingMessages.js';
import { controlDrawingRefresh, expectDrawingRefreshHeld } from './holdDrawingRefresh.js';
import { drawingSourceInputHash } from '../../packages/model/src/index.js';
import { uiMessage } from './uiMessages.js';
import { waitForMathEditorText } from './mathEditorReady.js';

declare global {
  interface Window { pcadCompositionSavedBytes?: readonly number[] | null; pcadR20RefreshOpens?: number }
}
type DocumentKind = 'part' | 'assembly' | 'drawing';
type KeyName = 'Tab' | 'Enter' | 'Escape' | 'Delete' | 'Undo';
interface KeyProof { readonly key: KeyName; readonly owner: 'input' | 'viewport'; readonly oracle: string }
const documentSha = (document: unknown): string => {
  const encoded = JSON.stringify(document);
  if (encoded === undefined) throw new Error('Saved document cannot be encoded for evidence');
  return createHash('sha256').update(encoded).digest('hex');
};

async function viewportKeyProof(page: Page, kind: DocumentKind, original: unknown, proof: KeyProof[]): Promise<void> {
  const viewport = page.locator(kind === 'drawing' ? '.pcad-drawing-sheet' : 'canvas.pcad-viewport__canvas');
  // Cancel selection/tool state before exercising the no-selection viewport keys.
  await viewport.focus(); await page.keyboard.press('Escape');
  expect(await savedDocument(page, kind)).toEqual(original);
  proof.push({ key: 'Escape', owner: 'viewport', oracle: 'cancel leaves saved document unchanged' });
  for (const key of ['Tab', 'Enter', 'Delete'] as const) {
    await viewport.focus(); await expect(viewport).toBeFocused();
    await page.keyboard.press(key);
    if (key === 'Tab') await expect(viewport).not.toBeFocused();
    expect(await savedDocument(page, kind)).toEqual(original);
    proof.push({ key, owner: 'viewport', oracle: key === 'Tab' ? 'focus moves; saved document unchanged' : 'no active tool/selection; saved document unchanged' });
  }
}

/** Exercise the actual named-view controls; no store/DB/controller state injection. */
async function namedViewUnavailableProof(page: Page, info: TestInfo, kind: 'part' | 'assembly', original: unknown): Promise<void> {
  if (original === null || typeof original !== 'object' || !('namedViews' in original)) {
    throw new Error('Actual saved document must contain named views');
  }
  const menu = page.locator('.pcad-named-views');
  const summary = menu.locator('summary');
  const wasOpen = await menu.getAttribute('open') !== null;
  if (!wasOpen) await summary.click();
  const historyState = () => page.locator('.pcad-toolbar [data-command-id="history.undo"], .pcad-toolbar [data-command-id="history.redo"]')
    .evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-command-id'),
      disabled: element.getAttribute('aria-disabled') ?? element.hasAttribute('disabled').toString() })));
  const beforeHistory = await historyState();
  const proof: { readonly id: string; readonly visibleReason: string; readonly activations: readonly string[] }[] = [];
  try {
    const choice = menu.getByRole('combobox', { name: uiMessage('view', 'view.named.choose'), exact: true });
    await choice.selectOption(''); await expect(choice).toHaveValue('');
    const optionState = () => choice.evaluate(select => {
      if (!(select instanceof HTMLSelectElement)) throw new Error('Named-view choice must be an actual select element');
      return Array.from(select.options, option => ({ value: option.value, text: option.textContent }));
    });
    const namesBefore = await optionState();
    const nameBefore = await menu.locator('input').inputValue();
    const messagesBefore = await menu.getByRole('status').allTextContents();
    for (const action of ['restore', 'rename', 'delete'] as const) {
      const id = 'toolbar.namedView.' + action;
      const control = menu.locator('[data-command-id="' + id + '"]');
      await expect(control).toBeVisible(); await expect(control).toHaveAttribute('aria-disabled', 'true');
      expect(await control.evaluate(element => element.hasAttribute('disabled'))).toBe(false);
      await control.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      await expect(control).toBeFocused();
      const hint = page.locator('.pcad-keyboard-control-hint'); await expect(hint).toBeVisible();
      await expect(hint).toContainText(uiMessage('view', 'view.named.chooseRequired'));
      await expect(hint).toContainText((await control.getAttribute('title')) ?? 'missing concrete named-view reason');
      const visibleReason = await hint.innerText();
      for (const activation of ['Enter', 'Space', 'pointer'] as const) {
        if (activation === 'pointer') {
          const bounds = await control.boundingBox();
          if (bounds === null) throw new Error('Unavailable named-view control has no actual pointer target');
          await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        } else await control.press(activation);
        const saved = await savedDocument(page, kind); expect(saved).toEqual(original);
        if (saved === null || typeof saved !== 'object' || !('namedViews' in saved)) throw new Error('Saved named views missing');
        expect(saved.namedViews).toEqual(original.namedViews);
        expect(await historyState()).toEqual(beforeHistory);
        await expect(control).toHaveAttribute('aria-disabled', 'true');
        await expect(choice).toHaveValue('');
        expect(await optionState()).toEqual(namesBefore);
        expect(await menu.locator('input').inputValue()).toBe(nameBefore);
        expect(await menu.getByRole('status').allTextContents()).toEqual(messagesBefore);
      }
      proof.push({ id, visibleReason, activations: ['Enter', 'Space', 'pointer'] });
    }
    const path = info.outputPath('r20-named-view-unavailable-' + kind + '.json');
    await writeFile(path, JSON.stringify({ environment: info.project.name, kind, proof,
      documentSha256: documentSha(original), namedViewsUnchanged: true, documentUnchanged: true,
      undoRedoAvailabilityUnchanged: true, stateInjection: false, readyFalseBrowserCertified: false,
      pendingStates: ['camera controller not ready'], nativeHoverCertified: false, osImeCertified: false }), { encoding: 'utf8', flag: 'wx' });
    await info.attach('r20-named-view-unavailable-' + kind, { contentType: 'application/json', path });
  } finally { if (!wasOpen) await summary.click(); }
}

/** Enumerate real current toolbar menus; unavailable states not reached by this fixture stay explicit. */
async function unavailableEntranceProof(page: Page, info: TestInfo, kind: DocumentKind, original: unknown, expectedReason?: string): Promise<void> {
  if (kind !== 'drawing') await namedViewUnavailableProof(page, info, kind, original);
  const historyState = () => page.locator('.pcad-toolbar [data-command-id="history.undo"], .pcad-toolbar [data-command-id="history.redo"]')
    .evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-command-id'),
      disabled: element.getAttribute('aria-disabled') ?? element.hasAttribute('disabled').toString() })));
  const beforeHistory = await historyState();
  if (kind === 'drawing') {
    for (const [id, noteId] of [['history.undo', 'drawing-undo-unavailable'], ['history.redo', 'drawing-redo-unavailable']] as const) {
      const button = page.locator('.pcad-toolbar [data-command-id="' + id + '"]');
      if (await button.isDisabled()) {
        const reason = page.locator('#' + noteId); await expect(reason).toBeVisible();
        await expect(button).toHaveAttribute('aria-describedby', noteId);
        await reason.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        await expect(reason).toBeFocused();
        await expect(reason).toHaveText((await button.getAttribute('title')) ?? 'missing explicit history reason');
        await reason.press('Enter');
        expect(await savedDocument(page, kind)).toEqual(original);
        expect(await historyState()).toEqual(beforeHistory);
      }
    }
  }
  // Direct toolbar commands are outside ToolMenu (notably Assembly Undo/Redo).
  // The folded named-view controls have their own real open/traversal proof above.
  const directDisabled = page.locator('.pcad-toolbar button[aria-disabled="true"]:not(.pcad-menu__item):not(.pcad-named-views button)');
  const directDisabledText: { readonly id: string | null; readonly text: string }[] = [];
  const directCount = await directDisabled.count();
  for (let index = 0; index < directCount; index += 1) {
    const control = directDisabled.nth(index);
    await control.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(control).toBeFocused();
    const hint = page.locator('.pcad-keyboard-control-hint'); await expect(hint).toBeVisible();
    const text = (await hint.innerText()).trim(); expect(text).not.toBe('');
    await expect(hint).toContainText((await control.getAttribute('title')) ?? 'missing direct disabled reason');
    directDisabledText.push({ id: await control.getAttribute('data-command-id'), text });
    await control.press('Enter');
    expect(await savedDocument(page, kind)).toEqual(original);
    expect(await historyState()).toEqual(beforeHistory);
    await expect(directDisabled).toHaveCount(directCount);
  }
  const groups = page.locator('.pcad-toolbar .pcad-menu').filter({ has: page.locator(':scope > button[aria-haspopup="true"]') });
  const proof: { readonly group: string; readonly id: string | null; readonly text: string }[] = [];
  const groupInventory: { readonly group: string; readonly total: number; readonly disabled: number }[] = [];
  for (let groupIndex = 0; groupIndex < await groups.count(); groupIndex += 1) {
    const group = groups.nth(groupIndex), trigger = group.locator(':scope > button[aria-haspopup="true"]');
    await trigger.click();
    const panel = group.locator('.pcad-menu__panel'); await expect(panel).toBeVisible();
    const groupName = (await panel.getAttribute('aria-label')) ?? '';
    const inventory = await panel.locator('button').evaluateAll(buttons => buttons.map((button, index) => ({
      index, id: button.getAttribute('data-command-id'), disabled: button.getAttribute('aria-disabled') === 'true',
    })));
    groupInventory.push({ group: groupName, total: inventory.length, disabled: inventory.filter(item => item.disabled).length });
    await page.keyboard.press('Escape');
    for (const item of inventory.filter(entry => entry.disabled)) {
      await trigger.click();
      const control = group.locator('.pcad-menu__panel button').nth(item.index);
      await expect(control).toHaveAttribute('aria-disabled', 'true');
      await control.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      await expect(control).toBeFocused();
      const hint = page.locator('.pcad-keyboard-control-hint'); await expect(hint).toBeVisible();
      const text = (await hint.innerText()).trim(); expect(text).not.toBe('');
      if (expectedReason !== undefined) await expect(hint).toContainText(expectedReason);
      await expect(hint).toContainText((await control.getAttribute('title')) ?? 'missing-unavailable-reason');
      proof.push({ group: groupName, id: item.id, text });
      await control.press('Enter');
      await expect(group.locator('.pcad-menu__panel')).toHaveCount(0);
      expect(await savedDocument(page, kind)).toEqual(original);
      expect(await historyState()).toEqual(beforeHistory);
    }
  }
  const nativeDisabled = await page.locator('.pcad-toolbar button:disabled').evaluateAll(buttons => buttons.map(button => ({
    id: button.getAttribute('data-command-id'), name: button.getAttribute('aria-label') ?? button.textContent?.trim(),
    title: button.getAttribute('title'), keyboardTextCertified: false, nativeHoverCertified: false,
  })));
  expect(await savedDocument(page, kind)).toEqual(original);
  expect(await historyState()).toEqual(beforeHistory);
  const evidencePath = info.outputPath('r20-unavailable-entrances-' + kind + (expectedReason === undefined ? '' : '-drawing-busy-unavailable') + '.json');
  await writeFile(evidencePath, JSON.stringify({
    environment: info.project.name, kind, groupInventory, keyboardText: proof, nativeDisabled, directDisabledText,
    documentUnchanged: true, undoAvailabilityUnchanged: true, allUnavailableStatesCertified: false,
    pendingStates: ['busy transitions', 'other selection cardinalities', 'native pointer hover'],
  }), { encoding: 'utf8', flag: 'wx' });
  await info.attach('r20-unavailable-entrances-' + kind, { contentType: 'application/json', path: evidencePath });
}

async function attachKeyProof(info: TestInfo, kind: DocumentKind, original: unknown, proof: readonly KeyProof[]): Promise<void> {
  for (const owner of ['input', 'viewport'] as const) {
    expect([...new Set(proof.filter(row => row.owner === owner).map(row => row.key))].sort())
      .toEqual(['Delete', 'Enter', 'Escape', 'Tab', 'Undo']);
  }
  const evidencePath = info.outputPath('r20-key-cells-' + kind + '.json');
  await writeFile(evidencePath, JSON.stringify({
    schema: 1, kind, environment: info.project.name, documentSha256: documentSha(original),
    cells: proof, osImeCertified: false, compositionDispatchCases: 5,
  }), { encoding: 'utf8', flag: 'wx' });
  await info.attach('r20-key-cells-' + kind, { contentType: 'application/json', path: evidencePath });
}


/** Captures the existing real save command's bytes; native file-picker acceptance is outside R20. */
export async function installSaveCapture(page: Page, documents: readonly { readonly name: string; readonly bytes: Uint8Array }[] = []): Promise<void> {
  await installAssemblyFileGateway(page, {});
  await page.evaluate(queued => {
    const install = window.pcadSetFileGateway;
    if (install === undefined) throw new Error('File gateway is not ready');
    window.pcadR20RefreshOpens = 0;
    const files = queued.map(file => ({ name: file.name, bytes: Uint8Array.from(file.bytes), saveTargetToken: null }));
    install({ openPcad: () => { window.pcadR20RefreshOpens = (window.pcadR20RefreshOpens ?? 0) + 1; return Promise.resolve(files.shift() ?? null); }, hasSaveTarget: () => false,
      savePcad: (name, bytes) => { window.pcadCompositionSavedBytes = [...bytes]; return Promise.resolve(name); },
      saveFileAs: (_name, _kind, bytes) => { window.pcadCompositionSavedBytes = [...bytes]; return Promise.resolve(true); },
    });
  }, documents.map(file => ({ name: file.name, bytes: [...file.bytes] })));
}

export async function savedDocument(page: Page, kind: DocumentKind): Promise<unknown> {
  await page.evaluate(() => { window.pcadCompositionSavedBytes = null; });
  const canvas = page.locator(kind === 'drawing' ? '.pcad-drawing-sheet' : 'canvas.pcad-viewport__canvas');
  await canvas.focus(); await expect(canvas).toBeFocused();
  await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(() => Array.isArray(window.pcadCompositionSavedBytes));
  const bytes = await page.evaluate(() => window.pcadCompositionSavedBytes);
  if (bytes == null) throw new Error('Save did not produce a document');
  if (kind === 'drawing') {
    const read = await readDrawingBundle(Uint8Array.from(bytes));
    if (!read.ok) throw new Error(read.error.message);
    return read.document;
  }
  const read = await readDocumentBundle(Uint8Array.from(bytes), kind);
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.bundle.document;
}

async function nativeTextKeys(page: Page, input: Locator, proof: KeyProof[]): Promise<void> {
  await input.fill('12'); await input.press('End'); await input.pressSequentially('3');
  await expect(input).toHaveValue('123'); await input.press('Control+z'); await expect(input).toHaveValue('12');
  proof.push({ key: 'Undo', owner: 'input', oracle: 'native text Undo: 123 to 12' });
  await input.press('Home'); await input.press('Delete'); await expect(input).toHaveValue('2');
  proof.push({ key: 'Delete', owner: 'input', oracle: 'native text Delete: 12 to 2' });
  await input.press('End'); await input.press('Backspace'); await expect(input).toHaveValue('');
  await input.fill('10*2'); await input.press('Tab'); await expect(input).not.toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(input).toBeFocused();
  proof.push({ key: 'Tab', owner: 'input', oracle: 'Tab moves focus; Shift+Tab returns' });
}

async function menuKeys(page: Page, kind: DocumentKind, original: unknown): Promise<void> {
  const trigger = page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first();
  await trigger.click();
  const item = page.locator('.pcad-menu__panel:visible button').first();
  await item.focus(); await item.press('Delete'); await item.press('Backspace');
  await expect(item).toBeFocused(); await trigger.click();
  expect(await savedDocument(page, kind)).toEqual(original);
}

async function undoOneCommit(page: Page, kind: DocumentKind, original: unknown, proof: KeyProof[]): Promise<void> {
  expect(await savedDocument(page, kind)).not.toEqual(original);
  if (kind === 'drawing') {
    await page.keyboard.press('Control+z'); await waitForDrawingReady(page);
  } else {
    const token = await beginRecompute(page); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
  }
  expect(await savedDocument(page, kind)).toEqual(original);
  proof.push({ key: 'Undo', owner: 'viewport', oracle: 'one committed document change undone to original saved document' });
}

/** Real DOM dispatch through React; OS IME candidate-window behavior remains a manual acceptance. */
async function preserveComposition(panel: Locator, input: Locator, value: string): Promise<void> {
  await input.fill(value); await input.focus();
  for (const [key, keyCode, isComposing] of [
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false],
  ] as const) {
    await input.dispatchEvent('keydown', { key, keyCode, isComposing, bubbles: true, cancelable: true });
    await expect(panel).toBeVisible(); await expect(input).toHaveValue(value); await expect(input).toBeFocused();
  }
}

export async function numericCompositionFlow(page: Page, info: TestInfo): Promise<void> {
  const proof: KeyProof[] = [];
  await installSaveCapture(page); const original = await savedDocument(page, 'part');
  const open = async () => {
    const point = page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true });
    // Escape closes coordinates but retains the selected tool. Its pressed button toggles to selection.
    if (await point.getAttribute('aria-pressed') === 'true') {
      await point.click(); await expect(point).toHaveAttribute('aria-pressed', 'false');
    }
    await point.click(); await expect(point).toHaveAttribute('aria-pressed', 'true');
  };
  await open();
  const panel = page.locator('.pcad-popover[role="dialog"]');
  const input = panel.locator('input.pcad-field__input').first();
  await expect(panel).toBeVisible();
  await preserveComposition(panel, input, '10*2'); await nativeTextKeys(page, input, proof);
  expect(await savedDocument(page, 'part')).toEqual(original);
  const token = await beginRecompute(page); await input.press('Enter'); await waitForRecompute(page, token);
  if (await panel.count() > 0) await input.press('Escape');
  proof.push({ key: 'Enter', owner: 'input', oracle: 'input Enter commits one document edit' });
  await undoOneCommit(page, 'part', original, proof);
  for (let index = 0; index < 100; index++) {
    await open(); await expect(input).toBeFocused(); await input.press('Escape'); await expect(panel).toHaveCount(0);
  }
  expect(await savedDocument(page, 'part')).toEqual(original); await menuKeys(page, 'part', original);
  proof.push({ key: 'Escape', owner: 'input', oracle: '100 real input opens/cancels leave original saved document' });
  await viewportKeyProof(page, 'part', original, proof);
  await attachKeyProof(info, 'part', original, proof);
  await unavailableEntranceProof(page, info, 'part', original);
}

export async function mateCompositionFlow(page: Page, info: TestInfo): Promise<void> {
  const proof: KeyProof[] = [];
  await openAssemblyFixtureCapture(page, await twoBoxAssemblyFile(40), 'composition.pcada');
  await installSaveCapture(page); const original = await savedDocument(page, 'assembly');
  await chooseToolMenuItem(page, '合わせる', '距離');
  const panel = page.getByRole('dialog', { name: '合致を作る' });
  await expect(panel).toBeVisible();
  for (const index of [0, 1]) {
    await selectComponent(page, index);
    await panel.getByRole('button', { name: '選択部品の原点', exact: true }).click();
  }
  const input = panel.locator('input.pcad-field__input').first();
  await preserveComposition(panel, input, '10*2'); await nativeTextKeys(page, input, proof);
  expect(await savedDocument(page, 'assembly')).toEqual(original);
  const token = await beginRecompute(page); await input.press('Enter'); await waitForRecompute(page, token);
  await expect(panel).toHaveCount(0); proof.push({ key: 'Enter', owner: 'input', oracle: 'input Enter commits one document edit' });
  await undoOneCommit(page, 'assembly', original, proof);
  for (let index = 0; index < 100; index++) {
    await chooseToolMenuItem(page, '合わせる', '距離'); await expect(input).toBeFocused();
    await input.press('Escape'); await expect(panel).toHaveCount(0);
  }
  expect(await savedDocument(page, 'assembly')).toEqual(original); await menuKeys(page, 'assembly', original);
  proof.push({ key: 'Escape', owner: 'input', oracle: '100 real input opens/cancels leave original saved document' });
  await viewportKeyProof(page, 'assembly', original, proof);
  await attachKeyProof(info, 'assembly', original, proof);
  await unavailableEntranceProof(page, info, 'assembly', original);
}

export async function drawingCompositionFlow(page: Page, info: TestInfo): Promise<void> {
  const proof: KeyProof[] = [];
  // Same creation path as drawingManufacturingFixture, preserving the already-open Electron window.
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
  await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await waitForDrawingReady(page);
  await installSaveCapture(page); const original = await savedDocument(page, 'drawing');
  const open = async () => {
    await chooseDrawingMenu(page, '記入', '文字注記');
    await page.locator('.pcad-drawing-sheet').click({ position: { x: 240, y: 180 } });
  };
  await open();
  const panel = page.getByRole('form', { name: '文字注記' });
  const input = panel.getByRole('textbox', { name: '注記の文章' });
  await expect(panel).toBeVisible();
  await preserveComposition(panel, input, '角は面取り\n単位 mm'); await nativeTextKeys(page, input, proof);
  await input.fill('角は面取り'); await input.press('End'); await input.press('Enter'); await input.pressSequentially('単位 mm');
  await expect(input).toHaveValue('角は面取り\n単位 mm');
  expect(await savedDocument(page, 'drawing')).toEqual(original);
  await panel.locator('input').first().press('Enter'); await waitForDrawingReady(page);
  await expect(page.locator('.pcad-drawing-svg [data-owner-id="note-1"]')).toHaveCount(2);
  const noteLines = page.locator('.pcad-drawing-svg [data-owner-id="note-1"] [aria-label]');
  await expect(noteLines).toHaveCount(2);
  expect(await noteLines.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['角は面取り', '単位 mm']);
  await savedDocument(page, 'drawing');
  const savedAnnotation = (await capturedDrawingBundle(page)).document.annotations;
  expect(savedAnnotation.filter(annotation => annotation.id === 'note-1')).toHaveLength(1);
  expect(savedAnnotation.find(annotation => annotation.id === 'note-1')?.text).toBe('角は面取り\n単位 mm');
  // The selected saved annotation may expose an inline editor; stop editing before undo.
  await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Escape');
  proof.push({ key: 'Enter', owner: 'input', oracle: 'native annotation newline then numeric apply commits one document edit' });
  await undoOneCommit(page, 'drawing', original, proof);
  for (let index = 0; index < 100; index++) {
    await open(); await expect(input).toBeFocused(); await input.press('Escape');
    await expect(page.locator('form.pcad-drawing-input')).toHaveCount(0);
  }
  expect(await savedDocument(page, 'drawing')).toEqual(original); await menuKeys(page, 'drawing', original);
  proof.push({ key: 'Escape', owner: 'input', oracle: '100 real input opens/cancels leave original saved document' });
  await viewportKeyProof(page, 'drawing', original, proof);
  await attachKeyProof(info, 'drawing', original, proof);
  await unavailableEntranceProof(page, info, 'drawing', original);
}

export async function numericModalOwnershipFlow(page: Page, info: TestInfo): Promise<void> {
  await installSaveCapture(page); const original = await savedDocument(page, 'part');
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const panel = page.locator('.pcad-popover[role="dialog"]'), coordinate = panel.locator('input.pcad-field__input').first();
  await coordinate.fill('10*2');
  const openMath = panel.locator('button.pcad-field__math').first(); await openMath.click();
  const dialog = page.locator('dialog[open]'); await expect(dialog).toBeVisible(); await waitForMathEditorText(dialog);
  const expression = dialog.locator('textarea');
  await expression.fill('12'); await expression.press('End'); await expression.pressSequentially('3');
  await expect(expression).toHaveValue('123'); await expression.press('Control+z'); await expect(expression).toHaveValue('12');
  await expression.press('Home'); await expression.press('Delete'); await expect(expression).toHaveValue('2');
  await expression.press('End'); await expression.press('Backspace'); await expect(expression).toHaveValue('');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(openMath).toBeFocused(); await expect(coordinate).toHaveValue('10*2');
  expect(await savedDocument(page, 'part')).toEqual(original);
  await coordinate.press('Escape'); expect(await savedDocument(page, 'part')).toEqual(original);
  const evidencePath = info.outputPath('r20-modal-input-owner.json');
  await writeFile(evidencePath, JSON.stringify({
    environment: info.project.name, documentSha256: documentSha(original), nativeTextUndoDelete: true,
    cancelledExpressionPreserved: '10*2', osImeCertified: false,
  }), { encoding: 'utf8', flag: 'wx' });
  await info.attach('r20-modal-input-owner', { contentType: 'application/json', path: evidencePath });
}

export const compositionFlows = [
  ['部品の数値入力', numericCompositionFlow],
  ['組立の合致入力', mateCompositionFlow],
  ['図面の文字注記', drawingCompositionFlow],
  ['数式ダイアログの入力所有', numericModalOwnershipFlow],
] as const;

/** Count only actual intercepted Worker requests; no application state is read or set. */
async function drawingHoldCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hold: unknown = Reflect.get(window, 'pcadDrawingRefreshHold');
    const count: unknown = hold !== null && typeof hold === 'object' ? Reflect.get(hold, 'count') : undefined;
    if (typeof count !== 'function') throw new Error('Drawing refresh counter missing');
    const value: unknown = Reflect.apply(count, hold, []);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid hold count');
    return value;
  });
}

async function capturedDrawingBundle(page: Page) {
  const bytes = await page.evaluate(() => window.pcadCompositionSavedBytes);
  if (bytes == null) throw new Error('Actual drawing save bytes missing');
  const read = await readDrawingBundle(Uint8Array.from(bytes));
  if (!read.ok) throw new Error(read.error.message);
  return read;
}

/** Holds only the existing real drawing source request; never injects application state. */
export async function drawingBusyReasonProof(page: Page, info: TestInfo): Promise<void> {
  const original = await savedDocument(page, 'drawing');
  const bomSourceBefore = (await capturedDrawingBundle(page)).source;
  const bomHistoryState = () => page.locator('.pcad-toolbar [data-command-id="history.undo"], .pcad-toolbar [data-command-id="history.redo"]')
    .evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-command-id'),
      disabled: element.hasAttribute('disabled'), ariaDisabled: element.getAttribute('aria-disabled') })));
  const bomHistoryBefore = await bomHistoryState();
  const bom = page.locator('.pcad-toolbar button:disabled[data-help-topic="drawing-bom"]');
  await expect(bom).toHaveCount(1);
  expect(await bom.getAttribute('title')).toContain(drawingMessage('drawing.toolbar.assemblyOnly'));
  const bomReason = page.locator('#drawing-bom-unavailable');
  await expect(bomReason).toBeVisible();
  await expect(bomReason).toHaveAttribute('role', 'note');
  await expect(bomReason).toHaveAttribute('tabindex', '0');
  await expect(bomReason).toHaveText(drawingMessage('drawing.toolbar.assemblyOnly'));
  await expect(bom).toHaveAttribute('aria-describedby', 'drawing-bom-unavailable');
  const precedingNotes = page.locator('.pcad-toolbar aside [role="note"]:not(#drawing-bom-unavailable)');
  // DrawingToolbar orders Undo/Redo/busy notes before BOM, after the Help button.
  const precedingCount = await precedingNotes.count();
  expect(precedingCount).toBeLessThanOrEqual(2);
  const tabOrigin = precedingCount > 0 ? precedingNotes.last() : page.locator('.pcad-toolbar button').last();
  await expect(tabOrigin).toBeVisible();
  await tabOrigin.focus();
  await expect(tabOrigin).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bomReason).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(tabOrigin).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bomReason).toBeFocused();
  // A browser pointer gesture on the actual disabled target must not execute BOM.
  // This is not an OS hover-bubble or OS IME observation.
  const bomBounds = await bom.boundingBox();
  if (bomBounds === null) throw new Error('Disabled BOM has no actual pointer target');
  await page.mouse.click(bomBounds.x + bomBounds.width / 2, bomBounds.y + bomBounds.height / 2);
  expect(await savedDocument(page, 'drawing')).toEqual(original);
  expect((await capturedDrawingBundle(page)).source).toEqual(bomSourceBefore);
  expect(await bomHistoryState()).toEqual(bomHistoryBefore);
  const bomEvidencePath = info.outputPath('r20-unsupported-bom.json');
  await writeFile(bomEvidencePath, JSON.stringify({
    environment: info.project.name, sourceKind: 'part', disabled: true, title: await bom.getAttribute('title'),
    titleOnly: false, nativeHoverCertified: false, keyboardReachable: true, documentSha256: documentSha(original),
    visibleReason: await bomReason.innerText(), ariaDescribedBy: await bom.getAttribute('aria-describedby'),
    keyboardTraversal: ['Tab', 'Shift+Tab', 'Tab'],
    browserPointerRefused: true, sourceAndAttachmentsUnchanged: true, historyAvailabilityUnchanged: true,
  }), { encoding: 'utf8', flag: 'wx' });
  await info.attach('r20-unsupported-bom', { contentType: 'application/json', path: bomEvidencePath });
  const bundle = await capturedDrawingBundle(page);
  const source = bundle.source;
  if (source.sourceKind !== 'part') throw new Error('Busy proof requires actual embedded Part source');
  expect(await drawingSourceInputHash(source)).toBe(bundle.document.source.contentHash);
  // Change a persisted source definition, preserving actual solids, IDs, and attachments.
  const changed = { ...source, document: { ...source.document, name: source.document.name + ' R20 refresh' } };
  const changedBytes = writePcadFile(changed.document, { attachments: changed.attachments });
  const changedRead = await readDocumentBundle(changedBytes, 'part');
  if (!changedRead.ok || changedRead.bundle.kind !== 'part') throw new Error('Changed actual Part input cannot reopen');
  expect(changedRead.bundle.document).toEqual(changed.document);
  const changedHash = await drawingSourceInputHash(changed);
  expect(changedHash).not.toBe(bundle.document.source.contentHash);
  const unchangedBytes = writePcadFile(source.document, { attachments: source.attachments });
  const wrongKindBytes = await twoBoxAssemblyFile(40);
  const negatives: { readonly name: string; readonly bytes: Uint8Array | null; readonly message?: string }[] = [
    { name: 'cancel-null', bytes: null },
    { name: 'wrong-kind.pcada', bytes: wrongKindBytes, message: uiMessage('file', 'file.error.wrongKind') },
    { name: 'unchanged.pcad', bytes: unchangedBytes, message: drawingMessage('drawing.sourceRefresh.unchanged') },
  ];
  for (const input of negatives) {
    await installSaveCapture(page, input.bytes === null ? [] : [{ name: input.name, bytes: input.bytes }]);
    await controlDrawingRefresh(page, 'arm');
    try {
      await chooseDrawingMenu(page, 'ファイル', drawingMessage('drawing.sourceRefresh.title'));
      await expect.poll(() => page.evaluate(() => window.pcadR20RefreshOpens)).toBe(1);
      if (input.message !== undefined) await expect(page.locator('.pcad-statusbar')).toContainText(input.message);
      expect(await savedDocument(page, 'drawing')).toEqual(original);
      await expect(page.locator('.pcad-drawing-sheet')).toHaveAttribute('aria-busy', 'false');
      expect(await drawingHoldCount(page)).toBe(0);
    } finally { await controlDrawingRefresh(page, 'release'); }
  }
  await installSaveCapture(page, [{ name: 'r20-changed-part.pcad', bytes: changedBytes }]);
  let heldDocument: unknown;
  await controlDrawingRefresh(page, 'arm');
  try {
    await chooseDrawingMenu(page, 'ファイル', drawingMessage('drawing.sourceRefresh.title'));
    await expectDrawingRefreshHeld(page);
    await expect(page.locator('.pcad-drawing-sheet')).toHaveAttribute('aria-busy', 'true');
    expect(await page.evaluate(() => window.pcadR20RefreshOpens)).toBe(1);
    heldDocument = await savedDocument(page, 'drawing');
    expect((await capturedDrawingBundle(page)).document.source.contentHash).toBe(changedHash);
    const busyReason = page.locator('#drawing-busy-unavailable'); await expect(busyReason).toBeVisible();
    await busyReason.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(busyReason).toBeFocused(); await expect(busyReason).toHaveText(drawingMessage('drawing.status.computing'));
    await expect(page.locator('.pcad-toolbar [data-help-topic="drawing-table"]')).toBeDisabled();
    // No waitForDrawingReady helper while held: enumerate live ToolMenu controls directly.
    await unavailableEntranceProof(page, info, 'drawing', heldDocument, drawingMessage('drawing.status.computing'));
    expect(await savedDocument(page, 'drawing')).toEqual(heldDocument);
  } finally { await controlDrawingRefresh(page, 'release'); }
  await waitForDrawingReady(page);
  expect(await savedDocument(page, 'drawing')).toEqual(heldDocument);
  await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z'); await waitForDrawingReady(page);
  expect(await savedDocument(page, 'drawing')).toEqual(original);
  const refreshEvidencePath = info.outputPath('r20-refresh-input-premises.json');
  await writeFile(refreshEvidencePath, JSON.stringify({
    actualSavedSourceHash: bundle.document.source.contentHash, changedSourceHash: changedHash,
    changedInputZipSha256: createHash('sha256').update(changedBytes).digest('hex'),
    negativeInputs: negatives.map(input => input.name), actualRequestHeld: true, allNegativeHoldCountsZero: true,
    stateInjection: false, osImeCertified: false,
  }), { encoding: 'utf8', flag: 'wx' });
  await info.attach('r20-refresh-input-premises', { contentType: 'application/json', path: refreshEvidencePath });
}
