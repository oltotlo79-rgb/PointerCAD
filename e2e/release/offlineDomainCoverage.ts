import { expect, type Page } from '@playwright/test';
import { chooseToolMenuItem } from '../tests/assemblyTestSupport.js';
import { waitForMathEditorText } from '../tests/mathEditorReady.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from '../tests/recompute.js';
import { panel as scriptPanel, successfulRun, writeDraft } from '../tests/scriptsFlow.js';
import { chooseSheet, rectangleFace, tree, volume } from '../tests/sheetUiFlow.js';
import type { serveOfflineCandidate } from './offlineCandidateServer.js';

/*
 * P12-22① (w33c-p12-22-offline-candidate): `offlineCandidate.spec.ts` の切断後の操作に、
 * 棚卸しで抜けが見つかった5領域(数学の厳密な計算・自動作図・組立・図面・板金)を
 * 小さな1操作ずつ足す。診断用の口(pcadSetFileGateway 等)はこの配布候補に無いため
 * (同specの冒頭で `toEqual([])` で確認済み)、ここでは実際のUI操作・実ファイル選択
 * (filechooser)・ダウンロードの経路だけを使い、テスト専用のfileGatewayは使わない。
 *
 * 各操作は、spec末尾の最終確認とまったく同じ判定式(サービスワーカーへの503だけ許す)で、
 * 通信を切った状態のまま想定外の要求が増えていないことも確かめる。
 */

type OfflineCandidateServer = Awaited<ReturnType<typeof serveOfflineCandidate>>;

/** `offlineCandidate.spec.ts` 末尾の unexpectedRequests と同じ判定式で件数だけを数える。 */
function unexpectedOfflineRequestCount(server: OfflineCandidateServer): number {
  return server.networkRequestsAfterDisconnect().filter(request =>
    request.path !== '/service-worker.js' || request.destination !== 'serviceworker'
    || request.serviceWorker !== 'script' || request.status !== 503).length;
}

/** 通信を切った状態で1操作を行い、その最中に想定外の要求が増えていないことを確かめる。 */
async function verifyOffline(server: OfflineCandidateServer, step: string, action: () => Promise<void>): Promise<void> {
  const before = unexpectedOfflineRequestCount(server);
  await action();
  expect(unexpectedOfflineRequestCount(server), `${step}: 通信を切った状態での想定外の要求が増えないこと`).toBe(before);
}

/**
 * (a) 数学の厳密な計算。パラメータへ数式入力で `integrate(t^2,t,0,3)` を計算させ、
 * 数式編集の結果欄(画面)に `= 9` が出ることを確かめる(mathIntegralsFlow.ts と同じ入口:
 * パラメータタブ→名前を付けた数値を足す→数式で入力)。
 */
export async function verifyOfflineExactMath(page: Page, server: OfflineCandidateServer): Promise<void> {
  await verifyOffline(server, '数学の厳密な計算(積分)', async () => {
    await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
    await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
    const row = page.locator('.pcad-parameter').last();
    const dialog = page.locator('.pcad-math-dialog');
    await row.locator('.pcad-field').first().locator('input').fill('厳密係数');
    await row.getByRole('button', { name: '数式で入力', exact: true }).click();
    await waitForMathEditorText(dialog);
    const input = dialog.locator('textarea');
    const result = dialog.locator('.pcad-math-editor__result[role="status"]');
    await input.fill('integrate(t^2,t,0,3)');
    await expect(result).toHaveText('= 9', { timeout: 225_000 });
    await dialog.getByRole('button', { name: 'この式を使う', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}

/**
 * (b) 自動作図。箱を1つ作るだけの最小の台本を1本実行し、木の「箱」の行が1件増える
 * (=形ができる)ことを確かめる。連番は文書の状態から決まる(createPartDocument.ts の
 * nextSerialName)ため、決め打ちの番号ではなく実行前後の件数の増分で見る。
 */
export async function verifyOfflineScript(page: Page, server: OfflineCandidateServer): Promise<void> {
  await verifyOffline(server, '自動作図(台本の実行)', async () => {
    const boxRows = page.locator('.pcad-panel--left').getByRole('button', { name: /^箱\d+$/u });
    const before = await boxRows.count();
    await chooseToolMenuItem(page, '自動作図', '自動作図');
    await expect(scriptPanel(page)).toBeVisible();
    await writeDraft(page, '通信なし確認用の箱', "cad.solid.box({x:'6',y:'5',z:'4'});");
    await successfulRun(page);
    await expect(boxRows).toHaveCount(before + 1);
  });
}

/**
 * (c) 組立。新しいアセンブリ文書を作り、この検査ですでに保存した実ファイル(部品)を
 * 実際のファイル選択(filechooser)で1つ置く。診断用のfileGatewayは使わない
 * (この配布候補には無い、spec冒頭で確認済み)。
 */
export async function verifyOfflineAssemblyPlacement(
  page: Page,
  server: OfflineCandidateServer,
  partFilePath: string,
): Promise<void> {
  await verifyOffline(server, '組立(部品を置く)', async () => {
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    const choosing = page.waitForEvent('filechooser');
    await chooseToolMenuItem(page, '組む', '部品を置く');
    await (await choosing).setFiles(partFilePath);
    const placing = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
    await expect(placing).toBeVisible();
    const token = await beginRecompute(page);
    await placing.locator('input.pcad-field__input').first().press('Enter');
    await waitForRecompute(page, token);
    await expect(placing).toHaveCount(0);
    const partRows = page.locator('.pcad-tree__sections > li')
      .filter({ has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: '部品' }) })
      .locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
    await expect(partRows).toHaveCount(1);
  });
}

/**
 * (d) 図面。直前に作った組立から図面を1枚作り、実際に投影線が描かれて表示される
 * ことを確かめる(p8-drawing.spec.ts の組図検査と同じ「この組立から図面を作成」)。
 * この項目は「ファイルのほかの操作」メニューの1項目なので、(c)と同じ入口で開く。
 */
export async function verifyOfflineDrawingSheet(page: Page, server: OfflineCandidateServer): Promise<void> {
  await verifyOffline(server, '図面(組立から1枚作成)', async () => {
    await chooseToolMenuItem(page, 'ファイルのほかの操作', 'この組立から図面を作成');
    await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    const paths = page.locator('.pcad-drawing-svg [data-owner-id^="projection:"] path');
    await expect.poll(() => paths.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  });
}

/**
 * (e) 板金。新規の部品文書で矩形の面を作り、板金基板(ベースフランジに当たる、この
 * 製品での唯一の起点フィーチャー)を1つ作成して、体積(50×30×2=3000mm³)が画面の
 * プロパティに出ることを確かめる(sheet-metal.spec.ts の基板作成と同じ入口)。
 */
export async function verifyOfflineSheetMetalBaseFlange(page: Page, server: OfflineCandidateServer): Promise<void> {
  await verifyOffline(server, '板金(ベースフランジ)', async () => {
    await page.getByRole('button', { name: '新規', exact: true }).click();
    await rectangleFace(page);
    await tree(page, '面1').click();
    await chooseSheet(page, '板金基板');
    const base = page.getByRole('form', { name: '板金基板', exact: true });
    await base.getByRole('textbox', { name: /^板厚/ }).fill('2');
    await base.getByRole('textbox', { name: /^内半径/ }).fill('3');
    await base.getByRole('button', { name: '作成', exact: true }).click();
    await expect(tree(page, '板金基板1')).toBeVisible();
    await tree(page, '板金基板1').click();
    await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
  });
}
