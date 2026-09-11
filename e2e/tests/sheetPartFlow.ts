import type { Page } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';

/** 文書ツリーの表示と形状の計算完了を区別し、読込操作の世代が成功するまで待つ。 */
export async function openSheetPart(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  const token = await beginRecompute(page);
  const opening = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await opening).setFiles({ name, mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await waitForRecompute(page, token);
}
