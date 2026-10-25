/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile, writePcadFile, readArchive, PCAD_DOCUMENT_ENTRY, PCAD_THUMBNAIL_ENTRY, type ReadPcadFileResult } from '../../packages/io/src/index.js';
import { UNDO_LIMIT } from '../../packages/model/src/index.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { waitForSettledRecompute } from './recompute.js';

export function canvasRow(page: Page, name: string) {
  return page.locator('.pcad-panel--right .pcad-boundary').filter({ has: page.getByText(name, { exact: true }) });
}

export async function samplePng(page: Page, color: string, width: number): Promise<Buffer> {
  const base64 = await page.evaluate(({ color, width }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 64;
    const context = canvas.getContext('2d'); if (context === null) throw new Error('Missing canvas context');
    context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { color, width });
  return Buffer.from(base64, 'base64');
}

/** 実際に描かれた画素を照合する。表示キャッシュやストアの内部値を合格根拠にしない。 */
export async function expectImage(page: Page, expected: 'A' | 'B' | 'none'): Promise<void> {
  await expect.poll(async () => {
    const screenshot = await page.locator('canvas.pcad-viewport__canvas').screenshot();
    return page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); if (context === null) throw new Error('Missing pixel context');
      context.drawImage(image, 0, 0); image.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let a = 0, b = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
        // Orange A has green above blue; the red X axis has blue above green.
        if (red > green + 40 && red > blue + 40 && green > blue + 4) a += 1;
        if (blue > red + 40 && green > red + 40) b += 1;
      }
      return a > 500 && a > b * 3 ? 'A' : b > 500 && b > a * 3 ? 'B' : 'none';
    }, screenshot.toString('base64'));
  }, { message: `下絵 ${expected} の実画素が表示されること` }).toBe(expected);
}

export async function addImage(page: Page, name: string, bytes: Buffer): Promise<void> {
  await openToolMenu(page, '見た目');
  const choosing = page.waitForEvent('filechooser');
  await toolMenuPanel(page, '見た目').getByRole('button', { name: '下絵', exact: true }).click();
  await (await choosing).setFiles({ name, mimeType: 'image/png', buffer: bytes });
  const scale = page.locator('.pcad-canvas-scale');
  await expect(scale).toContainText('1 点目を押してください');
  await scale.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(canvasRow(page, name)).toBeVisible();
}

/** Webはdownload、Electronは実デスクトップの保存窓(Shiftで常に名前を付けて保存)を通す。 */
export async function save(page: Page, info: TestInfo, name: string, app?: ElectronApplication): Promise<Buffer> {
  if (app !== undefined) {
    const target = info.outputPath(name);
    await saveTarget(app, target);
    await fileAction(page, '保存').click({ modifiers: ['Shift'] });
    const bytes = await diskFile(target);
    await expect(page.locator('[data-save-stage="complete"]')).toBeVisible();
    return bytes;
  }
  const downloading = page.waitForEvent('download');
  await fileAction(page, '保存').click();
  const download = await downloading;
  const path = info.outputPath(name); await download.saveAs(path);
  await expect(page.locator('.pcad-statusbar')).toContainText('保存しました');
  return readFile(path);
}

/** Webはfile chooser、Electronは実デスクトップの開く窓を通す(Electronでは info が要る)。 */
export async function open(page: Page, name: string, bytes: Buffer, info?: TestInfo, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) {
    if (info === undefined) throw new Error('Electronで開くにはTestInfoが要る');
    const target = info.outputPath(name);
    await writeFile(target, bytes);
    await openTarget(app, target);
    await fileAction(page, '開く').click();
    await waitForSettledRecompute(page);
    return;
  }
  const choosing = page.waitForEvent('filechooser');
  await fileAction(page, '開く').click();
  await (await choosing).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  await waitForSettledRecompute(page);
}

export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** 保存した部品の下絵が、期待の名前・寸法(mm)・全画像のSHA-256と一致すること。 */
export function expectCanvasIdentity(saved: Extract<ReadPcadFileResult, { ok: true }>,
  expected: readonly { readonly name: string; readonly width: number; readonly height: number; readonly sha: string }[]): void {
  const found = saved.document.canvases.map(canvas => ({
    name: canvas.name, width: canvas.width.value, height: canvas.height.value,
    sha: sha256(saved.attachments.canvases.get(canvas.imageId) ?? new Uint8Array()),
  }));
  expect(found).toEqual(expected);
  expect(saved.attachments.canvases.size).toBe(expected.length);
}

export function readPart(bytes: Uint8Array): Extract<ReadPcadFileResult, { ok: true }> {
  const result = readPcadFile(bytes);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Saved part could not be read');
  return result;
}

function legacyImageId(bytes: Uint8Array): Buffer {
  const saved = readPart(bytes);
  expect(saved.document.canvases).toHaveLength(1);
  const canvas = saved.document.canvases[0];
  const image = saved.attachments.canvases.get(canvas.imageId);
  if (image === undefined) throw new Error('Missing saved image');
  return Buffer.from(writePcadFile({ ...saved.document, canvases: [{ ...canvas, imageId: 'canvas-1' }] }, {
    attachments: { ...saved.attachments, canvases: new Map([['canvas-1', image]]) },
  }));
}

/** futureの画像を新しい分岐で捨て、実操作で履歴上限を越えても必要な画像を保存する。 */
async function historyRetentionFlow(page: Page, info: TestInfo, imageA: Buffer, imageB: Buffer, app?: ElectronApplication): Promise<void> {
  await canvasRow(page, 'A.png').getByRole('button', { name: 'A.png を削除', exact: true }).click();
  await addImage(page, 'B.png', imageB);
  await page.keyboard.press('Control+z'); await expect(canvasRow(page, 'B.png')).toHaveCount(0);
  await addImage(page, 'branch-A.png', imageA);
  await page.keyboard.press('Control+y');
  await expect(canvasRow(page, 'B.png')).toHaveCount(0); await expectImage(page, 'A');
  const branch = readPart(await save(page, info, 'canvas-new-branch.pcad', app));
  expect(branch.document.canvases).toHaveLength(1); expect(branch.attachments.canvases.size).toBe(1);
  expect(Buffer.from(branch.attachments.canvases.get(branch.document.canvases[0].imageId) ?? [])).toEqual(imageA);

  const row = canvasRow(page, 'branch-A.png');
  const opacity = row.getByRole('textbox', { name: '濃さ branch-A.png', exact: true });
  for (let edit = 0; edit <= UNDO_LIMIT; edit += 1) {
    await opacity.fill(edit % 2 === 0 ? '0.6' : '0.7'); await opacity.press('Enter');
  }
  // 文書のUndoへ渡すため入力欄から離れる。過去の下絵追加へは戻れない。
  await opacity.press('Tab');
  for (let edit = 0; edit < UNDO_LIMIT; edit += 1) await page.keyboard.press('Control+z');
  await expect(opacity).toHaveValue('0.6');
  await page.keyboard.press('Control+z'); await expect(opacity).toHaveValue('0.6');
  await expect(row).toBeVisible(); await expectImage(page, 'A');
  await opacity.fill('0.8'); await opacity.press('Enter'); await opacity.press('Tab');
  await page.keyboard.press('Control+y'); await expect(opacity).toHaveValue('0.8');
  const afterLimit = readPart(await save(page, info, 'canvas-history-limit.pcad', app));
  expect(afterLimit.document.canvases).toHaveLength(1); expect(afterLimit.attachments.canvases.size).toBe(1);
  expect(afterLimit.document.canvases[0].opacity.value).toBe(0.8);
  expect(Buffer.from(afterLimit.attachments.canvases.get(afterLimit.document.canvases[0].imageId) ?? [])).toEqual(imageA);
}

/** 実画像選択→削除→追加→Undo/Redo→実保存再開→旧画像IDの部品切替。 */
export async function canvasAssetLifetimeFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  // An empty real viewport still draws the grid and axes.
  await expectImage(page, 'none');
  const imageA = await samplePng(page, 'rgb(240, 80, 20)', 128);
  const imageB = await samplePng(page, 'rgb(20, 210, 230)', 256);
  await addImage(page, 'A.png', imageA); await expectImage(page, 'A');
  await canvasRow(page, 'A.png').getByRole('button', { name: 'A.png を削除', exact: true }).click();
  await expect(canvasRow(page, 'A.png')).toHaveCount(0);
  await expectImage(page, 'none');
  await addImage(page, 'B.png', imageB); await expectImage(page, 'B');
  await page.keyboard.press('Control+z');
  await expect(canvasRow(page, 'B.png')).toHaveCount(0);
  await expectImage(page, 'none');
  await page.keyboard.press('Control+z');
  await expect(canvasRow(page, 'A.png')).toContainText('100 × 50');
  await expectImage(page, 'A');
  const savedA = await save(page, info, 'restored-A.pcad', app);
  const parsedA = readPart(savedA), canvasA = parsedA.document.canvases[0];
  expect(parsedA.attachments.canvases.size).toBe(1);
  expectCanvasIdentity(parsedA, [{ name: 'A.png', width: 100, height: 50, sha: sha256(imageA) }]);
  expect(Buffer.from(parsedA.attachments.canvases.get(canvasA.imageId) ?? [])).toEqual(imageA);
  await page.keyboard.press('Control+y');
  await expect(canvasRow(page, 'A.png')).toHaveCount(0);
  await expectImage(page, 'none');
  await page.keyboard.press('Control+y');
  await expect(canvasRow(page, 'B.png')).toContainText('100 × 25');
  await expectImage(page, 'B');
  const savedB = await save(page, info, 'redone-B.pcad', app);
  const parsedB = readPart(savedB), canvasB = parsedB.document.canvases[0];
  expect(canvasB.imageId).not.toBe(canvasA.imageId);
  expect(parsedB.attachments.canvases.size).toBe(1);
  expectCanvasIdentity(parsedB, [{ name: 'B.png', width: 100, height: 25, sha: sha256(imageB) }]);
  expect(Buffer.from(parsedB.attachments.canvases.get(canvasB.imageId) ?? [])).toEqual(imageB);

  // Hiding preserves the image in the actual ZIP; deletion removes it.
  const visibility = canvasRow(page, 'B.png').getByRole('button', { name: 'B.png の表示を切り替える', exact: true });
  await visibility.click();
  await expectImage(page, 'none');
  const hiddenBytes = await save(page, info, 'hidden-B.pcad', app), hidden = readPart(hiddenBytes);
  expect(hidden.document.canvases).toHaveLength(1);
  expect(hidden.document.canvases[0].visible).toBe(false);
  expect(hidden.attachments.canvases.size).toBe(1);
  expect(Buffer.from(hidden.attachments.canvases.get(canvasB.imageId) ?? [])).toEqual(imageB);
  await visibility.click();
  await expectImage(page, 'B');
  await canvasRow(page, 'B.png').getByRole('button', { name: 'B.png を削除', exact: true }).click();
  await expectImage(page, 'none');
  const deleted = await save(page, info, 'deleted.pcad', app);
  expect(readPart(deleted).attachments.canvases.size).toBe(0);
  expect(deleted.includes(Buffer.from(`canvases/${canvasB.imageId}.png`))).toBe(false);
  expect(readPart(deleted).document.canvases).toHaveLength(0);
  await info.attach('r20-canvas-two-examples', { contentType: 'application/json', body: JSON.stringify({
    schema: 1, environment: info.project.name, osImeCertified: false,
    deleteUndo: { sequence: ['add A', 'delete A', 'add B', 'Undo', 'Undo', 'save'],
      pngSha256: sha256(imageA), zipSha256: sha256(savedA), documentSha256: sha256(Buffer.from(JSON.stringify(parsedA.document))),
      name: canvasA.name, width: canvasA.width.value, height: canvasA.height.value, attachmentCount: parsedA.attachments.canvases.size },
    deleteSave: { sequence: ['delete B', 'save'], zipSha256: sha256(deleted),
      documentSha256: sha256(Buffer.from(JSON.stringify(readPart(deleted).document))), canvasCount: 0, attachmentCount: 0 },
    hiddenSave: { zipSha256: sha256(hiddenBytes), pngSha256: sha256(imageB), canvasCount: 1, attachmentCount: 1 },
  }) });
  await page.keyboard.press('Control+z'); await expectImage(page, 'B');
  await save(page, info, 'undo-delete.pcad', app);
  await open(page, 'deleted-reopen.pcad', deleted, info, app);
  await expect(canvasRow(page, 'A.png')).toHaveCount(0);
  await expectImage(page, 'none');
  await expect(canvasRow(page, 'B.png')).toHaveCount(0);
  const reopenedDeleted = await save(page, info, 'deleted-reopened.pcad', app);
  expect(readPart(reopenedDeleted).document.canvases).toHaveLength(0);
  expect(readPart(reopenedDeleted).attachments.canvases.size).toBe(0);
  await info.attach('r20-delete-save-reopen', { contentType: 'application/json', body: JSON.stringify({
    environment: info.project.name, inputZipSha256: sha256(deleted), reopenedZipSha256: sha256(reopenedDeleted),
    canvasCount: 0, attachmentCount: 0, fullProcessColdCertified: false,
  }) });


  for (const [name, bytes, expected] of [
    ['restored-A.pcad', savedA, 'A'], ['redone-B.pcad', savedB, 'B'],
    ['legacy-A.pcad', legacyImageId(savedA), 'A'], ['legacy-B.pcad', legacyImageId(savedB), 'B'],
    ['legacy-A-again.pcad', legacyImageId(savedA), 'A'],
  ] as const) {
    await open(page, name, bytes, info, app);
    await expect(canvasRow(page, `${expected}.png`)).toBeVisible();
    await expectImage(page, expected);
  }
  // 開いた文書は新しい履歴から始まる(2026-10-05)。Undo/Redo しても前に開いた B へ戻らず、
  // 保存する文書も画像も開いた A のまま。
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+z');
  await expect(canvasRow(page, 'A.png')).toBeVisible(); await expect(canvasRow(page, 'B.png')).toHaveCount(0);
  await expectImage(page, 'A');
  const switchedBack = readPart(await save(page, info, 'undo-open-A.pcad', app));
  expect(switchedBack.attachments.canvases.size).toBe(1);
  expectCanvasIdentity(switchedBack, [{ name: 'A.png', width: 100, height: 50, sha: sha256(imageA) }]);
  expect(Buffer.from(switchedBack.attachments.canvases.get(switchedBack.document.canvases[0].imageId) ?? [])).toEqual(imageA);
  await page.keyboard.press('Control+y');
  await expect(canvasRow(page, 'A.png')).toBeVisible(); await expect(canvasRow(page, 'B.png')).toHaveCount(0);
  await expectImage(page, 'A');
  const switchedAgain = readPart(await save(page, info, 'redo-open-A.pcad', app));
  expect(switchedAgain.attachments.canvases.size).toBe(1);
  expectCanvasIdentity(switchedAgain, [{ name: 'A.png', width: 100, height: 50, sha: sha256(imageA) }]);
  expect(Buffer.from(switchedAgain.attachments.canvases.get(switchedAgain.document.canvases[0].imageId) ?? [])).toEqual(imageA);
  await historyRetentionFlow(page, info, imageA, imageB, app);
  await page.screenshot({ path: info.outputPath('canvas-asset-restored.png') });
}

export type CanvasColdState = 'deleted' | 'visible' | 'off';
export interface CanvasColdReceipt { readonly bytes: Buffer; readonly state: CanvasColdState; readonly pngSha256: string; readonly inputZipSha256: string; readonly saveStarted: number; readonly saveFinished: number }

/** Produce actual saved bytes using the same image picker and desktop/download helpers. */
export async function prepareCanvasCold(page: Page, info: TestInfo, state: CanvasColdState, app?: ElectronApplication): Promise<CanvasColdReceipt> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  // An empty real viewport still draws the grid and axes.
  await expectImage(page, 'none');
  const image = await samplePng(page, 'rgb(20, 210, 230)', 256);
  await addImage(page, 'B.png', image); await expectImage(page, 'B');
  const row = canvasRow(page, 'B.png');
  if (state === 'off') await row.getByRole('button', { name: 'B.png の表示を切り替える', exact: true }).click();
  if (state === 'deleted') await row.getByRole('button', { name: 'B.png を削除', exact: true }).click();
  if (state !== 'visible') await expectImage(page, 'none');
  const saveStarted = Date.now();
  const bytes = await save(page, info, 'cold-' + state + '-original.pcad', app);
  const saveFinished = Date.now();
  assertColdEnvelope(bytes, saveStarted, saveFinished);
  const parsed = readPart(bytes);
  if (state === 'deleted') {
    expect(parsed.document.canvases).toHaveLength(0); expect(parsed.attachments.canvases.size).toBe(0);
    // This undo belongs only to the old process, and must not become cold history.
    await page.keyboard.press('Control+z'); await expectImage(page, 'B');
  } else {
    expectCanvasIdentity(parsed, [{ name: 'B.png', width: 100, height: 25, sha: sha256(image) }]);
    expect(parsed.document.canvases[0].visible).toBe(state === 'visible');
  }
  return { bytes, state, pngSha256: sha256(image), inputZipSha256: sha256(bytes), saveStarted, saveFinished };
}

/** Called only after the wrapper has awaited old process close and launched a new process. */
export async function verifyCanvasCold(page: Page, info: TestInfo, receipt: CanvasColdReceipt, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  // An empty real viewport still draws the grid and axes.
  await expectImage(page, 'none');
  expect(sha256(receipt.bytes)).toBe(receipt.inputZipSha256);
  await info.attach('cold-' + receipt.state + '-original.pcad', { body: receipt.bytes, contentType: 'application/zip' });
  // Exact real saved bytes are checked immediately before the new process's open command.
  await open(page, 'cold-' + receipt.state + '-input.pcad', receipt.bytes, info, app);
  if (app !== undefined) expect(sha256(await diskFile(info.outputPath('cold-' + receipt.state + '-input.pcad')))).toBe(receipt.inputZipSha256);
  const original = readPart(receipt.bytes);
  if (receipt.state === 'deleted') {
    await expect(canvasRow(page, 'B.png')).toHaveCount(0);
    await expectImage(page, 'none');
  }
  else {
    const row = canvasRow(page, 'B.png'); await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'B.png の表示を切り替える', exact: true }))
      .toHaveAttribute('aria-pressed', (receipt.state === 'visible').toString());
    await expectImage(page, receipt.state === 'visible' ? 'B' : 'none');
  }
  const saveStarted = Date.now();
  const saved = await save(page, info, 'cold-' + receipt.state + '-reopened.pcad', app), parsed = readPart(saved);
  const saveFinished = Date.now();
  const originalArchive = assertColdEnvelope(receipt.bytes, receipt.saveStarted, receipt.saveFinished);
  const savedArchive = assertColdEnvelope(saved, saveStarted, saveFinished);
  expect(savedArchive.nonTimestampEnvelope).toEqual(originalArchive.nonTimestampEnvelope);
  // Only thumbnail is separately recorded; every other entry name/content must survive.
  expect([...savedArchive.entries.keys()].filter(name => name !== PCAD_THUMBNAIL_ENTRY).sort())
    .toEqual([...originalArchive.entries.keys()].filter(name => name !== PCAD_THUMBNAIL_ENTRY).sort());
  for (const [name, bytes] of originalArchive.entries) {
    if (name !== PCAD_DOCUMENT_ENTRY && name !== PCAD_THUMBNAIL_ENTRY)
      expect(Buffer.from(savedArchive.entries.get(name) ?? [])).toEqual(Buffer.from(bytes));
  }
  expect(parsed.document).toEqual(original.document);
  expect([...parsed.attachments.canvases.keys()]).toEqual([...original.attachments.canvases.keys()]);
  for (const [id, image] of original.attachments.canvases) {
    expect(Buffer.from(parsed.attachments.canvases.get(id) ?? [])).toEqual(Buffer.from(image));
    expect(sha256(image)).toBe(receipt.pngSha256);
  }
  // Different actual saves update savedAt. Raw input/output ZIP SHAs are recorded, never forced equal.
  // Opening must create fresh history, rather than reviving the old deletion undo.
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toBeDisabled();
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expectImage(page, receipt.state === 'visible' ? 'B' : 'none');
  const undoSaveStarted = Date.now();
  const undoBytes = await save(page, info, 'cold-' + receipt.state + '-undo.pcad', app), afterUndo = readPart(undoBytes);
  const undoArchive = assertColdEnvelope(undoBytes, undoSaveStarted, Date.now());
  expect(undoArchive.nonTimestampEnvelope).toEqual(originalArchive.nonTimestampEnvelope);
  expect([...undoArchive.entries.keys()].filter(name => name !== PCAD_THUMBNAIL_ENTRY).sort())
    .toEqual([...originalArchive.entries.keys()].filter(name => name !== PCAD_THUMBNAIL_ENTRY).sort());
  for (const [name, bytes] of originalArchive.entries) {
    if (name !== PCAD_DOCUMENT_ENTRY && name !== PCAD_THUMBNAIL_ENTRY)
      expect(Buffer.from(undoArchive.entries.get(name) ?? [])).toEqual(Buffer.from(bytes));
  }
  expect(afterUndo.document).toEqual(original.document);
  expect([...afterUndo.attachments.canvases.entries()]).toEqual([...original.attachments.canvases.entries()]);
  await info.attach('r20-process-cold-' + receipt.state, { contentType: 'application/json', body: JSON.stringify({
    environment: info.project.name, state: receipt.state, processRestartAwaited: true,
    inputZipSha256: sha256(receipt.bytes), reopenedZipSha256: sha256(saved),
    documentSha256: sha256(Buffer.from(JSON.stringify(parsed.document))),
    pngSha256: receipt.state === 'deleted' ? null : receipt.pngSha256,
    attachmentCount: parsed.attachments.canvases.size, freshHistory: true,
    inputSavedAt: originalArchive.savedAt, reopenedSavedAt: savedArchive.savedAt,
    inputSaveWindow: [receipt.saveStarted, receipt.saveFinished], reopenedSaveWindow: [saveStarted, saveFinished],
    nonTimestampEnvelopeEqual: true, allNonThumbnailEntriesEqual: true,
    thumbnail: { inputSha256: originalArchive.thumbnailSha256, reopenedSha256: savedArchive.thumbnailSha256,
      equalityAsserted: false, status: 'separate evidence; render equivalence unverified' },
  }) });
}

/** Inspect every raw envelope field; exclude exactly savedAt, never unknown fields. */
function assertColdEnvelope(bytes: Uint8Array, saveStarted: number, saveFinished: number) {
  const archive = readArchive(bytes, { shouldExtract: () => true });
  expect(archive.ok).toBe(true); if (!archive.ok) throw new Error(archive.error.reason);
  const document = archive.entries.get(PCAD_DOCUMENT_ENTRY); if (document === undefined) throw new Error('Missing raw document envelope');
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid document envelope');
  const savedAt: unknown = Reflect.get(parsed, 'savedAt');
  if (typeof savedAt !== 'string') throw new Error('Missing actual savedAt');
  const instant = Date.parse(savedAt); expect(Number.isFinite(instant)).toBe(true);
  expect(new Date(instant).toISOString()).toBe(savedAt);
  expect(instant).toBeGreaterThanOrEqual(saveStarted); expect(instant).toBeLessThanOrEqual(saveFinished);
  const nonTimestampEnvelope = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'savedAt'));
  const thumbnail = archive.entries.get(PCAD_THUMBNAIL_ENTRY);
  return { entries: archive.entries, nonTimestampEnvelope, savedAt,
    thumbnailSha256: thumbnail === undefined ? null : sha256(thumbnail) };
}
