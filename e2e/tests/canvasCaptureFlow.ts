/// <reference lib="dom" />
import { deflateSync } from 'node:zlib';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { clickWorldPoint } from './workPlaneCaptureSupport.js';
import { addImage, canvasRow, expectCanvasIdentity, expectImage, open, readPart, save, sha256 } from './canvasAssetLifetimeFlow.js';

/**
 * 撮影用の最小のPNGをその場で組み立てる(node:zlib だけで足りる。単色の正方形)。
 * `e2e/tests/` の外へテスト資産を足さずに済ませるため(編集可の範囲を超えない)。
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, Buffer.from(data), crc]);
}
function makeSolidSquarePng(sizePx: number, rgb: readonly [number, number, number]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(sizePx, 0); ihdr.writeUInt32BE(sizePx, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = sizePx * 3 + 1;
  const raw = Buffer.alloc(stride * sizePx);
  for (let y = 0; y < sizePx; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < sizePx; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = rgb[0]; raw[offset + 1] = rgb[1]; raw[offset + 2] = rgb[2];
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]);
}

/**
 * 「下絵を敷く」章の2枚(`packages/help-content/docs/ja/canvas.md`)。
 *
 * 1) canvas-placed: 画像を選んだ直後、下絵がXY面に貼られ「寸法を合わせる」へ
 *    誘われた状態(§敷きかた)。まだ1点目も指していない。
 * 2) canvas-scale-length: 画像の上で2点を指し、実寸を打った状態(§大きさを合わせる)。
 *
 * 下絵は100×100画素の正方形PNG(既定の貼り付け幅100mmで、アスペクト比1:1のため
 * XY面の (-50,-50)〜(50,50) に置かれる。`newSketchCanvas` の既定値)。
 */
export async function canvasCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  const png = makeSolidSquarePng(100, [176, 176, 176]);

  await openToolMenu(page, '見た目');
  const chooser = page.waitForEvent('filechooser');
  await toolMenuPanel(page, '見た目').getByRole('button', { name: '下絵', exact: true }).click();
  await (await chooser).setFiles({ name: 'sketch.png', mimeType: 'image/png', buffer: png });

  // 1) 貼った直後、寸法合わせへ誘われた状態(まだ1点目を指す前)。
  const scalePopover = page.locator('.pcad-canvas-scale');
  await expect(scalePopover).toBeVisible();
  await expect(scalePopover).toContainText('1 点目を押してください');
  await captureManualDetail(page, info, {
    name: 'canvas-placed', dialog: scalePopover,
    fixture: { plane: 'xy', widthMm: 100, heightMm: 100 }, script: new URL(import.meta.url),
  });

  // 2) 画像の中心を通る横のライン(-50,0,0)〜(50,0,0)を指し、実寸150mmと打つ。
  await clickWorldPoint(page, [-50, 0, 0]);
  await expect(scalePopover).toContainText('2 点目を押してください');
  await clickWorldPoint(page, [50, 0, 0]);
  await scalePopover.locator('input.pcad-field__input').fill('150');
  await expect(scalePopover).toContainText('= 150');
  await captureManualDetail(page, info, {
    name: 'canvas-scale-length', dialog: scalePopover,
    fixture: { points: [[-50, 0, 0], [50, 0, 0]], realLengthMm: 150 }, script: new URL(import.meta.url),
  });
  await scalePopover.getByRole('button', { name: '寸法を合わせる', exact: true }).click();
  await expect(scalePopover).toHaveCount(0);
  await canvasRow(page, 'sketch.png').getByRole('button', { name: 'sketch.png を削除', exact: true }).click();

  const imageA = makeSolidSquarePng(100, [240, 80, 20]);
  const imageB = makeSolidSquarePng(100, [20, 180, 240]);
  await info.attach('canvas-example-A.png', { contentType: 'image/png', body: imageA });
  await info.attach('canvas-example-B.png', { contentType: 'image/png', body: imageB });
  await addImage(page, 'A.png', imageA);
  await expectImage(page, 'A');
  const originalBytes = await save(page, info, 'canvas-example-A-original.pcad');
  const original = readPart(originalBytes);
  expectCanvasIdentity(original, [{ name: 'A.png', width: 100, height: 100, sha: sha256(imageA) }]);
  await canvasRow(page, 'A.png').getByRole('button', { name: 'A.png を削除', exact: true }).click();
  await addImage(page, 'B.png', imageB);
  await expectImage(page, 'B');
  await page.locator('canvas.pcad-viewport__canvas').click();
  await page.keyboard.press('Control+z');
  await expect(canvasRow(page, 'B.png')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expectImage(page, 'A');
  const restoredBytes = await save(page, info, 'canvas-example-A-restored.pcad');
  const restored = readPart(restoredBytes);
  expect(restored.document).toEqual(original.document);
  expect(restored.document.canvases[0].visible).toBe(true);
  expectCanvasIdentity(restored, [{ name: 'A.png', width: 100, height: 100, sha: sha256(imageA) }]);
  await captureManualDetail(page, info, {
    name: 'canvas-delete-undo', dialog: canvasRow(page, 'A.png'),
    fixture: { actions: ['add A', 'delete A', 'add B', 'Undo', 'Undo', 'save'], imageSha256: sha256(imageA), savedZipSha256: sha256(restoredBytes) }, script: new URL(import.meta.url),
  });
  await open(page, 'canvas-example-A-restored.pcad', restoredBytes);
  await expectImage(page, 'A');
  await canvasRow(page, 'A.png').getByRole('button', { name: 'A.png を削除', exact: true }).click();
  await addImage(page, 'B.png', imageB);
  await canvasRow(page, 'B.png').getByRole('button', { name: 'B.png を削除', exact: true }).click();
  await expectImage(page, 'none');
  const deletedBytes = await save(page, info, 'canvas-example-B-deleted.pcad');
  const deleted = readPart(deletedBytes);
  expect(deleted.document.canvases).toHaveLength(0);
  expect(deleted.attachments.canvases.size).toBe(0);
  await open(page, 'canvas-example-B-deleted.pcad', deletedBytes);
  await expect(canvasRow(page, 'B.png')).toHaveCount(0);
  await expectImage(page, 'none');
  await captureManualDetail(page, info, {
    name: 'canvas-delete-save', dialog: page.locator('.pcad-panel--right'),
    fixture: { actions: ['add B', 'delete B', 'save', 'reopen'], savedZipSha256: sha256(deletedBytes), attachmentCount: 0, fullProcessColdCertified: false }, script: new URL(import.meta.url),
  });
  await info.attach('r20-canvas-materials', { contentType: 'application/json', body: JSON.stringify({
    schema: 1, originalZipSha256: sha256(originalBytes), restoredZipSha256: sha256(restoredBytes), deletedZipSha256: sha256(deletedBytes),
    imageASha256: sha256(imageA), imageBSha256: sha256(imageB), fullProcessColdCertified: false, publicationRegistered: false,
  }) });
}
