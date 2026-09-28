/// <reference lib="dom" />
import type { Page } from '@playwright/test';

/**
 * 保存していない変更の確認(画面の中の日本語の3択。w91a でブラウザー標準の `window.confirm` から
 * 置き換えた `role="alertdialog"`、名前「保存していない変更があります」、ボタン
 * 「保存して続ける」「保存せずに続ける」「戻る」)に明示的に答える。
 *
 * `page.addLocatorHandler` は、次に行う Playwright の操作(click など)や
 * 自動再試行の assertion(`expect(...).toBeVisible()` など)の**actionability チェックの中でだけ**
 * 起動する。`page.waitForEvent('filechooser')` / `page.waitForEvent('download')` のような
 * 生の Promise の待ちはそのチェックを一切経由しないため、確認が開いたまま「保存せずに続ける」が
 * 押されず、filechooser/download の event がいつまでも来ない(w105a、全体検査 20260928-133915、
 * `e2e/tests/sketch-extended.spec.ts` の「P4 の図形を含む部品を保存して開き直すと式のまま直せ」)。
 *
 * 「保存していない変更がある状態」で「開く」「新規」「ひな形から新規」などを押した**直後に**
 * filechooser/download を待つ箇所は、待ちを仕掛けたあとこの関数で明示的に閉じてから
 * event を受け取る(`Promise` を先に作り、ボタンを押し、この関数を待ち、それから event を待つ順)。
 *
 * **同じ確認へ `page.addLocatorHandler` を登録した状態でこの関数を呼ばない。**
 * 登録済みの handler は、この関数の `.click()` 自身の actionability チェックにも割り込んで
 * 先にボタンを押して確認を閉じてしまい、この関数は消えた後のボタンを待ち続けて 15 秒で
 * タイムアウトする(w105a、`answerDiscardConfirm` を最初に足したときの実測:
 * `found ... alertdialog, intercepting action to run the handler` の後
 * `locator handler has finished, waiting for ... to be hidden` → 対象が無くなり `locator.click` が
 * 15000ms で失敗)。この確認をこの関数で明示的に扱う spec では `addLocatorHandler` 版の
 * `acceptConfirms` を使わない(呼ばない・登録しない)。
 */
export async function answerDiscardConfirm(
  page: Page,
  choice: '保存して続ける' | '保存せずに続ける' | '戻る' = '保存せずに続ける',
): Promise<void> {
  await page
    .getByRole('alertdialog', { name: '保存していない変更があります' })
    .getByRole('button', { name: choice, exact: true })
    .click();
}
