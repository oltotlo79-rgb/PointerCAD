/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows } from './boltedJointTestSupport.js';
import { fieldByMessageKey } from './fieldByLabel.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { readDocumentBundle } from '@pointercad/io';
import { rotateVector } from '@pointercad/model';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-10 パネルと扉(第 1 段): 線に沿って 600 × 400 の枠(閉じる・突き当て)を系列の溝幅 6 20×20 で置き、木で 4 本を選んで
 * 「選んだ枠にパネルをはめる」と、内側 580 × 380(断面の半分 10 を両側から引いた値。手で解いた値)の板が 1 枚置かれ、元に戻す 1 回で消える。
 */
function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

async function confirmMachinedPanel(page: Page, dialog: Locator): Promise<void> {
  await componentRows(page).nth(0).click();
  for (const index of [1, 2, 3]) await componentRows(page).nth(index).click({ modifiers: ['Shift'] });
  const panel = detailsOf(page, dialog, 'catalog.framePanel.title');
  await panel.locator('summary').click();
  const selectBoard = () => choice(panel, 'catalog', 'catalog.framePanel.panel').selectOption('resin-pc-t3');
  const confirm = panel.getByRole('button', { name: uiMessage('catalog', 'catalog.framePanel.place'), exact: true });
  await selectBoard();
  await choice(panel, 'catalog', 'catalog.framePanel.machining').selectOption('circle');
  await expect(confirm).toBeDisabled();
  await panel.getByRole('button', { name: uiMessage('catalog', 'catalog.framePanel.cancel'), exact: true }).click();
  await expect(componentRows(page)).toHaveCount(4);
  await panel.locator('summary').click();
  await selectBoard();
  await panel.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.framePanel.flip'), exact: true }).check();
  await choice(panel, 'catalog', 'catalog.framePanel.machining').selectOption('circle');
  for (const [field, value] of [['holeDiameter', '4*2'], ['holeX', '20'], ['holeY', '25']] as const) {
    await fieldByMessageKey(page, panel, 'catalog', `catalog.framePanel.${field}`,
      { fieldSelector: 'label.pcad-field', controlSelector: 'input' }).fill(value);
  }
  await choice(panel, 'catalog', 'catalog.framePanel.holder').selectOption('board-holder-23.8x20x30.5');
  await choice(panel, 'catalog', 'catalog.framePanel.connector').selectOption('flat-connector-m5-28x20x28');
  await expect(panel.getByRole('img', { name: uiMessage('catalog', 'catalog.framePanel.previewDrawing') })).toBeVisible();
  await expect(panel.getByText(uiMessage('catalog', 'catalog.framePanel.previewFittings').replace('{holders}', '4').replace('{connectors}', '4'),
    { exact: true })).toBeVisible();
  await expect(panel.getByText(uiMessage('catalog', 'catalog.framePanel.preview').replace('{width}', '580').replace('{height}', '380'),
    { exact: true })).toBeVisible();
  const token = await beginRecompute(page);
  await confirm.click();
  await waitForRecompute(page, token);
  await expect(panel.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.framePanel.placedWithFittings'));
  await expect(componentRows(page)).toHaveCount(13);
}

async function installedPanelDocument(bytes: Uint8Array) {
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('Missing installed panel document');
  return read.bundle.document;
}

export function registerFramePanelTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-10 パネルと扉', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('600 × 400 の枠の 4 本を選ぶと、内側 580 × 380 の板を予告して 1 枚置き、元に戻す 1 回で消える', async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = detailsOf(page, dialog, 'catalog.frameLayout.title');
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
        .fill(['0 0 0', '600 0 0', '600 400 0', '0 400 0'].join('\n'));
      await layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true }).check();
      await expect(layout.locator('tbody tr')).toHaveCount(4);
      await expectPreviewLengths(layout, ['620', '400', '600', '380']);
      let token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);

      await componentRows(page).nth(0).click();
      for (const index of [1, 2, 3]) await componentRows(page).nth(index).click({ modifiers: ['Shift'] });
      const panel = detailsOf(page, dialog, 'catalog.framePanel.title');
      await panel.locator('summary').click();
      const rows = choice(panel, 'catalog', 'catalog.framePanel.panel');
      await expect(rows.locator('option')).not.toHaveCount(1);
      await rows.selectOption({ index: 1 });
      await expect(panel.getByText(uiMessage('catalog', 'catalog.framePanel.preview').replace('{width}', '580').replace('{height}', '380'),
        { exact: true })).toBeVisible();
      token = await beginRecompute(page);
      await panel.getByRole('button', { name: uiMessage('catalog', 'catalog.framePanel.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(panel.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.framePanel.placed'));
      await expect(componentRows(page)).toHaveCount(5);

      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);

      const reopened = await openFramePicker(page);
      await choice(reopened, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await confirmMachinedPanel(page, reopened);
      await reopened.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);
      token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.redo'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(13);
      const app = appForPage(page);
      const savedPath = info.outputPath('machined-panel.pcada');
      const saved = await installedPanelDocument(await saveFlowFile(page, savedPath, app));
      const board = saved.components[4];
      expect(board?.source).toMatchObject({
        kind: 'standardPart', catalog: 'catalogItem',
        options: { family: 'panel-board-order', width: '580', height: '380', holeDiameter: '4*2', holeX: '20', holeY: '25' },
      });
      if (board === undefined || board.rigidGroupId === undefined) throw new Error('Missing installed panel group');
      expect(rotateVector(board.placement.rotation, [0, 0, 1])[2]).toBeCloseTo(-1, 9);
      expect(saved.components.filter(part => part.rigidGroupId === board.rigidGroupId)).toHaveLength(9);
      await openSaveFlowFile(page, savedPath, app);
      await expect(componentRows(page)).toHaveCount(13);
      expect(await installedPanelDocument(await saveFlowFile(page, info.outputPath('reopened-panel.pcada'), app))).toEqual(saved);
      expect(errors).toEqual([]);
    });
  });
}
