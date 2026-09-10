/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { readDrawingBundle } from '../../packages/io/src/index.js';
import { fullManufacturingDrawing } from './gdtFullFixture.js';
import { expectDrawingStroke } from './drawingManufacturingFixture.js';
import { drawingMessage as m } from './drawingMessages.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

test('P9 図面の控えを起動時に案内し、全14公差・8溶接を復元して再保存まで保持する', async ({ page }, testInfo) => {
  const fixture = await fullManufacturingDrawing();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  const opening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await opening).setFiles({ name: '製作指示.pcadd', mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes) });
  const owner = (id: string) => page.locator(`.pcad-drawing-svg [data-owner-id="${id}"]`);
  await expect(owner('gdt-14').locator('[aria-label="0.05"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.locator('.pcad-panel--left').getByRole('button', { name: '幾何公差 14', exact: true }).click();
  const form = page.getByRole('form', { name: m('drawing.gdt.title'), exact: true });
  await form.getByLabel(m('drawing.gdt.value'), { exact: true }).fill('0.2/2');
  await form.getByRole('button', { name: m('drawing.action.apply'), exact: true }).click();
  await expect(owner('gdt-14').locator('[aria-label="0.1"]')).toHaveCount(1);
  const saving = page.waitForEvent('download'); await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Control+s');
  const saved = await saving, savedPath = await saved.path(); if (savedPath === null) throw new Error('保存ファイルなし');
  const bytes = await readFile(savedPath), original = await readDrawingBundle(bytes); if (!original.ok) throw new Error('保存した図面が読めない');
  // アプリ自身の保存バイト列を、異常終了時のIndexedDBの控えとして残す。タイマーはユニットで別途検査する。
  await page.evaluate(async (data) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pointercad', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('autosave')) request.result.createObjectStore('autosave'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('控えの保管庫を開けない'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('autosave', 'readwrite');
        transaction.objectStore('autosave').put({ kind: 'drawing', documentId: 'recovery-drawing', sessionId: 'previous-window',
          documentName: data.name, savedAt: '2026-09-10T00:00:00Z', bytes: Uint8Array.from(atob(data.base64), (value) => value.charCodeAt(0)) },
        'drawing:recovery-drawing:previous-window');
        transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('控えを保存できない'));
      });
    } finally { database.close(); }
  }, { base64: bytes.toString('base64'), name: original.document.name });
  await page.reload();
  const prompt = page.locator('.pcad-restore');
  await expect(prompt).toContainText('図面の名前'); await expect(prompt).toContainText(original.document.name);
  await page.screenshot({ path: testInfo.outputPath('drawing-recovery-prompt.png'), fullPage: true });
  await prompt.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(owner('gdt-14').locator('[aria-label="0.1"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  for (const item of [...original.document.gdtFrames, ...original.document.datums, ...original.document.weldSymbols]) await expectDrawingStroke(owner(item.id).locator('path'));
  await expect(page.getByRole('alert').filter({ hasText: m('drawing.manufacturing.outputUnresolved') })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('drawing-recovery-restored.png'), fullPage: true });
  const resaving = page.waitForEvent('download'); await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Control+s');
  const restored = await resaving; await restored.saveAs(testInfo.outputPath('drawing-recovered.pcadd'));
  const restoredPath = await restored.path(); if (restoredPath === null) throw new Error('再保存ファイルなし');
  const read = await readDrawingBundle(await readFile(restoredPath)); if (!read.ok) throw new Error('再保存が読めない');
  expect(read.document).toEqual(original.document); expect(read.source).toEqual(original.source);
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pointercad', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('保管庫を読めない'));
    });
    try { return await new Promise<number>((resolve, reject) => {
      const request = database.transaction('autosave', 'readonly').objectStore('autosave').count();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('控えの件数を読めない'));
    }); } finally { database.close(); }
  })).toBe(0);
  await page.reload(); await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible(); await expect(prompt).toHaveCount(0);
  expect(errors).toEqual([]);
});
