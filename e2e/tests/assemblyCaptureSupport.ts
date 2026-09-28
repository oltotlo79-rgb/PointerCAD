/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { boxPartFile, chooseToolMenuItem, installAssemblyFileGateway } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

/**
 * 説明書アセンブリ組(G4-a: assembly-place・standard-parts・mate・joint、G4-b:
 * interference・replace-subassembly・explode・bom)の撮影の流れで共通に使う補助。
 * `assembly.spec.ts`・`p7-standard-parts.spec.ts` の同名のローカル関数と同じ作り
 * (それらのファイル自身は変更しない。P12計画15:26追記の「撮影の流れどうしは複製せず共有」方針)。
 */

/** ツリーの節(「部品」「合致」「ジョイント」等)の行。`assembly.spec.ts`のtreeSectionRowsと同じ作り。 */
export function treeSectionRows(page: Page, sectionName: string): Locator {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: sectionName }),
  });
  return section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
}

/** 左のモデルブラウザ全体(組み立てのツリー・部品一覧)。撮影の切り取り範囲に使う。 */
export function assemblyTreePanel(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

export async function selectComponent(page: Page, index: number): Promise<void> {
  const row = treeSectionRows(page, '部品').nth(index).locator('.pcad-tree__select');
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

async function chooseFileMenu(page: Page, name: string): Promise<void> {
  await chooseToolMenuItem(page, 'ファイルのほかの操作', name);
}

/** 空のアセンブリを新規に始める(ページは既定の部品文書から遷移する)。 */
export async function startNewAssemblyCapture(page: Page): Promise<void> {
  const token = await beginRecompute(page);
  await chooseFileMenu(page, '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

/** 保存済みの組み立て(.pcada)をファイル口経由で開く。`assembly.spec.ts`のopenAssemblyFixtureと同じ作り。 */
export async function openAssemblyFixtureCapture(page: Page, bytes: Uint8Array, fileName = 'fixture.pcada'): Promise<void> {
  await installAssemblyFileGateway(page, { documents: [{ name: fileName, bytes }] });
  const token = await beginRecompute(page);
  await page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name: '開く', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

/** 「部品を置く」ダイアログを開く(撮影のため確定前で止める)。 */
export async function openPlacePartDialog(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, '組む', '部品を置く');
  const dialog = page.getByRole('dialog', { name: '部品を置く位置' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 開いた「部品を置く」ダイアログをEnterで確定する。 */
export async function commitPlacePartDialog(page: Page, dialog: Locator): Promise<void> {
  const token = await beginRecompute(page);
  await dialog.locator('input.pcad-field__input').first().press('Enter');
  await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, token);
}

/** X・Y・Zを入力して部品を1個置き切る(空欄は既定値のまま)。 */
export async function placeQueuedPartCapture(page: Page, sources: readonly string[]): Promise<void> {
  const dialog = await openPlacePartDialog(page);
  const fields = dialog.locator('input.pcad-field__input');
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index] !== '') await fields.nth(index).fill(sources[index]);
  }
  await commitPlacePartDialog(page, dialog);
}

/** 箱2個を(0,0,0)と(secondX,0,0)へ置く。「合わせる」「干渉」「分解」「部品表」章の下準備に使う。 */
export async function placeTwoBoxesCapture(page: Page, secondX = 40): Promise<void> {
  const box = boxPartFile();
  await installAssemblyFileGateway(page, { parts: [
    { fileName: '箱.pcad', bytes: box }, { fileName: '箱.pcad', bytes: box },
  ] });
  await placeQueuedPartCapture(page, ['', '', '']);
  await placeQueuedPartCapture(page, [String(secondX), '', '']);
}

/**
 * 2部品の原点どうしを「一致」で合わせる(assembly.spec.tsのcreateOriginMateと同じ手順)。
 * 干渉・分解・部品表の章で、2部品を重ねて/組ませて見せるために使う。
 */
export async function createOriginCoincidentMate(page: Page): Promise<void> {
  await chooseToolMenuItem(page, '合わせる', '一致');
  const dialog = page.getByRole('dialog', { name: '合致を作る' });
  await expect(dialog).toBeVisible();
  for (const index of [0, 1]) {
    await selectComponent(page, index);
    await dialog.getByRole('button', { name: '選択部品の原点', exact: true }).click();
  }
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '合致を作る', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, token);
}
