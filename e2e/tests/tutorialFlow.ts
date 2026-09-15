import { readFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';

const message = (key: string) => uiMessage('commands', key);
const panel = (page: Page) => page.getByRole('region', { name: message('tutorial.title'), exact: true });
const field = (page: Page) => page.locator('.pcad-popover input.pcad-field__input').first();
async function openFromSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const settings = page.getByRole('group', { name: uiMessage('view', 'settings.title'), exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: message('tutorial.start'), exact: true }).click();
}
async function reachable(page: Page, control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
  const box = await control.boundingBox(), viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error('案内の操作範囲を取得できません');
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}
async function startStep(page: Page, step: string): Promise<void> {
  await expect(panel(page)).toHaveAttribute('data-tutorial-step', step);
  const next = panel(page).getByRole('button', { name: message('tutorial.action.' + step), exact: true });
  await expect(next).toBeEnabled(); await expect(next).toBeFocused(); await next.press('Enter');
}
async function commitStep(page: Page): Promise<void> {
  const generation = await beginRecompute(page);
  await field(page).press('Enter'); await waitForRecompute(page, generation);
}

export async function tutorialFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const welcome = page.getByRole('button', { name: message('tutorial.start'), exact: true });
  await welcome.focus(); await welcome.press('Enter');
  await startStep(page, 'point'); await expect(field(page)).toHaveValue('0mm'); await commitStep(page);
  await startStep(page, 'outline'); await expect(field(page)).toHaveValue('-30mm');
  await field(page).press('Enter'); await expect(field(page)).toHaveValue('60mm'); await commitStep(page);
  const faceGeneration = await beginRecompute(page);
  await startStep(page, 'face'); await waitForRecompute(page, faceGeneration);
  await startStep(page, 'extrude'); await expect(field(page)).toHaveValue('8mm'); await commitStep(page);
  await startStep(page, 'hole'); await expect(field(page)).toHaveValue('10mm'); await commitStep(page);
  await expect(panel(page)).toHaveAttribute('data-tutorial-step', 'save');
  const volume = page.locator('.pcad-panel--right dt.pcad-properties__key', { hasText: /^体積$/u })
    .locator('xpath=following-sibling::dd[1]');
  await expect.poll(async () => Math.abs(Number.parseFloat((await volume.innerText()).replaceAll(',', '')) - (60 * 40 * 8 - Math.PI * 25 * 8))).toBeLessThan(0.01);

  if (app !== undefined) {
    await app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'pcadTutorialSaveCancelled', { value: false, writable: true, configurable: true });
      dialog.showSaveDialog = () => {
        Reflect.set(dialog, 'pcadTutorialSaveCancelled', true);
        return Promise.resolve({ canceled: true, filePath: '' });
      };
    });
    await startStep(page, 'save');
    await expect.poll(() => app.evaluate(({ dialog }) => Reflect.get(dialog, 'pcadTutorialSaveCancelled'))).toBe(true);
    await expect(panel(page)).toHaveAttribute('data-tutorial-step', 'save');
  }
  const path = info.outputPath('tutorial-plate.pcad');
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download') : null;
  // A cancelled native dialog may leave focus on its invoking button.
  const save = panel(page).getByRole('button', { name: message('tutorial.action.save'), exact: true });
  await save.focus(); await save.press('Enter');
  if (download !== null) await (await download).saveAs(path); else await diskFile(path);
  const loaded = await readPcadFile(new Uint8Array(await readFile(path)));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  expect(loaded.document.solids.map(item => item.kind)).toEqual(['extrude', 'hole']);
  const sketch = loaded.document.sketches[0];
  expect(sketch.features.map(item => item.kind)).toEqual(['point', 'rectangle', 'face']);
  await expect(panel(page)).toHaveAttribute('data-tutorial-step', 'complete');
  await captureManualDetail(page, info, { name: 'tutorial', dialog: panel(page), fixture: loaded.document, script: new URL(import.meta.url) });
  await startStep(page, 'complete'); await expect(panel(page)).toHaveCount(0);

  // A real reopened file preserves the same model. A new guide cannot overwrite that nonempty document.
  if (app !== undefined) await openTarget(app, path);
  const opening = app === undefined ? page.waitForEvent('filechooser') : null;
  const reopened = await beginRecompute(page);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  if (opening !== null) await (await opening).setFiles(path);
  await waitForRecompute(page, reopened);
  expect(await savePart(page, info, 'tutorial-reopened.pcad', app)).toEqual(loaded.document);
  // Add a real unsaved point before reopening the guide. Its refusal must retain that edit too.
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  await field(page).fill('100mm'); await commitStep(page); await page.keyboard.press('Escape');
  await openFromSettings(page); await expect(panel(page)).toContainText(message('tutorial.existingDocument'));
  const retained = await savePart(page, info, 'tutorial-retained-unsaved.pcad', app);
  expect(retained.solids).toEqual(loaded.document.solids);
  expect(retained.sketches[0].features.slice(0, -1)).toEqual(sketch.features);
  expect(retained.sketches[0].features.at(-1)?.kind).toBe('point');
  expect(retained.sketches[0].features.length).toBe(sketch.features.length + 1);
  await panel(page).getByRole('button', { name: message('tutorial.pause'), exact: true }).click();
  await page.getByRole('button', { name: '新規', exact: true }).click();
  await openFromSettings(page); await expect(panel(page)).toHaveAttribute('data-tutorial-step', 'point');
}

export async function tutorialPauseFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const original = await savePart(page, info, 'tutorial-original.pcad', app);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '150');
  await openFromSettings(page);
  await reachable(page, panel(page).getByRole('button', { name: message('tutorial.action.point'), exact: true }));
  await reachable(page, panel(page).getByRole('button', { name: message('tutorial.pause'), exact: true }));
  await reachable(page, panel(page).getByRole('button', { name: message('tutorial.help'), exact: true }));
  await startStep(page, 'point'); await field(page).fill('12/2');
  await reachable(page, field(page));
  await reachable(page, panel(page).getByRole('button', { name: message('tutorial.pause'), exact: true }));
  await page.screenshot({ path: info.outputPath('tutorial-input-150.png') });
  await panel(page).getByRole('button', { name: message('tutorial.pause'), exact: true }).click();
  await expect(panel(page)).toHaveCount(0); await expect(field(page)).toHaveValue('12/2');
  await openFromSettings(page); await expect(field(page)).toHaveValue('12/2');
  await field(page).fill('1/0'); await field(page).press('Enter');
  await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(panel(page)).toHaveAttribute('data-tutorial-step', 'point');
  await field(page).press('Escape');
  expect(await savePart(page, info, 'tutorial-cancelled.pcad', app)).toEqual(original);
  await panel(page).getByRole('button', { name: message('tutorial.help'), exact: true }).click();
  await expect(page.locator('.pcad-help__body')).toContainText('初めての作図');
}
