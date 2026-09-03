/// <reference lib="dom" />
import { readFileSync, statSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 要件§9 P2 の完了条件「簡単な部品を作って保存・再編集できる」を、実際のブラウザで
 * 通しで確かめる(計画書 docs/plans/P2-ソリッド基礎.md タスク27)。**ヘッドレスで実行する。**
 *
 * 待ちは Playwright の自動待機(toBeVisible / toHaveText / toHaveCount)だけで行い、
 * 固定の sleep は置かない。幾何カーネル(Worker + OCCT、約 50MB)の読み込みが挟まる
 * 最初の待ちにだけ長めの上限を渡す。
 *
 * 補助関数は `e2e/tests/sketch.spec.ts` と同じ作りで、共有ファイルを作らずここへ書き写す
 * (P1 の作りに合わせる)。選択子は `data-testid` を足さず role / aria / class で引き、
 * 名前がぶつかるものは区画(ツールバーの区画・ツリーの節)で絞る
 * (docs/報告記録.md 2026-09-02 23:50)。
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/** 立体を作れなかったときに帯の頭へ付く言葉(ja.json の statusBar.solidError)。 */
const SOLID_ERROR_PREFIX = '立体を作れませんでした:';
/** ja.json の solidError.noFace。 */
const NO_FACE_REASON = '面が選ばれていません。先に面を張ってください。';
/** ja.json の solidError.needTwoBodies。 */
const NEED_TWO_BODIES_REASON = '立体を 2 つ選んでください。';
/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';
/** ja.json の statusBar.ready。何も選んでいないときに帯へ出る案内。 */
const READY_GUIDE = '中ボタンのドラッグで向きを変え、ホイールで拡大・縮小できます。';

/** 自動保存の控えの置き場所。`packages/io/src/autoSave.ts` の既定値と同じ(DB・ストア・鍵)。 */
const AUTO_SAVE_DB_NAME = 'pointercad';
const AUTO_SAVE_STORE_NAME = 'autosave';
const AUTO_SAVE_RECORD_KEY = 'current';

/** 起動時の部品の名前(`createEmptyPartDocument` の `name`)。復元カードに出る。 */
const PART_NAME = '部品1';

/**
 * 控えを書いた時刻として差し込む値と、カードに出る読み(`formatSavedAt` と同じ組み立て)。
 * 期待値をここで組み立てるのは、実行する計算機の時計の地域(タイムゾーン)に依らせないため。
 */
const AUTO_SAVE_SAVED_AT = '2026-09-03T09:30:00.000Z';
const AUTO_SAVE_SAVED_AT_LABEL = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(AUTO_SAVE_SAVED_AT));

/**
 * 進み具合を確かめるときに積む押し出しの段数(NFR-PF-4)。
 *
 * 1 段消して(Ctrl+Z)全段を計算し直させるので、そのときの総数は 1 つ少ない。
 * 進み具合は届いてから 300ms 経つまで出さない決まりなので(`PROGRESS_DELAY_MS`)、
 * 計算がそれより十分長くかかる段数が要る。実測(2026-09-03、この環境)では
 * CPU を絞ったとき 1 段あたり 46ms(空いているとき)〜240ms(混んでいるとき)で、
 * 23 段なら少なくとも 1.1 秒。300ms の 3 倍以上あるので、速い計算機でも出る。
 */
const PROGRESS_STEP_COUNT = 24;

/**
 * 進み具合を出すために CPU を絞る倍率(遅い計算機の再現)。
 *
 * 絞らないと、変えていない段の計算し直しは 1 段 5ms ほどで終わり、
 * 26 段積んでも 300ms の待ちにやっと届く程度で、出たり出なかったりする
 * (2026-09-03 実測)。20 分の 1 に絞ると 1 段あたり 46ms 以上になり、
 * 数十段で確実に 300ms を超える。これは待ち時間の緩和ではなく、
 * 遅い計算機を再現して長い計算を作るためのもの。
 */
const CPU_THROTTLING_RATE = 20;

/** 進み具合の帯が出ていた瞬間の記録。「出た / 出ていない」を後からまとめて確かめる。 */
interface ProgressSighting {
  /** そのとき帯に出ていた 1 文。 */
  readonly text: string;
  /** 段の総数(`aria-valuemax`)。 */
  readonly valueMax: string | null;
  /** いま何段目か(`aria-valuenow`)。 */
  readonly valueNow: string | null;
}

declare global {
  interface Window {
    /**
     * 検査だけが使う見張りの記録(アプリは読み書きしない)。
     * `watchProgress` が仕込み、`takeProgressSightings` が取り出して空にする。
     */
    pcadProgressSightings?: ProgressSighting[];
  }
}

/** コンソールのエラーとページの例外を集める。最後に 0 件であることを確かめる。 */
function collectErrors(page: Page): readonly string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

/**
 * 確認の窓(`window.confirm`)に「はい」で答え、聞かれた文言を控える(NFR-UX-3)。
 *
 * 「新規」「開く」は押した瞬間に確認を出すので、**押す前に**答える用意をしておく。
 * 用意せずに押すと、頁が答えを待って止まったままになり、押す操作そのものが返ってこない。
 * 控えた文言は「いつ聞かれ、いつ聞かれなかったか」を確かめるのに使う。
 */
function acceptConfirms(page: Page): readonly string[] {
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  return messages;
}

/**
 * File System Access API を無いことにしてから頁を開く(§0.a-0.10)。
 *
 * Playwright の Chromium には `showSaveFilePicker` / `showOpenFilePicker` があるが、
 * ヘッドレスでは窓を出せないので保存も読込も進まない。これらを `undefined` で上書きすると
 * `hasFileSystemAccess()` が偽になり、アプリはダウンロード(`<a download>`)と
 * ファイル選択(`<input type="file">`)の代替経路へ落ちる。どちらも Playwright が拾える。
 * File System Access API そのものの経路は実機で統括が確かめる(計画書 §5)。
 *
 * `delete` では消えない。この 2 つは `Window.prototype` 側にあるので、頁自身の
 * 持ち物として `undefined` を被せて隠す。
 */
async function disableFilePickers(page: Page): Promise<void> {
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

/**
 * ツールバーの「スケッチ」区画の道具。
 * 表示スタイルにも「面」という名前のボタンがあるので、区画で絞ってから名前で引く。
 */
function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

/**
 * ツールバーの「ソリッド」区画の操作(押し出し・回転・縫合・和・差・積)。
 * 図柄だけのボタンなので、名前は読み上げ名(aria-label)が持つ。
 */
function solidTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ソリッド' })
    .getByRole('button', { name: label, exact: true });
}

/** ツールバーの「ファイル」区画のボタン(新規・開く・保存)。 */
function fileAction(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ファイル' })
    .getByRole('button', { name: label, exact: true });
}

/** その場数値入力のポップアップ。開いていないときは 0 件になる。 */
function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

/** ポップアップの表題。 */
function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

/** ポップアップの式の欄。並びは指定方法ごとに X/Y/Z、ΔX/ΔY/ΔZ、距離。 */
function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

/** 欄の下の 1 行。妥当なら評価値、間違いなら理由が出る(FR-202、FR-204)。 */
function popoverMessages(page: Page): Locator {
  return page.locator('.pcad-popover .pcad-field__message');
}

/** 左のモデルブラウザ。 */
function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

/** 右のプロパティ。 */
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

/** 下端のステータスバーの 1 文(FR-905)。 */
function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}

/** ステータスバー左端のファイル名。保存していない変更があると末尾に `*` が付く(FR-806)。 */
function statusFileName(page: Page): Locator {
  return page.locator('.pcad-statusbar__file');
}

/** 前回の作業の控えがあるときの案内(FR-805、§0.a-0.12)。無いときは 0 件。 */
function restoreCard(page: Page): Locator {
  return page.locator('.pcad-restore');
}

/** 復元カードの「鍵と値」の値の側(保存した時刻・部品の名前)。 */
function restoreValue(page: Page, key: string): Locator {
  return restoreCard(page)
    .locator('dt', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/**
 * 長い計算のあいだだけ出る細い進捗の帯(NFR-PF-4)。
 *
 * 役割(`role="progressbar"`)で引くが、`getByRole` ではなく属性で引く。`getByRole` は
 * 頁全体の読み上げ木を組み立て直すため、CPU を絞った場面(この検査の後半)では 1 回に
 * 1 秒近くかかり、帯が出ている間に「中止」へたどり着けなくなる(実測)。
 */
function progressBar(page: Page): Locator {
  return page.locator('[role="progressbar"]');
}

/**
 * 「押し出し7 を計算しています(7/23)」の形(ja.json の statusBar.progressDetail)。
 * 括弧は文言そのままの半角なので、正規表現では逃がす(逃がさないと取り出しの括弧になる)。
 */
function progressTextPattern(total: string): RegExp {
  return new RegExp(`^押し出し\\d+ を計算しています\\(\\d+/${total}\\)$`);
}

/**
 * 進捗の帯に「中止」が出た瞬間に押し、押したボタンの見出しを返す(NFR-PF-4)。
 *
 * 頁の外から押しに行くと間に合わない。実測(2026-09-03、この環境)では、帯が出ている
 * 時間は 23 段でおよそ 1 秒しかなく、Playwright の `click` は往復が何度もあって
 * 0.5〜1 秒かかる。空いている計算機ほど計算も速くなるため、待ちを短くしても
 * 追いつかない(最後の段まで押せず、打ち切りが起きなかった実測がある)。
 *
 * そこで「出るのを待つ」ところから「押す」までを**頁の中でひとつづき**に行う。
 * 押すのは実物の `click()` なので、React の `onClick` を通る経路は変わらない。
 * 見えていたこと・段の総数・帯の 1 文は、見張りが残す控えで別に確かめる。
 *
 * 出ないまま計算が終わったときは、30 秒で空文字を返して呼び出し側の照合を落とす
 * (呼び出し側を待たせ続けて何が起きたか分からなくしないための保険で、待ち時間ではない)。
 */
async function pressCancelWhenShown(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const find = (): HTMLElement | null => {
          const found = document.querySelector('.pcad-statusbar__cancel');
          return found instanceof HTMLElement ? found : null;
        };
        const press = (button: HTMLElement): void => {
          const label = button.textContent ?? '';
          button.click();
          resolve(label);
        };
        const ready = find();
        if (ready !== null) {
          press(ready);
          return;
        }
        const observer = new MutationObserver(() => {
          const button = find();
          if (button !== null) {
            observer.disconnect();
            press(button);
          }
        });
        observer.observe(document, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve('');
        }, 30_000);
      }),
  );
}

/**
 * モデルブラウザの節(「スケッチ」「ソリッド」)。
 * 立体と要素で名前がぶつかったときに絞れるよう、節の `li` を先に取る(FR-501)。
 */
function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

/** モデルブラウザの要素の行。名前のボタンを押すとその要素を選ぶ(FR-106、FR-501)。 */
function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

/** 「ソリッド」節の中の立体の行。スケッチの要素とは名前が別なので節で絞る。 */
function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
}

/** 「ソリッド」節に並んでいる立体の数。「増えていない」を数で確かめるのに使う。 */
function solidRows(page: Page): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__children > li');
}

/** 立体の行のまるごと(名前のボタン・印・「⋮」を含む枠)。札の有無を見るのに使う。 */
function solidRowBox(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__row--child').filter({ hasText: name });
}

/** プロパティの「鍵と値」の値の側。鍵の見出しの次に来る `dd` を引く。 */
function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/** プロパティの式の欄(距離・角度など)。立体を選んでいるときは 1 つだけ出る。 */
function propertyInputs(page: Page): Locator {
  return propertyPanel(page).locator('input.pcad-field__input');
}

/** ポップアップの欄を埋める。null を渡した欄は既定値のままにする(NFR-UX-4)。 */
async function fillFields(page: Page, sources: readonly (string | null)[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    if (source === null) {
      continue;
    }
    await inputs.nth(index).fill(source);
  }
}

/** Enter で決定する(§2.9)。焦点は必ずポップアップの欄に置いてから押す。 */
async function commitPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Enter');
}

/** Esc で取消して閉じる(§2.9、NFR-UX-3)。 */
async function cancelPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

/**
 * 閉じた長方形を線分 4 本でかく(FR-304、FR-307)。
 * 始点だけ絶対で入れ、終点は既定の相対のままずれで入れる(sketch.spec.ts と同じ手順)。
 */
async function drawRectangle(
  page: Page,
  origin: readonly [string, string],
  size: readonly [string, string],
): Promise<void> {
  await sketchTool(page, '線分').click();
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, [origin[0], origin[1], '0']);
  await commitPopover(page);

  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await fillFields(page, [size[0], null, null]);
  await commitPopover(page);
  await fillFields(page, [null, size[1], null]);
  await commitPopover(page);
  await fillFields(page, [`-${size[0]}`, null, null]);
  await commitPopover(page);
  await fillFields(page, [null, `-${size[1]}`, null]);
  await commitPopover(page);

  await cancelPopover(page);
}

/**
 * 線分を順に選んでから面の道具にして Enter で面を張る(FR-106、FR-309)。
 * 面の道具を選ぶとビューポートへ焦点が戻るので、選択はその前に済ませる。
 */
async function makeFace(page: Page, lineNames: readonly string[]): Promise<void> {
  await treeRow(page, lineNames[0]).click();
  for (const name of lineNames.slice(1)) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}

/** 面を 1 枚選んで押し出す(FR-401)。距離に null を渡すと既定の 10 のまま決める。 */
async function extrudeFace(page: Page, faceName: string, distance: string | null): Promise<void> {
  await treeRow(page, faceName).click();
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  if (distance !== null) {
    await fillFields(page, [distance]);
  }
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
}

/**
 * 自動保存の控えを 1 件、頁の IndexedDB へ直に書く(FR-805、NFR-RE-2)。
 *
 * 実物の自動保存は 5 分ごとにしか書かないので、E2E ではその 5 分を待たず、
 * `packages/io/src/autoSave.ts` が読む場所(データベース `pointercad`・
 * オブジェクトストア `autosave`・鍵 `current`)へ同じ形の 1 件を置く。
 * 中身の `bytes` は**アプリ自身が「保存」で書き出した `.pcad` そのもの**なので、
 * 控えの作り方までを検査が真似ることにはならない。
 *
 * バイト列は base64 の文字列で渡して頁の中で組み立て直す。数万個の数を並べた配列より
 * 受け渡しが軽く、`Uint8Array` がそのまま渡せるかどうかにも依らないため。
 */
async function writeAutoSaveRecord(page: Page, base64: string, savedAt: string): Promise<void> {
  await page.evaluate(
    async (record) => {
      const binary = atob(record.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(record.dbName, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(record.storeName)) {
            request.result.createObjectStore(record.storeName);
          }
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('自動保存のデータベースを開けませんでした'));
        };
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(record.storeName, 'readwrite');
        transaction
          .objectStore(record.storeName)
          .put(
            { savedAt: record.savedAt, bytes, documentName: record.documentName },
            record.key,
          );
        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          reject(new Error('自動保存の控えを書けませんでした'));
        };
      });
      database.close();
    },
    {
      base64,
      savedAt,
      documentName: PART_NAME,
      dbName: AUTO_SAVE_DB_NAME,
      storeName: AUTO_SAVE_STORE_NAME,
      key: AUTO_SAVE_RECORD_KEY,
    },
  );
}

/**
 * 進み具合の帯が出た瞬間を残らず控える見張りを仕込む(NFR-PF-4)。
 *
 * 「出ていないこと」は、その場で数えるだけでは**一瞬だけ出て消えた**場合を見逃す。
 * 短い計算で札が点滅した過去(docs/報告記録.md 2026-09-02 23:35 の②)を確かめ直すのが
 * この検査の目的なので、画面の書き換えを全部見張って、帯があった瞬間を記録しておく。
 */
async function watchProgress(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sightings: ProgressSighting[] = [];
    window.pcadProgressSightings = sightings;
    const record = (): void => {
      const bar = document.querySelector('[role="progressbar"]');
      if (bar === null) {
        return;
      }
      const line = document.querySelector('.pcad-statusbar__text');
      const sighting = {
        text: line === null ? '' : (line.textContent ?? ''),
        valueMax: bar.getAttribute('aria-valuemax'),
        valueNow: bar.getAttribute('aria-valuenow'),
      };
      const last = sightings[sightings.length - 1];
      if (last !== undefined && last.text === sighting.text && last.valueNow === sighting.valueNow) {
        return;
      }
      sightings.push(sighting);
    };
    new MutationObserver(record).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  });
}

/** 見張りが控えた記録を取り出して空にする(次の場面と混ざらないように)。 */
async function takeProgressSightings(page: Page): Promise<readonly ProgressSighting[]> {
  return page.evaluate(() => {
    const sightings = window.pcadProgressSightings;
    return sightings === undefined ? [] : sightings.splice(0, sightings.length);
  });
}

test('点→線→面→押し出し→保存→再読込→編集ができる(要件§9 P2 の完了条件)', async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  const confirms = acceptConfirms(page);
  await disableFilePickers(page);

  await page.goto('/');
  await expect(page).toHaveTitle('PointerCAD');

  // 1) 起動直後は空で、最初の一歩を案内している(NFR-UX-6)。
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(featureTree(page)).toContainText('まだ何もありません。');

  // 2) 40 × 30 の閉じた四角をかき、その 4 本で面を張る。
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await expect(treeRow(page, '面1')).toBeVisible();

  // 3) 面1 を選んで「押し出し」。表題と距離の既定値を確かめる(NFR-UX-4)。
  await treeRow(page, '面1').click();
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await expect(popoverInputs(page).first()).toHaveValue('10');

  // 4) 距離を式で入れる。打った瞬間に評価値が欄の下へ出る(FR-202)。
  await fillFields(page, ['5*2']);
  await expect(popoverInputs(page).first()).toHaveValue('5*2');
  await expect(popoverMessages(page).first()).toHaveText('= 10');
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);

  // 5) 「ソリッド」節に 押し出し1 ができ、体積と三角形の数が出る。
  //    ここで初めて幾何カーネル(Worker + OCCT)を通るので、この待ちだけ上限を延ばす。
  await expect(solidRow(page, '押し出し1')).toBeVisible();
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
  await expect(propertyValue(page, '三角形の数')).toHaveText('12');

  // 6) 元に戻す・やり直す(FR-505)。
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, '押し出し1')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(solidRow(page, '押し出し1')).toBeVisible();

  // 7) 保存する(FR-806)。File System Access API を消してあるのでダウンロードで落ちる。
  const downloadPromise = page.waitForEvent('download');
  await fileAction(page, '保存').click();
  const download = await downloadPromise;
  const savedPath = testInfo.outputPath('part.pcad');
  await download.saveAs(savedPath);
  expect(statSync(savedPath).size).toBeGreaterThan(0);
  await expect(statusText(page)).toHaveText('保存しました');

  // 8) 新規。保存した直後で失うものが無いので、確認は出ない(最後にまとめて確かめる)。
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(featureTree(page)).toContainText('まだ何もありません。');

  // 9) 保存したファイルを開き直す。面も立体も戻る(FR-801)。
  const chooserPromise = page.waitForEvent('filechooser');
  await fileAction(page, '開く').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(savedPath);

  await expect(treeRow(page, '面1')).toBeVisible();
  await expect(solidRow(page, '押し出し1')).toBeVisible();

  // 10) 距離の欄には**入れた式そのもの**が戻る(FR-202)。P2 の「再編集できる」の本体。
  await solidRow(page, '押し出し1').click();
  await expect(propertyInputs(page).first()).toHaveValue('5*2');
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  // 11) 距離を書き換えると下流が追従する(FR-311、FR-502)。
  await propertyInputs(page).first().fill('20');
  await expect(propertyValue(page, '体積')).toHaveText(`24000 ${VOLUME_UNIT}`);

  // 12) 保存していない変更があるまま「新規」を押すと、今度は確認が出る(NFR-UX-3)。
  //     「はい」は acceptConfirms が答える。
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(featureTree(page)).toContainText('まだ何もありません。');

  // 聞かれたのはこの 1 回だけ。8) の「新規」は保存した直後なので聞かれていない。
  expect(confirms).toEqual(['保存していない変更は失われます。続けますか。']);

  expect(errors).toEqual([]);
});

test('立体どうしを組み合わせられる(FR-404)', async ({ page }) => {
  const errors = collectErrors(page);
  await disableFilePickers(page);

  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  // 1) 20 × 20 の面を 20 押し出す(体積 8000)。
  await drawRectangle(page, ['0', '0'], ['20', '20']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '20');
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`8000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  // 2) 20 × 20 の中へすっぽり入る 10 × 10 の面を 10 押し出す(体積 1000)。
  await drawRectangle(page, ['5', '5'], ['10', '10']);
  await makeFace(page, ['線分5', '線分6', '線分7', '線分8']);
  await extrudeFace(page, '面2', null);
  await solidRow(page, '押し出し2').click();
  await expect(propertyValue(page, '体積')).toHaveText(`1000 ${VOLUME_UNIT}`);

  // 3) もとになる立体を選び、Shift で相手を足して「差」を押す(§0.a-0.6)。
  //    和・差・積は数値を聞かないので、押した瞬間に決まる。
  await solidRow(page, '押し出し1').click();
  await solidRow(page, '押し出し2').click({ modifiers: ['Shift'] });
  await expect(propertyPanel(page)).toContainText('選んだ数');
  await solidTool(page, '差').click();

  // 4) 差1 ができ、体積は 8000 − 1000 = 7000。
  await expect(solidRow(page, '差1')).toBeVisible();
  await solidRow(page, '差1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`7000 ${VOLUME_UNIT}`);

  // もとの 2 つは履歴なので行は消えない。ただし「統合済み」の札が付き、
  // 単独では表示されない=ビューポートに出る立体は 差1 の 1 つだけになる(§0.a-0.5)。
  await expect(solidRows(page)).toHaveCount(3);
  await expect(solidRowBox(page, '押し出し1')).toContainText('統合済み');
  await expect(solidRowBox(page, '押し出し2')).toContainText('統合済み');

  expect(errors).toEqual([]);
});

test('間違った操作は理由が出て、何も作られない(NFR-UX-5、FR-504)', async ({ page }) => {
  const errors = collectErrors(page);
  await disableFilePickers(page);

  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  /*
   * 1) 何も選ばずに「押し出し」。
   *
   * 計画書 §0.a-0.6 は「押した瞬間にステータスバーへ理由を出す」としている。
   * 見た目(aria-disabled の薄い表示)とツールチップは変えず、押した瞬間に
   * ステータスバーへも同じ理由を出す方式に統一した(統括の決定、
   * docs/報告記録.md 2026-09-03 19:35 の④)。ここでは押せない状態であること、
   * ツールチップとステータスバーの両方に理由が読めること、押しても何も
   * 作られないことを確かめる。
   */
  const extrudeButton = solidTool(page, '押し出し');
  await expect(extrudeButton).toBeDisabled();
  await expect(extrudeButton).toHaveAttribute('title', `押し出し: ${NO_FACE_REASON}`);
  // 押せない状態でも本当に何も起きないことを確かめるため、当たり判定の確認を飛ばして押す。
  await extrudeButton.click({ force: true });
  await expect(statusText(page)).toHaveText(`${SOLID_ERROR_PREFIX} ${NO_FACE_REASON}`);
  await expect(popover(page)).toHaveCount(0);
  await expect(solidRows(page)).toHaveCount(0);

  // 2) 面を張ってから、面ではないもの(線分)を選んだまま押し出しを決める。
  //    こちらは帯に理由が出る経路で、文言は ja.json の solidError.noFace そのもの。
  await drawRectangle(page, ['0', '0'], ['20', '20']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await treeRow(page, '面1').click();
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await treeRow(page, '線分1').click();
  await commitPopover(page);
  await expect(statusText(page)).toHaveText(`${SOLID_ERROR_PREFIX} ${NO_FACE_REASON}`);
  await expect(solidRows(page)).toHaveCount(0);

  // 3) 面を選び直せばそのまま作れる。ここまでの 2 回が何も作っていない証拠にもなる。
  await extrudeFace(page, '面1', null);
  await expect(solidRows(page)).toHaveCount(1);
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`4000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  // 4) 立体を 1 つだけ選んで「差」。理由が読めて、押しても立体は増えない(§0.a-0.6)。
  const subtractButton = solidTool(page, '差');
  await expect(subtractButton).toBeDisabled();
  await expect(subtractButton).toHaveAttribute('title', `差: ${NEED_TWO_BODIES_REASON}`);
  await subtractButton.click({ force: true });
  await expect(statusText(page)).toHaveText(`${SOLID_ERROR_PREFIX} ${NEED_TWO_BODIES_REASON}`);
  await expect(solidRows(page)).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('前回の作業の控えから復元でき、破棄と手動保存で控えが消える(FR-805、NFR-RE-2)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await disableFilePickers(page);

  await page.goto('/');

  // 1) 控えが無いので案内は出ない(§0.a-0.12)。空状態の案内が出ているのが、
  //    案内の置き場所(ビューポートの中央)が空いている証拠にもなる。
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(restoreCard(page)).toHaveCount(0);

  // 2) 部品を作って「保存」。落ちてきた `.pcad` を、このあと控えの中身に使う。
  //    控えの作り方まで検査が真似ることにならないよう、アプリ自身が書いたものを使う。
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', null);
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
  // ここまで控えを書く間隔(5 分)は来ていないので、まだ案内は出ない。
  await expect(restoreCard(page)).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await fileAction(page, '保存').click();
  const download = await downloadPromise;
  const savedBytes = readFileSync(await download.path());
  expect(savedBytes.byteLength).toBeGreaterThan(0);
  const savedBase64 = savedBytes.toString('base64');
  await expect(statusText(page)).toHaveText('保存しました');

  // 3) 控えを 1 件書いて開き直す。異常終了のあとの起動と同じ状態になる(NFR-RE-2)。
  await writeAutoSaveRecord(page, savedBase64, AUTO_SAVE_SAVED_AT);
  await page.reload();

  // 4) 案内が出て、いつの・どの部品かが読める(§0.a-0.12)。
  await expect(restoreCard(page)).toContainText('前回の作業が残っています');
  await expect(restoreValue(page, '保存した時刻')).toHaveText(AUTO_SAVE_SAVED_AT_LABEL);
  await expect(restoreValue(page, '部品の名前')).toHaveText(PART_NAME);

  // 5) 「復元する」で前回の部品が戻る。どのファイルにも保存していない扱いなので、
  //    ファイル名は「名称未設定」に戻り、保存していない印が付く。
  await restoreCard(page).getByRole('button', { name: '復元する', exact: true }).click();
  await expect(restoreCard(page)).toHaveCount(0);
  await expect(treeRow(page, '面1')).toBeVisible();
  await expect(solidRow(page, '押し出し1')).toBeVisible();
  await expect(statusFileName(page)).toHaveText('名称未設定*');

  // 6) もう一度控えを書いて開き直し、今度は「破棄する」。案内が消えて空のまま残り、
  //    次の起動でもう案内は出ない(控えそのものが消えている)。
  await writeAutoSaveRecord(page, savedBase64, AUTO_SAVE_SAVED_AT);
  await page.reload();
  await expect(restoreCard(page)).toBeVisible();
  await restoreCard(page).getByRole('button', { name: '破棄する', exact: true }).click();
  await expect(restoreCard(page)).toHaveCount(0);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(featureTree(page)).toContainText('まだ何もありません。');

  await page.reload();
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(restoreCard(page)).toHaveCount(0);

  // 7) 手で保存できたら控えは用済み(§0.a-0.12)。控えがある状態で「保存」を押し、
  //    開き直しても案内が出ないことで、保存が控えを消したことを確かめる。
  await writeAutoSaveRecord(page, savedBase64, AUTO_SAVE_SAVED_AT);
  const secondDownload = page.waitForEvent('download');
  await fileAction(page, '保存').click();
  await secondDownload;
  await expect(statusText(page)).toHaveText('保存しました');

  await page.reload();
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(restoreCard(page)).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('長い計算のあいだだけ進み具合と「中止」が出る(NFR-PF-4)', async ({ page }) => {
  const errors = collectErrors(page);
  await disableFilePickers(page);
  await watchProgress(page);

  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  // 1) 押し出し 1 段は一瞬で終わるので、進み具合は**一度も出ない**(PROGRESS_DELAY_MS)。
  //    短い計算のたびに札が点滅した過去(docs/報告記録.md 2026-09-02 23:35 の②)の確認。
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', null);
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
  await expect(progressBar(page)).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  expect(await takeProgressSightings(page)).toEqual([]);

  // 2) 段を積む。距離を段ごとに変えて、同じ形の使い回しが起きないようにする。
  //    1 段ごとの確認は置かない(段の数はこの下の `aria-valuemax` で確かめられる)。
  for (let index = 2; index <= PROGRESS_STEP_COUNT; index += 1) {
    await extrudeFace(page, '面1', String(10 + index));
  }
  const lastVolume = 40 * 30 * (10 + PROGRESS_STEP_COUNT);
  await solidRow(page, `押し出し${String(PROGRESS_STEP_COUNT)}`).click();
  await expect(propertyValue(page, '体積')).toHaveText(`${String(lastVolume)} ${VOLUME_UNIT}`);
  await takeProgressSightings(page);

  /*
   * 3) CPU を絞って(遅い計算機の再現)全段を計算し直させる。Ctrl+Z で最後の 1 段を
   *    消すと、残りの段が先頭から計算し直される。1 段あたりが 300ms の待ちより
   *    長くかかるようになるので、進み具合と「中止」が出る。
   */
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING_RATE });
  try {
    await page.keyboard.press('Control+z');
    // 計算が終わるまで待つ。終われば帯は道具の案内(ja.json の statusBar.ready)へ戻る。
    // 消した段を選んでいたので、選ばれている立体は 0 個になっている。
    await expect(statusText(page)).toHaveText(READY_GUIDE);
  } finally {
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }

  /*
   * 4) 見張りの控えで、計算のあいだ進み具合が届いていたことを確かめる(§1.2-5)。
   *    出ていた瞬間はすべて控えてあるので、その場で見に行くより取りこぼしがない。
   */
  const undoTotal = String(PROGRESS_STEP_COUNT - 1);
  const sightings = await takeProgressSightings(page);
  expect(sightings.length).toBeGreaterThan(0);
  expect([...new Set(sightings.map((sighting) => sighting.valueMax))]).toEqual([undoTotal]);
  for (const sighting of sightings) {
    expect(sighting.text).toMatch(progressTextPattern(undoTotal));
  }
  await expect(progressBar(page)).toHaveCount(0);

  /*
   * 5) もう一度計算し直させ、今度は出ている間に「中止」を押す。
   *    やり直す(Ctrl+Y)と消した段が戻るので、段の総数は 1 つ増える。
   */
  await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING_RATE });
  let pressedLabel: string;
  try {
    await page.keyboard.press('Control+y');
    pressedLabel = await pressCancelWhenShown(page);
  } finally {
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  expect(pressedLabel).toBe('中止');

  // 段と段の間で打ち切られ、失敗ではない知らせとして帯に出る。
  await expect(statusText(page)).toHaveText('計算を中止しました。');
  await expect(progressBar(page)).toHaveCount(0);

  const cancelled = await takeProgressSightings(page);
  expect(cancelled.length).toBeGreaterThan(0);
  expect([...new Set(cancelled.map((sighting) => sighting.valueMax))]).toEqual([
    String(PROGRESS_STEP_COUNT),
  ]);

  // 6) 中止の知らせは時間では消えない。選び直しても(文書を変えない操作では)残る。
  //    途中で打ち切った形には差し替えないので、前の計算で作れていた立体はそのまま見える。
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`);
  await expect(statusText(page)).toHaveText('計算を中止しました。');

  // 7) 文書が変わる操作(元に戻す)で計算し直され、知らせは消える。
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, `押し出し${String(PROGRESS_STEP_COUNT)}`)).toHaveCount(0);
  await expect(statusText(page)).not.toHaveText('計算を中止しました。');

  expect(errors).toEqual([]);
});

test('式の欄に焦点があっても Ctrl+S で保存される(§0.a-0.23 ⑪)', async ({ page }) => {
  const errors = collectErrors(page);
  await disableFilePickers(page);

  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  // 1) 立体を 1 つ作り、プロパティの距離の欄(式の欄)へ焦点を当てる。
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', null);
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  const distanceInput = propertyInputs(page).first();
  await distanceInput.click();
  await expect(distanceInput).toBeFocused();

  /*
   * 2) 焦点が式の欄にあるまま Ctrl+S を押す。`AppShell.tsx` の `isTextEntry` の除外は
   *    元に戻す・やり直すだけに限り、ファイル系(保存・名前を付けて保存・開く・新規)は
   *    入力欄に焦点があっても効く(§0.a-0.23 ⑪、Electron 実機検査で見つかった不具合の
   *    修正。docs/報告記録.md 2026-09-03 20:40 の②)。File System Access API を
   *    消してあるので、保存はダウンロードで落ちる。
   */
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await downloadPromise;
  const savedBytes = readFileSync(await download.path());
  expect(savedBytes.byteLength).toBeGreaterThan(0);
  await expect(statusText(page)).toHaveText('保存しました');

  // 3) 打っている途中の文字を邪魔しない証拠として、欄の焦点はそのまま残る。
  await expect(distanceInput).toBeFocused();

  expect(errors).toEqual([]);
});
