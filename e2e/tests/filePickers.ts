import type { Page } from '@playwright/test';

/**
 * File System Access API を無いことにしてから頁を開く(§0.a-0.10)。
 *
 * Playwright の Chromium には `showSaveFilePicker` / `showOpenFilePicker` があるが、
 * ヘッドレスでは窓を出せないので保存も読込も進まない。これらを `undefined` で上書きすると
 * `hasFileSystemAccess()` が偽になり、アプリはダウンロード(`<a download>`)と
 * ファイル選択(`<input type="file">`)の代替経路へ落ちる。どちらも Playwright が拾える。
 * こうすると書き出しは `download` の知らせ、読み込みは `filechooser` の知らせで捕まえられる。
 * File System Access API そのものの経路は実機で統括が確かめる(計画書 §5)。
 *
 * `delete` では消えない。この 2 つは `Window.prototype` 側にあるので、頁自身の
 * 持ち物として `undefined` を被せて隠す。
 */
export async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });
}
