/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { chooseToolMenuItem, installAssemblyFileGateway, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { assemblyTreePanel, startNewAssemblyCapture, treeSectionRows } from './assemblyCaptureSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

/**
 * 「部品を差し替える・組を置く」章の1枚(`packages/help-content/docs/ja/replace-subassembly.md`)。
 *
 * 1) replace-subassembly-placed: 空のアセンブリへ「組む」→「サブアセンブリを置く」で
 *    2部品の組をまとめて置いた直後、左の一覧に組(サブアセンブリ)が現れた画面
 *    (§別のアセンブリをまとめて置くときはサブアセンブリを置くを選び、.pcadaファイルを開きます)。
 *
 * 「置換する」(不一致の予告ダイアログ)は、置き換え前後で選び直せない対象を作るために
 * 実際の面の形状指紋(fingerprint)が必要で、この撮影担当の範囲では安全に再現できる
 * fixtureを用意できなかった(origin系の対象は箱・球のどちらでも一致するため不一致が
 * 起きない)。章の後半にある「サブアセンブリを置く」を代わりに撮影し、報告に理由を記す。
 */
export async function replaceSubassemblyCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startNewAssemblyCapture(page);

  const sub = await twoBoxAssemblyFile(30);
  await installAssemblyFileGateway(page, { documents: [{ name: '部品セット.pcada', bytes: sub }] });
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, '組む', 'サブアセンブリを置く');
  await waitForRecompute(page, token);
  await expect(treeSectionRows(page, '部品')).toHaveCount(1);

  const panel = assemblyTreePanel(page);
  await captureManualDetail(page, info, {
    name: 'replace-subassembly-placed', dialog: panel,
    fixture: { placedSubAssembly: '部品セット.pcada' }, script: new URL(import.meta.url),
  });
}
