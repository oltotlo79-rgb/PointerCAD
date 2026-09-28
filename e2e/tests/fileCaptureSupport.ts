/// <reference lib="dom" />
import type { Locator, Page } from '@playwright/test';

/**
 * ファイル操作系の撮影の流れ(G1系の各章)で共通に使う補助。
 *
 * 2026-09-24 に統括の指示で、撮影の流れどうしでは補助を複製せず共有する方針へ切り替えた
 * (solidCaptureSupport.tsと同じ理由)。自動保存の控えの置き場所は
 * `packages/io/src/autoSave.ts` の既定値、書き方は `e2e/tests/solid.spec.ts` の
 * `writeAutoSaveRecord` と同じ作り。
 */

/** 自動保存の控えの置き場所(`packages/io/src/autoSave.ts` の既定値と同じ)。 */
export const AUTO_SAVE_DB_NAME = 'pointercad';
export const AUTO_SAVE_STORE_NAME = 'autosave';
export const AUTO_SAVE_RECORD_KEY = 'current';
/** 起動時の部品の名前(`createEmptyPartDocument` の `name`)。復元カードに出る。 */
export const PART_NAME = '部品1';

/** ツールバーの「ファイル」区画のボタン(新規・開く・保存)。 */
export function fileAction(page: Page, label: string): Locator {
  return page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: label, exact: true });
}
/** 下端のステータスバー全体(赤い帯かどうかは`pcad-statusbar--error`クラスで判定)。 */
export function statusBar(page: Page): Locator {
  return page.locator('.pcad-statusbar');
}
/** 前回の作業の控えがあるときの案内。無いときは0件。 */
export function restoreCard(page: Page): Locator {
  return page.locator('.pcad-restore');
}

/** 自動保存の控えを1件、頁のIndexedDBへ直に書く(`e2e/tests/solid.spec.ts` の同名補助と同じ作り)。 */
export async function writeAutoSaveRecord(page: Page, base64: string, savedAt: string): Promise<void> {
  await page.evaluate(async (record) => {
    const binary = atob(record.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(record.dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(record.storeName)) request.result.createObjectStore(record.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('自動保存のデータベースを開けませんでした'));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(record.storeName, 'readwrite');
      transaction.objectStore(record.storeName).put(
        { savedAt: record.savedAt, bytes, documentName: record.documentName }, record.key,
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('控えを書き込めませんでした'));
    });
    database.close();
  }, {
    base64, savedAt, dbName: AUTO_SAVE_DB_NAME, storeName: AUTO_SAVE_STORE_NAME,
    key: AUTO_SAVE_RECORD_KEY, documentName: PART_NAME,
  });
}
