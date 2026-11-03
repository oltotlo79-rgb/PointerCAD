import { expect, type Locator, type Page } from '@playwright/test';

/*
 * ツールバーの畳んだ一覧(「作る」「合わせる」「加工」「見た目」など)を引く補助。
 * 13 の spec / flow に同じ本体で書き写していた物を 1 か所へ寄せた(P17)。本体は元の写しと同じ。
 * assemblyTestSupport.ts の物は待機条件が異なるため残す。sketchFinishCaptureSupport.ts は同じ処理を共有する。
 */

/**
 * ツールバーの畳んだ一覧(「作る」「合わせる」「加工」「見た目」)の引き金(P5 タスク51、§0.a-0.51)。
 *
 * ソリッドと加工の図柄ボタンは、この一覧の中へ移った(ツールバーを 1440 画素で 1 段に
 * 保つため)。**検査の中身は 1 つも変えていない**: 押せる/押せない、ツールチップの
 * 「名前: 理由」、押した結果はそのままで、道具に届くまでに一覧を開く手順が 1 つ増えただけ。
 *
 * 畳んだボタンの読み上げ名は、最後に使った道具があると「加工: 穴」のように後ろが付くので
 * 頭の一致で引く。開いた一覧そのものは、区画と同じ名前(「作る」など)の group になる。
 */
export function toolMenuTrigger(page: Page, menu: string): Locator {
  return page
    .locator('.pcad-toolbar')
    .getByRole('button', { name: new RegExp(`^${menu}`) })
    .first();
}

/** 開いた一覧の区画(引き金と同じ名前の group)。 */
export function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('group', { name: menu, exact: true });
}

/** 畳んだ一覧を開く(開いていれば押さない)。開いて見えるまで待つ。 */
export async function openToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) === 0) {
    await toolMenuTrigger(page, menu).click();
  }
  await expect(toolMenuPanel(page, menu)).toBeVisible();
}
