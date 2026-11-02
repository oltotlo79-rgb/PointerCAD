/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../packages/model/src/index.js';
import { diskFile, openTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { orphanReadFixture } from './readResponseFixture.js';
import { assertReadWorkerClosed, nativeReadWorkers, observeRead, readObservationSnapshot, READ_OBSERVATION_COST, writeReadEvidence } from './readResponseObservation.js';

/** Ordinary new-open cancellation, document switch and renderer disposal; no invented cancel button. */
export async function readLifecycleFlow(page: Page, info: TestInfo, action: 'new-request' | 'switch' | 'dispose', app?: ElectronApplication): Promise<void> {
  await waitForStartupHealth(page, info);
  const empty = createEmptyPartDocument(), before = appendSolid(empty, { ...createPrimitiveFeature(empty, 'box'), name: '読込前の箱' });
  const beforePath = info.outputPath('before-read.pcad'); await writeFile(beforePath, writePcadFile(before));
  await openSaveFlowFile(page, beforePath, app);
  // A real edit creates a meaningful Undo history. Save it so open needs no discard dialog.
  await page.locator('.pcad-tree__select').filter({ hasText: '読込前の箱' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '名前を変える', exact: true }).click();
  const rename = page.getByRole('textbox', { name: '新しい名前', exact: true }); await rename.fill('履歴を残す箱');
  const edit = await beginRecompute(page); await rename.press('Enter'); await waitForRecompute(page, edit);
  const stablePath = info.outputPath('stable-read-target.pcad'), stableBytes = await saveFlowFile(page, stablePath, app);
  const stable = readPcadFile(stableBytes); if (!stable.ok) throw new Error('Stable document refused');
  const label = await page.locator('.pcad-statusbar__file').innerText();
  const undo = page.getByRole('button', { name: '元に戻す', exact: true }); await expect(undo).toBeEnabled();
  const fixture = orphanReadFixture(128), candidate = info.outputPath('obsolete-read.pcad'); await writeFile(candidate, fixture.bytes);
  const observed = await observeRead(page, false, app), workers = nativeReadWorkers(page);
  let completed = false, beforeAction: Awaited<ReturnType<typeof readObservationSnapshot>> = null;
  try {
  if (app !== undefined) await openTarget(app, candidate);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  await fileAction(page, '開く').click(); if (chooser !== null) await (await chooser).setFiles(candidate);
  await expect.poll(() => page.evaluate(() => window.pcadReadObservation?.spans.length)).toBe(1);
  // This is an assertion, never a pause in the reader. If the real read won the race, fail.
  expect(await page.evaluate(() => window.pcadReadObservation?.spans[0]?.end)).toBeNull();
  beforeAction = await readObservationSnapshot(page);
  const cancelledAt = await page.evaluate(() => performance.timeOrigin + performance.now());
  if (action === 'new-request') {
    if (app !== undefined) await app.evaluate(({ dialog }) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] }); });
    const secondChooser = app === undefined ? page.waitForEvent('filechooser') : null;
    await fileAction(page, '開く').click();
    if (secondChooser !== null) await (await secondChooser).setFiles([]);
  } else if (action === 'switch') {
    await fileAction(page, '新規').click();
  } else {
    await page.reload(); await waitForStartupHealth(page, info);
  }
  await assertReadWorkerClosed(workers);
  const audit = action === 'dispose' ? null : await page.evaluate(() => {
    const audit = window.pcadReadObservation;
    return audit === undefined ? null : { spans: audit.spans, sent: audit.sent, replied: audit.replied, terminated: audit.terminated };
  });
  await writeReadEvidence(info, `read-${action}`, { action, cancelledAt, workers, audit, beforeAction, routed: observed.routed(), assets: observed.sourceAssets,
    limits: 'native close excludes a later native response; adversarial saved callbacks/incorrect IDs remain the original unit tests, not fabricated browser replies' });
  expect(observed.routed()).toBe(1); expect(workers).toHaveLength(1);
  if (audit !== null) {
    expect(audit.sent).toBe(1); expect(audit.replied).toBe(0); expect(audit.terminated).toBe(1);
  }
  expect(createHash('sha256').update(await readFile(candidate)).digest('hex')).toBe(fixture.expected.sourceSha);
  if (action === 'new-request') {
    await expect(page.locator('.pcad-statusbar__file')).toHaveText(label);
    await expect(page.locator('.pcad-tree__select').filter({ hasText: '履歴を残す箱' })).toBeVisible(); await expect(undo).toBeEnabled();
    const viewport = page.locator('canvas.pcad-viewport__canvas'); await viewport.focus(); await page.keyboard.press('Control+z');
    await expect(page.locator('.pcad-tree__select').filter({ hasText: '読込前の箱' })).toBeVisible();
    await viewport.focus(); await page.keyboard.press('Control+y');
    await expect(page.locator('.pcad-tree__select').filter({ hasText: '履歴を残す箱' })).toBeVisible();
    // Ctrl+S exercises the confirmed target, not Save As. Desktop must not ask for a new target.
    const download = app === undefined ? page.waitForEvent('download') : null;
    if (app !== undefined) await app.evaluate(({ dialog }) => { dialog.showSaveDialog = () => { throw new Error('Read cancellation changed the confirmed save target'); }; });
    await viewport.focus(); await page.keyboard.press('Control+s');
    const afterPath = app === undefined ? info.outputPath('cancel-preserved.pcad') : stablePath;
    if (download !== null) await (await download).saveAs(afterPath); else await diskFile(afterPath);
    await expect(page.locator('[data-save-stage="complete"]')).toBeVisible();
    const after = readPcadFile(await readFile(afterPath)); if (!after.ok) throw new Error('After-cancel save refused');
    expect(after.document).toEqual(stable.document); expect(after.attachments).toEqual(stable.attachments);
  } else {
    await expect(page.locator('.pcad-statusbar__file')).toHaveText('名称未設定');
    await expect(page.locator('.pcad-tree__select').filter({ hasText: '履歴を残す箱' })).toHaveCount(0);
    await expect(undo).toBeDisabled();
  }
  completed = true;
  } finally {
    await writeReadEvidence(info, `read-${action}-observation`, { status: completed ? 'passed-lifecycle' : 'incomplete-or-failed',
      action, beforeAction, audit: await readObservationSnapshot(page), workers, routed: observed.routed(),
      assets: observed.sourceAssets, observationCost: READ_OBSERVATION_COST });
  }
}
