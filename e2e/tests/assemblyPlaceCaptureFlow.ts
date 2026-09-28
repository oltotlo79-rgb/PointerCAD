/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { boxPartFile, installAssemblyFileGateway } from './assemblyTestSupport.js';
import {
  commitPlacePartDialog, openPlacePartDialog, startNewAssemblyCapture,
} from './assemblyCaptureSupport.js';

/**
 * 「部品を配置する」章の1枚(`packages/help-content/docs/ja/assembly-place.md`)。
 *
 * 1) assembly-place-dialog: 新規アセンブリで「組む」→「部品を置く」を開き、位置の入力欄が
 *    出た画面(§アセンブリを開き、上の組むから部品を置くを選びます)。
 */
export async function assemblyPlaceCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startNewAssemblyCapture(page);
  await installAssemblyFileGateway(page, { parts: [{ fileName: '箱.pcad', bytes: boxPartFile() }] });

  const dialog = await openPlacePartDialog(page);
  await captureManualDetail(page, info, {
    name: 'assembly-place-dialog', dialog,
    fixture: { part: '箱.pcad' }, script: new URL(import.meta.url),
  });
  await commitPlacePartDialog(page, dialog);
}
