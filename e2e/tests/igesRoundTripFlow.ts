/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '@pointercad/io';
import { makeInchIgesBoxFixture, STEP_READ_FAILED_MESSAGE } from '@pointercad/kernel/testing/occt-node';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { disableFilePickers } from './filePickers.js';
import { closeInputBindings, openInputBindings } from './inputBindingsWindowSupport.js';
import { propertyPanel, propertySection, propertyValue, selectionFilterButton } from './measurementCaptureSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { commitPopover, popover, popoverTitle, selectionKindLabel, treeRow } from './solidCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { openToolMenu, toolMenuPanel } from './toolMenus.js';
import { uiMessage } from './uiMessages.js';

const INPUT_BODY = 'BOX25';
const VOLUME = 25.4 * 12.7 * 6.35;

export async function prepareIgesInput(info: TestInfo): Promise<string> {
  const bytes = await makeInchIgesBoxFixture(INPUT_BODY);
  expectIgesSurfaces(bytes);
  const path = info.outputPath('input.igs');
  await writeFile(path, bytes);
  return path;
}

function expectIgesSurfaces(bytes: Uint8Array): void {
  const records = new TextDecoder().decode(bytes).split(/\r?\n/u);
  expect(records.some(record => record[72] === 'T')).toBe(true);
  const entities = records.filter(record => record[72] === 'D').map(record => record.slice(0, 8).trim());
  expect(entities).toContain('144');
  expect(entities).not.toContain('186');
}

async function chooseMenu(page: Page, group: string, item: string): Promise<void> {
  await openToolMenu(page, group);
  await toolMenuPanel(page, group).getByRole('button', { name: item, exact: true }).click();
}

async function inspectImportedBody(page: Page): Promise<void> {
  await treeRow(page, INPUT_BODY).click();
  const property = propertyPanel(page);
  await expect(propertyValue(page, uiMessage('propertyPanel', 'propertyPanel.importedFormat'))).toHaveText('IGES');
  await property.getByRole('button', { name: uiMessage('propertyPanel', 'propertyPanel.inspectImportedShape'), exact: true }).click();
  const inspection = uiMessage('propertyPanel', 'propertyPanel.importedInspectionValid')
    .replace('{kind}', uiMessage('propertyPanel', 'propertyPanel.importedInspectionShell'));
  await expect(property.getByRole('status').filter({ hasText: inspection }))
    .toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
}

const VIEW_SHORTCUTS = [
  ['front', 'Shift+Numpad1'], ['back', 'Shift+Numpad2'],
  ['right', 'Shift+Numpad3'], ['left', 'Shift+Numpad4'],
  ['top', 'Shift+Numpad5'], ['bottom', 'Shift+Numpad6'],
] as const;

async function assignViewShortcuts(page: Page): Promise<void> {
  await openInputBindings(page, 'keys');
  const form = page.getByRole('form', { name: uiMessage('commands', 'settings.shortcuts.title'), exact: true });
  const capture = form.getByLabel(uiMessage('commands', 'settings.shortcuts.capture'), { exact: true });
  for (const [direction, key] of VIEW_SHORTCUTS) {
    await form.getByRole('button', { name: uiMessage('toolbar', `toolbar.viewOrientation.${direction}`), exact: true }).click();
    await capture.press(key);
  }
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByRole('button', { name: uiMessage('commands', 'settings.shortcuts.apply'), exact: true }).click();
  await expect(form.getByRole('status').filter({ hasText: uiMessage('commands', 'settings.shortcuts.applied') })).toHaveCount(1);
  await closeInputBindings(page);
}

async function expectSelectedFaceCount(page: Page, count: number): Promise<void> {
  // The selection summary groups faces of the same feature. A saved selection set counts each face.
  const selected = propertySection(page, uiMessage('propertyPanel', 'propertyPanel.sectionSelectionSets'));
  const name = 'IGES faces';
  const field = selected.getByRole('textbox', { name: uiMessage('propertyPanel', 'propertyPanel.selectionSetName'), exact: true });
  await expect(field).toBeVisible();
  await field.fill(name);
  await selected.getByRole('button', { name: uiMessage('propertyPanel', 'propertyPanel.selectionSetCreate'), exact: true }).click();
  const memberCount = uiMessage('propertyPanel', 'propertyPanel.selectionSetCount').replace('{count}', String(count));
  const row = selected.getByRole('listitem').filter({ hasText: name });
  await expect(row.locator('.pcad-constraint-row__detail')).toHaveText(memberCount);
  await row.getByTitle(uiMessage('propertyPanel', 'propertyPanel.selectionSetRemoveTooltip'), { exact: true }).click();
  await expect(row).toHaveCount(0);
}

async function selectBoxFaces(page: Page): Promise<void> {
  await assignViewShortcuts(page);
  await expect(selectionFilterButton(page, uiMessage('view', 'selection.kind.face'))).toHaveAttribute('aria-pressed', 'true');
  const otherKinds = [uiMessage('view', 'selection.kind.vertex'), uiMessage('view', 'selection.kind.edge'),
    uiMessage('view', 'selection.kind.body')];
  for (const kind of otherKinds) {
    const filter = selectionFilterButton(page, kind);
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await filter.click();
    await expect(filter).toHaveAttribute('aria-pressed', 'false');
  }
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  await canvas.press('3');
  const kind = uiMessage('view', 'selection.kind.face');
  const label = uiMessage('view', 'selection.kindLabel');
  await expect(selectionKindLabel(page)).toHaveText(`${label} ${kind}`);
  const selectionSets = propertyPanel(page).locator('details[data-tool="selectionSets"]');
  await selectionSets.locator(':scope > summary').click();
  await expect(selectionSets).toHaveAttribute('open', '');
  for (const [index, [direction, key]] of VIEW_SHORTCUTS.entries()) {
    const rendered = await page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
    await canvas.press(key);
    await expect.poll(() => page.evaluate(previous => {
      const stats = window.pcadViewportRenderStats?.();
      return stats !== undefined && stats.completedRenders > previous && performance.now() - stats.lastCompletedAtMs > 350;
    }, rendered), { timeout: 10_000, message: uiMessage('toolbar', `toolbar.viewOrientation.${direction}`) }).toBe(true);
    // The box is centred at the camera target. Each axial view exposes one face at the canvas centre.
    await canvas.click({ modifiers: index === 0 ? [] : ['Shift'] });
    await expectSelectedFaceCount(page, index + 1);
  }
}

async function expectSewnVolume(page: Page): Promise<void> {
  await treeRow(page, '縫合1').click();
  const volume = propertyValue(page, uiMessage('propertyPanel', 'propertyPanel.volume'));
  await expect.poll(async () => {
    const shown = await volume.getAttribute('title');
    return Math.abs(Number.parseFloat(shown?.replaceAll(',', '') ?? '') - VOLUME);
  }, { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
}

async function startExchange(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (app === undefined) await disableFilePickers(page);
  await page.goto(app === undefined ? '/' : 'app://pointercad/index.html');
  await waitForStartupHealth(page, info);
}

async function chooseIgesFile(page: Page, input: string, button: string, app?: ElectronApplication): Promise<void> {
  await chooseMenu(page, uiMessage('toolbar', 'toolbar.fileMenu.groupLabel'), uiMessage('toolbar', 'toolbar.file.importShape'));
  const importPanel = page.getByRole('form', { name: uiMessage('file', 'exchange.importTitle'), exact: true });
  if (app !== undefined) await openTarget(app, input);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  await importPanel.getByRole('button', { name: button, exact: true }).click({ timeout: KERNEL_TIMEOUT_MS });
  if (chooser !== null) await (await chooser).setFiles(input);
}

async function openIgesFile(page: Page, input: string, button: string, app?: ElectronApplication): Promise<void> {
  const imported = await beginRecompute(page);
  await chooseIgesFile(page, input, button, app);
  await waitForRecompute(page, imported);
}

async function savedIgesPart(page: Page, path: string, app?: ElectronApplication) {
  const saved = readPcadFile(await saveFlowFile(page, path, app));
  if (!saved.ok) throw new Error(saved.error.message);
  const source = saved.document.solids.find(feature => feature.kind === 'importedSolid' && feature.name === INPUT_BODY);
  if (source?.kind !== 'importedSolid') throw new Error('The IGES history operation was not saved');
  const attachment = saved.attachments.shapes.get(source.shapeRef);
  if (attachment === undefined || attachment.byteLength === 0) throw new Error('The original B-rep was not saved');
  return { document: saved.document, source, attachment };
}

export async function igesRoundTripFlow(
  page: Page, info: TestInfo, input: string, app?: ElectronApplication,
): Promise<void> {
  await startExchange(page, info, app);
  await openIgesFile(page, input, 'IGES', app);
  await inspectImportedBody(page);
  const imported = await savedIgesPart(page, info.outputPath('iges-original.pcad'), app);

  await selectBoxFaces(page);
  await chooseMenu(page, uiMessage('toolbar', 'toolbar.create.groupLabel'), uiMessage('toolbar', 'toolbar.solid.sew'));
  await expect(popoverTitle(page)).toHaveText(uiMessage('numericInput', 'numericInput.title.sew'));
  const sewn = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, sewn);
  await expectSewnVolume(page);

  const savedPath = info.outputPath('iges-repaired.pcad');
  const saved = await savedIgesPart(page, savedPath, app);
  expect(saved.attachment).toEqual(imported.attachment);
  expect(saved.source).toEqual(imported.source);
  const repair = saved.document.solids.find(feature => feature.kind === 'sew');
  if (repair?.kind !== 'sew') throw new Error('Sewing was not saved');
  expect(repair.surfaceFaces?.map(face => face.bodyFeatureId)).toEqual(Array<string>(6).fill(saved.source.id));
  expect(new Set(repair.surfaceFaces?.map(face => face.index)).size).toBe(6);
  expect(saved.document.selectionSets).toEqual(imported.document.selectionSets);

  await fileAction(page, uiMessage('toolbar', 'toolbar.file.new')).click();
  await expect(treeRow(page, '縫合1')).toHaveCount(0);
  await openSaveFlowFile(page, savedPath, app);
  await inspectImportedBody(page);
  await expectSewnVolume(page);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  await exportIgesFile(page, info.outputPath('iges-repaired.iges'), app);
}

async function exportIgesFile(page: Page, output: string, app?: ElectronApplication): Promise<void> {
  await chooseMenu(page, uiMessage('toolbar', 'toolbar.fileMenu.groupLabel'), uiMessage('toolbar', 'toolbar.file.exportShape'));
  const panel = page.getByRole('form', { name: uiMessage('file', 'exchange.exportTitle'), exact: true });
  await panel.getByRole('radio', { name: 'IGES', exact: true }).click({ timeout: KERNEL_TIMEOUT_MS });
  if (app !== undefined) await saveTarget(app, output);
  const download = app === undefined ? page.waitForEvent('download', { timeout: KERNEL_TIMEOUT_MS }) : null;
  await panel.getByRole('button', { name: uiMessage('file', 'exchange.export'), exact: true }).click();
  if (download !== null) {
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.iges$/u);
    await file.saveAs(output);
  } else {
    await diskFile(output);
  }
  await expect(panel).toHaveCount(0);
  expectIgesSurfaces(await readFile(output));
}

export async function plainIgesRoundTripFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const input = await prepareIgesInput(info);
  await startExchange(page, info, app);
  await openIgesFile(page, input, uiMessage('file', 'exchange.chooseImportFile'), app);
  await inspectImportedBody(page);
  const broken = info.outputPath('broken.iges');
  await writeFile(broken, 'invalid IGES record');
  await chooseIgesFile(page, broken, 'IGES', app);
  await expect(page.locator('.pcad-statusbar__text')).toContainText(STEP_READ_FAILED_MESSAGE, { timeout: KERNEL_TIMEOUT_MS });
  await expect(treeRow(page, INPUT_BODY)).toHaveCount(1);
  await exportIgesFile(page, info.outputPath('iges-roundtrip.iges'), app);
}
