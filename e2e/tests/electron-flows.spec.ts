/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { readDrawingBundle } from '../../packages/io/src/index.js';
import { beginRecompute, waitForRecompute, KERNEL_TIMEOUT_MS } from './recompute.js';
import { launchDesktop, openTarget, saveTarget, diskFile } from './electronAppFlow.js';

async function menu(page: Page, group: string, item: string): Promise<void> {
  const section = page.locator('.pcad-toolbar .pcad-toolbar__group').filter({
    has: page.locator('.pcad-toolbar__group-label', { hasText: new RegExp(`^${group}$`, 'u') }),
  });
  await section.locator('.pcad-menu__trigger').click();
  await section.getByRole('button', { name: item, exact: true }).click();
}

test('実Electronで新規の箱・図面・保存再開・復元・出力・F1を通す（R12）', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
    expect(page.url()).toBe('app://pointercad/index.html');
    await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
    expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied');
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
    await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
    const created = await beginRecompute(page);
    await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
    await waitForRecompute(page, created);
    if (await page.locator('.pcad-popover').count()) await page.locator('.pcad-popover input').first().press('Escape');
    const partPath = join(directory, '日本語の部品.pcad');
    await saveTarget(app, partPath);
    await page.locator('canvas.pcad-viewport__canvas').focus();
    await page.keyboard.press('Control+s');
    await diskFile(partPath);
    await page.reload();
    await openTarget(app, partPath);
    await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
    const reopened = await beginRecompute(page);
    await page.getByRole('button', { name: '開く', exact: true }).click();
    await waitForRecompute(page, reopened);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    const strokes = page.locator('.pcad-drawing-svg [data-owner-id="view-3"] path');
    await expect.poll(() => strokes.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
    const drawingPath = join(directory, '日本語の図面.pcadd');
    await saveTarget(app, drawingPath);
    await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Control+s');
    const drawingBytes = await diskFile(drawingPath);
    const drawing = await readDrawingBundle(drawingBytes);
    if (!drawing.ok) throw new Error('実Electronが保存した図面を読めません');
    for (const format of ['pdf', 'svg']) {
      const outputPath = join(directory, `図面.${format}`);
      await saveTarget(app, outputPath);
      await menu(page, 'ファイル', '図面を書き出す');
      const form = page.getByRole('form', { name: '図面を書き出す', exact: true });
      await form.getByLabel('ファイルの種類', { exact: true }).selectOption(format);
      await form.getByRole('button', { name: '書き出す', exact: true }).click();
      const bytes = await diskFile(outputPath);
      if (format === 'pdf') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      else expect(bytes.toString()).toContain('<svg');
      await expect(form).toHaveCount(0);
    }
    await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('F1');
    await expect(page.locator('.pcad-help')).toBeVisible();
    const helpImage = page.locator('.pcad-help img').first();
    await helpImage.scrollIntoViewIfNeeded();
    await expect.poll(() => helpImage.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pcad-help')).toHaveCount(0);
    // 前回異常終了のfixtureには実アプリが保存した内容を使う。自動保存タイマーの実動作とは区別する。
    await page.evaluate(async (record) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('pointercad', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('autosave', 'readwrite');
          transaction.objectStore('autosave').put({ kind: 'drawing', documentId: record.id, sessionId: 'native-previous-session',
            documentName: record.name, savedAt: new Date().toISOString(), bytes: Uint8Array.from(atob(record.base64), (char) => char.charCodeAt(0)) },
          `drawing:${record.id}:native-previous-session`);
          transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
      } finally { database.close(); }
    }, { id: drawing.document.id, name: drawing.document.name, base64: drawingBytes.toString('base64') });
    await page.reload();
    const prompt = page.locator('.pcad-restore');
    await expect(prompt).toContainText(drawing.document.name);
    await prompt.getByRole('button', { name: '復元する', exact: true }).click();
    await expect(prompt).toHaveCount(0);
    await expect.poll(() => strokes.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    const restoredPath = join(directory, '復元後.pcadd');
    await saveTarget(app, restoredPath);
    await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Control+s');
    const restored = await readDrawingBundle(await diskFile(restoredPath));
    if (!restored.ok) throw new Error('復元後の保存を読めません');
    expect(restored.document).toEqual(drawing.document); expect(restored.source).toEqual(drawing.source);
    await page.screenshot({ path: info.outputPath('native-restored.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await writeFile(info.outputPath('native-closed.json'), JSON.stringify({ closed: true }));
  }
});
