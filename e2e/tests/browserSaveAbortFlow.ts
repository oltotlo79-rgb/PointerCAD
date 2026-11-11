/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { waitForStartupHealth } from './startupHealth.js';
import { fileAction, writeAutoSaveRecord } from './fileCaptureSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

interface AbortAudit { readonly calls: string[]; readonly current: number[]; readonly recovery: number[] }
declare global {
  interface Window {
    pcadAbortAudit?: () => Promise<AbortAudit>;
    pcadAbortPhase?: (phase: 'write' | 'close' | 'success', abortThrows: boolean) => void;
    pcadAbortCleanup?: () => Promise<void>;
  }
}

/** 実OPFS writableへ実保存バイトを書いてから障害を起こす。入力・復元内容・abortは偽物へ置換しない。 */
export async function browserSaveAbortFlow(page: Page, info: TestInfo): Promise<void> {
  await waitForStartupHealth(page, info);
  const seed = await saveFlowFile(page, info.outputPath('abort-original.pcad'));
  await writeAutoSaveRecord(page, seed.toString('base64'), '2026-10-04T00:00:00.000Z');
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (const [index, value] of ['5', '5', '0'].entries()) await fields.nth(index).fill(value);
  const recompute = await beginRecompute(page); await fields.first().press('Enter'); await page.keyboard.press('Escape');
  await waitForRecompute(page, recompute);
  await expect(page.locator('.pcad-statusbar__file')).toContainText('*');
  await page.evaluate(async original => {
    const directory = await navigator.storage.getDirectory();
    const name = `abort-${crypto.randomUUID()}.pcad`, handle = await directory.getFileHandle(name, { create: true });
    const initial = await handle.createWritable(); await initial.write(new Uint8Array(original)); await initial.close();
    const calls: string[] = [];
    let phase: 'write' | 'close' | 'success' = 'write', abortThrows = false;
    window.pcadAbortPhase = (next, throws) => { phase = next; abortThrows = throws; calls.length = 0; };
    window.pcadAbortAudit = async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('pointercad', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('控えを開けません'));
      });
      const recovery = await new Promise<number[]>((resolve, reject) => {
        const request = database.transaction('autosave', 'readonly').objectStore('autosave').get('current');
        request.onsuccess = () => {
          const value: unknown = request.result;
          resolve(typeof value === 'object' && value !== null && 'bytes' in value && value.bytes instanceof Uint8Array ? [...value.bytes] : []);
        }; request.onerror = () => reject(new Error('控えを読めません'));
      });
      database.close();
      return { calls: [...calls], current: [...new Uint8Array(await (await handle.getFile()).arrayBuffer())], recovery };
    };
    window.pcadAbortCleanup = () => directory.removeEntry(name);
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: () => Promise.resolve({
      name: handle.name,
      createWritable: async () => {
        const actual = await handle.createWritable();
        return {
          write: async (bytes: Uint8Array<ArrayBuffer>) => {
            calls.push('write'); await actual.write(bytes);
            if (phase === 'write') throw new Error('injected after real write');
          },
          close: async () => { calls.push('close'); if (phase === 'close') throw new Error('injected before real close'); await actual.close(); },
          abort: async () => { calls.push('abort'); await actual.abort(); if (abortThrows) throw new Error('injected after real abort'); },
        };
      },
    }) });
  }, [...seed]);
  try {
    for (const entrance of ['document', 'export'] as const) for (const phase of ['write', 'close'] as const) for (const abortThrows of [false, true]) {
      await page.evaluate(({ phase, abortThrows }) => window.pcadAbortPhase?.(phase, abortThrows), { phase, abortThrows });
      if (entrance === 'document') await fileAction(page, '保存').click({ modifiers: ['Shift'] });
      else {
        await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
        await page.getByRole('button', { name: 'ひな形として保存', exact: true }).click();
      }
      await expect.poll(async () => (await page.evaluate(() => window.pcadAbortAudit?.()))?.calls.at(-1)).toBe('abort');
      await expect(page.locator('.pcad-statusbar__text')).toContainText('保存できませんでした');
      const audit = await page.evaluate(() => window.pcadAbortAudit?.());
      if (audit === undefined) throw new Error('OPFS記録がありません');
      expect(audit.calls).toEqual(phase === 'write' ? ['write', 'abort'] : ['write', 'close', 'abort']);
      expect(Buffer.from(audit.current)).toEqual(seed); expect(Buffer.from(audit.recovery)).toEqual(seed);
      await expect(page.locator('.pcad-statusbar__file')).toContainText('*');
      await info.attach(`opfs-${entrance}-${phase}-${abortThrows}`, { body: JSON.stringify({ calls: audit.calls,
        originalLength: seed.length, retainedLength: audit.current.length, recoveryLength: audit.recovery.length }), contentType: 'application/json' });
    }
    await page.evaluate(() => window.pcadAbortPhase?.('success', false));
    await fileAction(page, '保存').click({ modifiers: ['Shift'] });
    await expect(page.locator('[data-save-stage="complete"]')).toBeVisible();
    const final = await page.evaluate(() => window.pcadAbortAudit?.());
    if (final === undefined) throw new Error('再保存記録がありません');
    expect(final.calls).toEqual(['write', 'close']);
    const bytes = Buffer.from(final.current); expect(readPcadFile(bytes).ok).toBe(true);
    const path = info.outputPath('opfs-retry.pcad'); await writeFile(path, bytes);
    await openSaveFlowFile(page, path);
  } finally { await page.evaluate(() => window.pcadAbortCleanup?.()); }
}
