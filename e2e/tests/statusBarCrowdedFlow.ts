import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { diskFile, saveTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';

/** 帯が込み合う窓の幅。右の札(約 520px)とコマンドの欄で、帯の欄の自然な幅の合計が窓を超える。 */
const CROWDED_VIEWPORT = { width: 900, height: 700 } as const;

/** 保存の完了の印の図柄の大きさ(SaveIcon の size)。これより小さく潰れたら、利用者には見えない。 */
const MARK_ICON_PX = 12;

/**
 * 帯が込み合う幅で名前を付けて保存し、保存の完了の印が図柄の大きさを保って見える事を確かめる
 * (外部検査の Linux で、縮む順の先頭の印が幅 0 に潰れて `[data-save-stage="complete"]` が見えなく
 * なった失敗の再現。C-02a の直し)。帯が本当に込んでいる事は、縮む順で印の次のファイル名が省略されている事で
 * 確かめる(条件が崩れたら、この検査が先に気づく)。保存の口は saveFlowFile と同じ(Electron は保存の窓の置換え、
 * ブラウザーはダウンロード)。
 */
export async function crowdedSaveMarkFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize(CROWDED_VIEWPORT);
  await waitForStartupHealth(page, info);
  const path = info.outputPath('crowded-save.pcad');
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download') : null;
  await fileAction(page, '保存').click({ modifiers: ['Shift'] });
  if (download !== null) await (await download).saveAs(path); else await diskFile(path);
  const mark = page.locator('[data-save-stage="complete"]');
  await expect(mark).toBeVisible();
  const box = await mark.boundingBox();
  expect(box?.width ?? 0, '保存の完了の印の幅').toBeGreaterThanOrEqual(MARK_ICON_PX);
  expect(box?.height ?? 0, '保存の完了の印の高さ').toBeGreaterThanOrEqual(MARK_ICON_PX);
  // 帯が本当に込んでいる事: 縮む順で印の次のファイル名が縮められ、省略されている(印は図柄の幅を保ったまま)。
  const file = page.locator('.pcad-statusbar__file');
  expect(await file.evaluate(element => element.scrollWidth > element.clientWidth), '帯が込み合ってファイル名が省略されている').toBe(true);
  await expect(page.locator('.pcad-statusbar__text')).toHaveAttribute('title', /\S/u);
}
