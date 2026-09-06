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
 * 計算がそれより十分長くかかる段数が要る。
 *
 * **固定の待ち(`STEP_DELAY_MS`)で長い計算を作るので、段数は帯が出る最小で足りる**
 * (2026-09-06、CI windows の余裕のため 24 段から 8 段へ)。8 段のうち 1 段を消すと
 * 総数は 7 段、段と段の間の待ちは 6 回で 1.2 秒。300ms の 4 倍あり、しかも段数を
 * 増やしても減らしても**待ちの長さは機械の速さに依らない**。段数を減らしたぶん
 * 押し出しを積む操作が短くなり、共有の遅いランナーでも 3 分の上限に余裕ができる。
 * この定数はこの検査だけのもので、他の検査(P3 の加工など)の段数には関わらない。
 * 期待値(`aria-valuemax` の 7 / 8、文言の n/総数、体積)はすべてここから計算する。
 */
const PROGRESS_STEP_COUNT = 8;

/**
 * 進み具合を出すまでの待ち(`packages/ui/src/shell/statusText.ts` の `PROGRESS_DELAY_MS`)。
 * これより短く終わった計算では帯を出さない、というのが「短い計算では点滅しない」の中身。
 */
const PROGRESS_DELAY_MS = 300;

/**
 * 長い計算を作るために、段と段の間へ挟む待ち(ms)。検査専用の口
 * `window.pcadDebugStepDelayMs`(`packages/model/src/kernelBridge.ts` の `toCancelProxy`)へ入れる。
 *
 * 挟まないと、変えていない段の計算し直しは 1 段 5ms ほどで終わり、26 段積んでも
 * 300ms の待ちにやっと届く程度で、出たり出なかったりする(2026-09-03 実測)。
 * 以前は CDP の `Emulation.setCPUThrottlingRate` で計算機ごと遅くしていたが、
 * 共有の 2 コアの CI ランナー(GitHub Actions の windows-latest)では 20 分の 1 に
 * 絞った計算が 3 分の上限に収まらず、この検査だけが時間切れで落ちた
 * (2026-09-06 の run 33998506476。rules/06 10.14)。**待ちの長さを機械の速さから
 * 切り離す**ため、絞るのをやめて段の間の待ちを固定した。1 段 200ms なら 6 回で 1.2 秒、
 * どんな機械でも 300ms の待ちを超え、3 分の上限には遠く届かない。
 * これは待ち時間の緩和ではなく、長い計算を作るためのもの。
 */
const STEP_DELAY_MS = 200;

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
    /**
     * 検査だけが使う描画間隔の記録(アプリは読み書きしない)。P3 タスク30 手順4 の
     * 「マウスを動かしたときの費用」の実測に使う。`undefined` に戻すと採り終わりの合図。
     */
    pcadFrameSamples?: number[];
    /**
     * 検査だけが使う、頁が作った Worker の控え(アプリは読み書きしない)。
     * 幾何カーネルの Worker をわざと止めて、作り直しが効くかを確かめるのに使う(§0.a-0.19)。
     */
    pcadWorkers?: Worker[];
    /**
     * 検査だけが使う遅延の口(アプリは読み書きしない)。`packages/model/src/kernelBridge.ts` の
     * `toCancelProxy` が段と段の間で読み、正の数ならその ms だけ待ってから中止を答える。
     * 入れっぱなしにすると以後の計算が全部遅くなるので、使い終わったら必ず消す。
     */
    pcadDebugStepDelayMs?: number;
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
 * ツールバーの「ソリッド」区画の操作(押し出し・回転・縫合・和・差・積・ばね)。
 * 図柄だけのボタンなので、名前は読み上げ名(aria-label)が持つ。
 * P5 タスク51 以降は「作る」「合わせる」の畳んだ一覧の中にあるので、
 * `openToolMenu` で一覧を開いてから引く(一覧は「ソリッド」区画の中に開く)。
 */
function solidTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ソリッド' })
    .getByRole('button', { name: label, exact: true });
}

/**
 * ツールバーの畳んだ一覧(「作る」「合わせる」「加工」)を開く(P5 タスク51、§0.a-0.51)。
 *
 * ソリッドと加工の図柄ボタンは、この一覧の中へ移った(ツールバーを 1440 画素で 1 段に
 * 保つため)。**検査の中身は 1 つも変えていない**: 押せる/押せない、ツールチップの
 * 「名前: 理由」、押した結果はそのままで、道具に届くまでに一覧を開く手順が 1 つ増えただけ。
 *
 * 畳んだボタンの読み上げ名は、最後に使った道具があると「加工: 穴」のように後ろが付くので
 * 頭の一致で引く。開いた一覧そのものは、区画と同じ名前(「作る」など)の group になる。
 */
function toolMenuTrigger(page: Page, menu: string): Locator {
  return page
    .locator('.pcad-toolbar')
    .getByRole('button', { name: new RegExp(`^${menu}`) })
    .first();
}

function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('group', { name: menu, exact: true });
}

async function openToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) === 0) {
    await toolMenuTrigger(page, menu).click();
  }
  await expect(toolMenuPanel(page, menu)).toBeVisible();
}

/**
 * 開いた一覧を閉じる。開いた一覧はビューポートに重なるので、**道具を押さずに
 * 押せる/押せないを確かめただけのとき**は、次のクリックを奪われないよう閉じてから進む
 * (道具を押した場合は一覧が自分で閉じるので、これを呼ぶ必要はない)。
 */
async function closeToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) > 0) {
    await toolMenuTrigger(page, menu).click();
  }
  await expect(toolMenuPanel(page, menu)).toHaveCount(0);
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
 * 頁全体の読み上げ木を組み立て直すため、遅い計算機では 1 回に 1 秒近くかかり、帯が
 * 出ている間に「中止」へたどり着けなくなる(CPU を 20 分の 1 に絞って実測、2026-09-03)。
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
 * 頁の外から押しに行くと間に合わないことがある。実測(2026-09-03、この環境)では、
 * 帯が出ている時間は 23 段でおよそ 1 秒しかなく、Playwright の `click` は往復が何度も
 * あって 0.5〜1 秒かかった。段の間の待ち(`STEP_DELAY_MS`)を固定した今は帯の出ている
 * 時間も決まるが、**押した瞬間から止まるまでを測る**この作りのほうが、計算の速い機械でも
 * 遅い機械でも同じように「出た瞬間に押す」ことになるので、そのまま使う。
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
  await openToolMenu(page, '作る');
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

/**
 * 段と段の間の待ちを入れる/外す(NFR-PF-4 の長い計算を作るための検査専用の口)。
 *
 * `null` を渡すと外す。外し忘れると以後の計算が全部遅くなるので、入れた側は必ず
 * `finally` で外す。頁を開き直すと消えるが、この検査は開き直さない。
 */
async function setStepDelay(page: Page, delayMs: number | null): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) {
      delete window.pcadDebugStepDelayMs;
      return;
    }
    window.pcadDebugStepDelayMs = value;
  }, delayMs);
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
  await openToolMenu(page, '作る');
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
  await openToolMenu(page, '合わせる');
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
  await openToolMenu(page, '作る');
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
  await openToolMenu(page, '作る');
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
  await openToolMenu(page, '合わせる');
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

  /*
   * 1) 短い計算では進み具合の帯を出さない(PROGRESS_DELAY_MS)。短い計算のたびに札が
   *    点滅した過去(docs/報告記録.md 2026-09-02 23:35 の②)の確認。
   *
   *    **最初の押し出しでは測らない**(P5 タスク56 で前提を直した)。1 回目の計算には
   *    幾何カーネル(Worker + OCCT、約 50MB)の読み込みが入るので、**短い計算ではない**。
   *    ここで「一度も出ない」を課すと、混んでいる計算機で読み込みが延びたときに落ちる
   *    (docs/報告記録.md 2026-09-06 04:30 の申し送り)。読み込みの済んだ 2 回目以降で
   *    測る、というのが「短い計算では出ない」の本来の前提。
   */
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', null);
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
  // 読み込みを含む 1 回目の控えは捨てる。終わった時点で帯が残っていないことだけを見る。
  await takeProgressSightings(page);
  await expect(progressBar(page)).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);

  /*
   *    カーネルが暖まった状態で、距離を書き換えて 1 段だけ計算し直させる。
   *    かかった時間を測り、**300ms(PROGRESS_DELAY_MS)未満で終わったのに帯が出ていたら
   *    落とす**。300ms を超えたとき(混んでいる計算機)は、出ていた帯が
   *    「この計算のもの」(段の総数が 1)で、終わった時点で消えていることを確かめる。
   *    ゆるめたのではなく、「短い計算」の判定を実測に置き換えた。
   *
   *    測った時間には Playwright が結果を見に行く間隔(最短 100ms 前後)も入るので、
   *    **300ms 未満で終わったなら計算そのものは確実に 300ms より短い**(厳しい側に倒れる)。
   */
  const shortStart = Date.now();
  await propertyInputs(page).first().fill('12');
  await expect(propertyValue(page, '体積')).toHaveText(`14400 ${VOLUME_UNIT}`);
  const shortElapsed = Date.now() - shortStart;
  const shortSightings = await takeProgressSightings(page);
  if (shortElapsed < PROGRESS_DELAY_MS) {
    expect(shortSightings, `${String(shortElapsed)}ms で終わった計算`).toEqual([]);
  } else {
    for (const sighting of shortSightings) {
      expect(sighting.text).toMatch(progressTextPattern('1'));
    }
  }
  await expect(progressBar(page)).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);

  // 距離を既定へ戻し、この後の段数と体積の期待値を元のままにする。
  await propertyInputs(page).first().fill('10');
  await expect(propertyValue(page, '体積')).toHaveText(`12000 ${VOLUME_UNIT}`);
  await takeProgressSightings(page);

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
   * 3) 段と段の間へ待ちを挟んで(検査専用の口)全段を計算し直させる。Ctrl+Z で最後の
   *    1 段を消すと、残りの段が先頭から計算し直される。1 段あたりが 300ms の待ちより
   *    長くかかるようになるので、進み具合と「中止」が出る。**計算の中身は変えない**。
   */
  await setStepDelay(page, STEP_DELAY_MS);
  try {
    await page.keyboard.press('Control+z');
    // 計算が終わるまで待つ。終われば帯は道具の案内(ja.json の statusBar.ready)へ戻る。
    // 消した段を選んでいたので、選ばれている立体は 0 個になっている。
    await expect(statusText(page)).toHaveText(READY_GUIDE);
  } finally {
    await setStepDelay(page, null);
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
  await setStepDelay(page, STEP_DELAY_MS);
  let pressedLabel: string;
  try {
    await page.keyboard.press('Control+y');
    pressedLabel = await pressCancelWhenShown(page);
  } finally {
    await setStepDelay(page, null);
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

  /*
   *    「中止」が本当に計算を止めたことを、進んだ段の数で確かめる(押しただけで
   *    知らせが出るのではなく、残りの段が計算されていないこと)。段と段の間に
   *    200ms の待ちが入るので、最後まで走れば 7 回ぶんの待ちが要る。押したのは帯が
   *    出た直後(300ms 過ぎ)なので、そこで止まっていれば進んだ段は総数に遠く届かない。
   */
  const reachedStep = Math.max(...cancelled.map((sight) => Number(sight.valueNow ?? '0')));
  expect(reachedStep).toBeLessThan(PROGRESS_STEP_COUNT);

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

/* ========================================================================== *
 * ここから P3「加工フィーチャー」の検査(計画書 docs/plans/P3-加工フィーチャー.md
 * タスク30)。要件§9 P3 の完了条件「実用部品(穴・ねじ・面取り付き)とコイルばねが
 * 作れる」を、実際のブラウザで通しで確かめる。**ヘッドレスで実行する。**
 *
 * 上の 6 件と同じ補助関数をそのまま使い、足りないものだけをここへ足す
 * (共有ファイルを作らない。P1・P2 の作りに合わせる)。`data-testid` は足さず、
 * role / aria / class で引く(docs/報告記録.md 2026-09-02 23:50)。
 * ========================================================================== */

/** ワールド座標(mm)。 */
type WorldPoint = readonly [number, number, number];

/**
 * ホーム視点の見え方。数値は `packages/ui/src/viewport/cameraMath.ts` の `HOME_ORBIT` と
 * `VERTICAL_FIELD_OF_VIEW` そのままで、写し方は `createViewportScene.ts` の
 * `worldToScreen`(three.js の PerspectiveCamera + lookAt)と同じ。
 *
 * **この検査では視点を一度も動かさない**ので、ワールド座標から画面座標への写しをここで
 * 組み立て直せる。面は光線(`pickFaceAt`)、辺・頂点は画面上 6px(`pickSolidSubShape`)で
 * 拾われるため、押す場所をワールド座標で決められると、立体のどこを選んだのかが
 * 検査の側でも確かめられる。
 */
// 既定(ホーム)の視点の方位角は −45°(利用者の指示 2026-09-06)。カメラは (+X, −Y, +Z) にあり、前・上・右の 3 面が見える。
const HOME_AZIMUTH = -Math.PI / 4;
const HOME_ELEVATION = Math.atan(Math.SQRT1_2);
const HOME_DISTANCE = 200;
const VERTICAL_FIELD_OF_VIEW = (50 * Math.PI) / 180;

function subtractPoints(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dotPoints(a: WorldPoint, b: WorldPoint): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossPoints(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalizePoint(a: WorldPoint): WorldPoint {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** カメラの位置(`cameraPosition(HOME_ORBIT)`)。注視点は原点。 */
const CAMERA_EYE: WorldPoint = [
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH),
  HOME_DISTANCE * Math.sin(HOME_ELEVATION),
];
/** カメラの向き。three.js の `Matrix4.lookAt` と同じ組み立て(上方向は +Z)。 */
const CAMERA_Z = normalizePoint(CAMERA_EYE);
const CAMERA_X = normalizePoint(crossPoints([0, 0, 1], CAMERA_Z));
const CAMERA_Y = crossPoints(CAMERA_Z, CAMERA_X);

/** ワールド座標を canvas の左上を原点とした画素へ写す。 */
function worldToCanvas(
  world: WorldPoint,
  widthPixels: number,
  heightPixels: number,
): readonly [number, number] {
  const view = subtractPoints(world, CAMERA_EYE);
  // カメラは自分の -Z を見るので、前にあるものの深さは正になる。
  const depth = -dotPoints(view, CAMERA_Z);
  const scale = 1 / Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
  const ndcX = (scale * dotPoints(view, CAMERA_X)) / (depth * (widthPixels / heightPixels));
  const ndcY = (scale * dotPoints(view, CAMERA_Y)) / depth;
  return [((ndcX + 1) / 2) * widthPixels, ((1 - ndcY) / 2) * heightPixels];
}

/** ビューポートの上で、ワールド座標の点が見えている場所を押す(FR-106)。 */
async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}

/**
 * 40 × 30 の板の上面の中央を押す位置(§2.3.2 の順序表、タスク30 不具合(c) の修正)。
 *
 * 選ぶものの種類が `face` のときは、スケッチ要素の当たり判定そのものを飛ばして立体の面だけを
 * 拾う(`attachSketchInteraction.skipsSketchElements`)ので、押し出したもとの面(z=0 の四角)の
 * 投影の内側であっても、立体の上面が選ばれる。以前は当たり判定の順序の不具合を避けるため
 * 輪郭の外の角の近くを押していたが、修正後は板の中央(20, 15)を押せる。
 */
function topFaceCenter(thicknessMm: number): WorldPoint {
  return [20, 15, thicknessMm];
}

/**
 * ツールバーの「加工」の道具(穴・ねじ穴・R面取り・C面取り・直線/円形パターン)。
 * P5 タスク51 以降は「加工」の畳んだ一覧の中にあり、開いた一覧が「加工」という名前の
 * group になるので、引き方は変わらない(`openToolMenu` で開いてから使う)。
 */
function machiningTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: '加工' })
    .getByRole('button', { name: label, exact: true });
}

/** ステータスバーの「選ぶもの」の札(§0.a-0.6)。右端の札のうち先頭。 */
function selectionKindLabel(page: Page): Locator {
  return page.locator('.pcad-statusbar__state').first();
}

/**
 * プロパティの式の欄を見出しで引く(読み取り専用の欄も同じ形で拾える)。
 * 見出しは完全一致で照合する(「距離」と「距離2」を取り違えないため)。
 */
function propertyFieldBox(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) });
}

function propertyField(page: Page, label: string): Locator {
  return propertyFieldBox(page, label).locator('input.pcad-field__input');
}

/** 欄の下の 1 行(評価値または理由)。式のまま持つ欄の「計算した値」を読むのに使う。 */
function propertyFieldMessage(page: Page, label: string): Locator {
  return propertyFieldBox(page, label).locator('.pcad-field__message');
}

/** プロパティの横並びの選択肢(深さ・ねじの種類・見せ方・巻き方向・求める値など)。 */
function propertyChoice(page: Page, label: string): Locator {
  return propertyPanel(page).getByRole('group', { name: label, exact: true });
}

/** プロパティの畳んだ一覧(ねじの呼び 28 個。タスク28)。 */
function propertyMenu(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-choice')
    .filter({ has: page.locator('.pcad-choice__label', { hasText: new RegExp(`^${label}$`) }) });
}

/** プロパティに出ている体積を数で読む。まだ出ていなければ NaN。 */
async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) {
    return Number.NaN;
  }
  // 「11717.2566612 mm³」の形。単位の前で切れるので parseFloat でそのまま読める。
  return Number.parseFloat(await cell.innerText());
}

/**
 * 体積が期待値どおりであることを、許容差(mm³)つきで確かめる。
 *
 * 表示は有効数字 12 桁なので、π を含む期待値は文字列では比べられない。期待値は
 * それぞれの検査で式のまま組み立て(担当が独立に計算した値)、許容差は既定 0.01mm³ =
 * 体積 12000mm³ に対して 10⁻⁶ 未満とする(表示の丸めより十分大きく、形の違いより十分小さい)。
 */
async function expectVolume(page: Page, expected: number, toleranceMm3 = 0.01): Promise<void> {
  await expect
    .poll(async () => Math.abs((await volumeNumber(page)) - expected), {
      timeout: KERNEL_TIMEOUT_MS,
      message: `体積が ${String(expected)} mm³ ± ${String(toleranceMm3)} になること`,
    })
    .toBeLessThanOrEqual(toleranceMm3);
}

/** 板 40×30×10(mm³)。P3 の検査はすべてこの板から始める。 */
const BOARD_VOLUME = 40 * 30 * 10;
/** φ6 の貫通穴 1 つが板から取り除く量(π·3²·10)。 */
const HOLE_6_THROUGH = Math.PI * 3 * 3 * 10;
/** φ8 の貫通穴 1 つが板から取り除く量(π·4²·10)。 */
const HOLE_8_THROUGH = Math.PI * 4 * 4 * 10;

test.describe('P3 加工フィーチャー', () => {
  /*
   * 窓の大きさを固定する。ビューポートの当たり判定は画面の画素で決まる(面は光線、
   * 辺・頂点は 6px)ので、押す場所を計算するこの検査では窓の大きさが結果を左右する。
   * 1440×900 は §0.a-0.25 が「1 段に収まること」の条件にしている幅で、このとき canvas は
   * 横 918px(窓の幅 − 左 240 − 右 280 − 枠 2)になり、押す場所は最も近いスケッチ要素から
   * 20px 以上離れる(当たり判定の 6px の 3 倍以上)。
   * 既存の 6 件は Playwright の既定(1280×720)のまま変えない。
   */
  test.use({ viewport: { width: 1440, height: 900 } });

  test('板に穴をあけて並べ、保存・開き直して式のまま直せる(要件§9 P3 の完了条件)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    const confirms = acceptConfirms(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 40 × 30 の板を 10 押し出す。
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
    await extrudeFace(page, '面1', null);
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 2) 穴の中心にする点を 1 つ打つ(§0.a-0.9。穴の位置は式で持てる点で決める)。
    await sketchTool(page, '点').click();
    await expect(popoverTitle(page)).toHaveText('点を作る');
    await fillFields(page, ['5', '15', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '点1')).toBeVisible();

    // 3) 「穴」を押す。条件が揃っていなくても選ぶものが「面」へ切り替わる(§0.a-0.6)。
    await openToolMenu(page, '加工');
    const holeButton = machiningTool(page, '穴');
    await expect(holeButton).toBeDisabled();
    await holeButton.click({ force: true });
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');

    // 4) 立体の上面の中央を押し(押し出したもとのスケッチ面より立体の面が優先して当たる)、
    //    Shift でツリーの 点1 を足す。両方そろって初めて「穴」が押せる。
    await clickWorldPoint(page, topFaceCenter(10));
    await treeRow(page, '点1').click({ modifiers: ['Shift'] });
    await openToolMenu(page, '加工');
    await expect(holeButton).toBeEnabled();

    // 5) もう一度「穴」を押す。直径の既定は 6(NFR-UX-4)。貫通にして決める。
    await holeButton.click();
    await expect(popoverTitle(page)).toHaveText('穴をあける');
    await expect(popoverInputs(page).first()).toHaveValue('6');
    await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
    await commitPopover(page);
    await expect(popover(page)).toHaveCount(0);

    /*
     * 6) 穴1 ができ、体積が π·3²·10 だけ減る。ツリーともとの立体の扱いも確かめる。
     *
     * 作った直後に、その穴がもう選ばれている(タスク30 不具合(a) の修正: AppShell の
     * onSolidCommit が道具を選択へ戻してから作ったフィーチャーを選ぶので、選ぶものの種類が
     * 面 → 立体へ変わっても選択は空にならない)。ツリーの行を押し直さなくても中身が見える。
     */
    await expect(solidRow(page, '穴1')).toBeVisible();
    await expect(solidRowBox(page, '穴1')).toHaveClass(/pcad-tree__row--selected/);
    await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
    await expect(propertyValue(page, '選んだ面')).toHaveText('1');
    await expect(propertyValue(page, '中心の点')).toHaveText('1');
    await expect(propertyValue(page, '加工するもとの立体')).toHaveText('押し出し1');
    await expect(solidRowBox(page, '押し出し1')).toContainText('統合済み');

    // 7) その穴を選んだまま「直線パターン」で 3 つ並べる(FR-411、§0.a-0.20)。
    //    既定は「X・間隔 20・個数 3」。間隔 20 では 3 つ目が板からはみ出すので 15 にする。
    await openToolMenu(page, '加工');
    await expect(machiningTool(page, '直線パターン')).toBeEnabled();
    await machiningTool(page, '直線パターン').click();
    await expect(popoverTitle(page)).toHaveText('まっすぐ並べる');
    await expect(popoverInputs(page).nth(0)).toHaveValue('20');
    await expect(popoverInputs(page).nth(1)).toHaveValue('3');
    await fillFields(page, ['15', null]);
    await commitPopover(page);

    await expect(solidRow(page, '直線パターン1')).toBeVisible();
    await solidRow(page, '直線パターン1').click();
    await expectVolume(page, BOARD_VOLUME - 3 * HOLE_6_THROUGH);
    await expect(propertyValue(page, '並べる穴')).toHaveText('穴1');

    // 8) 元に戻す・やり直す(FR-505)。加工も同じように 1 段ずつ戻る。
    await page.keyboard.press('Control+z');
    await expect(solidRow(page, '直線パターン1')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(solidRow(page, '穴1')).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+y');
    await expect(solidRow(page, '直線パターン1')).toBeVisible();

    // 9) 保存する(FR-806、`.pcad` のスキーマ版 3)。
    const downloadPromise = page.waitForEvent('download');
    await fileAction(page, '保存').click();
    const download = await downloadPromise;
    const savedPath = testInfo.outputPath('machining.pcad');
    await download.saveAs(savedPath);
    const savedSize = statSync(savedPath).size;
    expect(savedSize).toBeGreaterThan(0);
    await expect(statusText(page)).toHaveText('保存しました');
    // 大きさは報告に載せる(§5.4 の実測。中身の大半はサムネイルの画像)。
    console.log(`[実測] 加工つきの .pcad の大きさ: ${String(savedSize)} バイト`);

    // 10) 新規 → 開き直し。加工も含めて戻る(FR-801)。
    await fileAction(page, '新規').click();
    await expect(featureTree(page)).toContainText('まだ何もありません。');

    const chooserPromise = page.waitForEvent('filechooser');
    await fileAction(page, '開く').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(savedPath);

    await expect(solidRow(page, '押し出し1')).toBeVisible();
    await expect(solidRow(page, '穴1')).toBeVisible();
    await expect(solidRow(page, '直線パターン1')).toBeVisible();

    // 11) 直径を式のまま直すと、下流のパターンも一緒に作り直される(FR-311、FR-502)。
    await solidRow(page, '直線パターン1').click();
    await expectVolume(page, BOARD_VOLUME - 3 * HOLE_6_THROUGH);
    await solidRow(page, '穴1').click();
    await expect(propertyField(page, '直径')).toHaveValue('6');
    // 穴1 はパターンに消費されているので、単独の体積は出ない(§0.a-0.20)。
    await expect(propertyValue(page, '体積')).toHaveText('統合済み');
    await propertyField(page, '直径').fill('8');
    await solidRow(page, '直線パターン1').click();
    await expectVolume(page, BOARD_VOLUME - 3 * HOLE_8_THROUGH);

    /*
     * ここまで確認の窓は一度も出ていない(NFR-UX-3)。「新規」は保存した直後、「開く」は
     * その新規の直後で、どちらも失う変更が無いため。用意だけしておくのは、万一出たときに
     * 頁が答えを待って止まらないようにするため(acceptConfirms の doc comment)。
     */
    expect(confirms).toEqual([]);

    expect(errors).toEqual([]);
  });

  test('JIS の呼びからねじ穴があけられる(FR-406)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 40 × 30 の板を 15 押し出す(止まり穴が板を突き抜けない厚みにする)。
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
    await extrudeFace(page, '面1', '15');
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`18000 ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 2) 中心の点を板の真ん中に打つ。
    await sketchTool(page, '点').click();
    await fillFields(page, ['20', '15', '0']);
    await commitPopover(page);
    await cancelPopover(page);

    // 3) 「ねじ穴」を押すと選ぶものが「面」へ切り替わる(§0.a-0.6)。面 → 点の順に選んで、
    //    もう一度押す。呼びの既定は M6、系列の既定は並目。
    await openToolMenu(page, '加工');
    const threadHoleButton = machiningTool(page, 'ねじ穴');
    await expect(threadHoleButton).toBeDisabled();
    await threadHoleButton.click({ force: true });
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await clickWorldPoint(page, topFaceCenter(15));
    await treeRow(page, '点1').click({ modifiers: ['Shift'] });
    await openToolMenu(page, '加工');
    await expect(threadHoleButton).toBeEnabled();
    await threadHoleButton.click();

    await expect(popoverTitle(page)).toHaveText('ねじ穴をあける');
    await expect(popover(page).locator('.pcad-menu__count')).toHaveText('M6');
    await expect(
      popover(page).getByRole('group', { name: 'ねじの種類' }).getByRole('button', { name: '並目' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // 深さ 10・ねじ部の長さ 10 の既定のまま決める(NFR-UX-4)。
    await expect(popoverInputs(page).nth(0)).toHaveValue('10');
    await expect(popoverInputs(page).nth(1)).toHaveValue('10');
    await commitPopover(page);

    // 4) M6 並目のピッチ 1・下穴径 D1 = 6 − (5√3/8)·1 が規格から入る(§0.a-0.13、0.14)。
    const drillM6 = 6 - (5 * Math.sqrt(3) * 1) / 8;
    await expect(solidRow(page, 'ねじ穴1')).toBeVisible();
    await solidRow(page, 'ねじ穴1').click();
    await expect(propertyField(page, 'ピッチ')).toHaveValue('1');
    expect(Number(await propertyField(page, '下穴径').inputValue())).toBeCloseTo(drillM6, 6);
    // 掘られたのは下穴径の円柱、深さ 10(止まり穴、平底。§0.a-0.11)。
    await expectVolume(page, 18000 - Math.PI * (drillM6 / 2) ** 2 * 10);

    // 5) 見せ方の既定は「簡略」(§0.a-0.15。実らせんは重いので既定にしない)。
    await expect(
      propertyChoice(page, '見せ方').getByRole('button', { name: '簡略', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    // 6) 呼びを M10 へ変えると、ピッチも下穴径も規格の値に入れ替わり、形も作り直される。
    await propertyMenu(page, '呼び').locator('.pcad-menu__trigger').click();
    await propertyMenu(page, '呼び').getByRole('menuitem', { name: 'M10', exact: true }).click();

    const drillM10 = 10 - (5 * Math.sqrt(3) * 1.5) / 8;
    await expect(propertyField(page, 'ピッチ')).toHaveValue('1.5');
    expect(Number(await propertyField(page, '下穴径').inputValue())).toBeCloseTo(drillM10, 6);
    await expectVolume(page, 18000 - Math.PI * (drillM10 / 2) ** 2 * 10);

    expect(errors).toEqual([]);
  });

  test('辺を選んで面を取り、角を丸められる(FR-407、FR-408)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
    await extrudeFace(page, '面1', null);
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 1) `2` で選ぶものを「辺」にし、上面の手前(y = 0)の長辺(長さ 40)の中点を押す。
    //    2026-09-06 に既定の視点を「前・上・右が見える向き」へ変えたので、y = 0 の辺は手前に見える。
    await sketchTool(page, '選択').click();
    await page.keyboard.press('2');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
    await openToolMenu(page, '加工');
    await expect(machiningTool(page, 'C面取り')).toBeDisabled();
    // 開いた一覧はビューポートに重なるので、押さずに確かめただけのときは閉じてから進む。
    await closeToolMenu(page, '加工');
    await clickWorldPoint(page, [20, 0, 10]);
    await openToolMenu(page, '加工');
    await expect(machiningTool(page, 'C面取り')).toBeEnabled();

    // 2) C 面取り(等距離)距離 2。45 度なので、取れる量は 1/2·2·2·40。
    await machiningTool(page, 'C面取り').click();
    await expect(popoverTitle(page)).toHaveText('面を取る');
    await expect(
      popover(page).getByRole('group', { name: '決め方' }).getByRole('button', { name: '距離', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await fillFields(page, ['2']);
    await commitPopover(page);

    await expect(solidRow(page, 'C面取り1')).toBeVisible();
    await solidRow(page, 'C面取り1').click();
    await expectVolume(page, BOARD_VOLUME - (2 * 2 * 40) / 2);
    await expect(propertyValue(page, '選んだ辺')).toHaveText('1');

    // 3) 元に戻して板へ戻す。次の R 面取りを、面取りの影響を受けていない辺にかけるため。
    await page.keyboard.press('Control+z');
    await expect(solidRow(page, 'C面取り1')).toHaveCount(0);
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`);

    // 4) 手前の左(x = 0, y = 0)の縦の辺(長さ 10)を押して R 面取り。半径の既定は 2。
    //    取れる量は (R² − πR²/4)·10 = 10·(4 − π)。
    await page.keyboard.press('2');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
    await clickWorldPoint(page, [0, 0, 5]);
    await openToolMenu(page, '加工');
    await expect(machiningTool(page, 'R面取り')).toBeEnabled();
    await machiningTool(page, 'R面取り').click();
    await expect(popoverTitle(page)).toHaveText('角を丸める');
    await expect(popoverInputs(page).first()).toHaveValue('2');
    await commitPopover(page);

    await expect(solidRow(page, 'R面取り1')).toBeVisible();
    await solidRow(page, 'R面取り1').click();
    await expectVolume(page, BOARD_VOLUME - 10 * (4 - Math.PI));
    await expect(propertyValue(page, '選んだ辺')).toHaveText('1');

    /*
     * 5) 面取りをかけた立体の上でマウスを動かしたときの費用(計画書タスク30 手順4)。
     *    100 回動かすあいだの描画の間隔を測る。上限で落とさず実測を報告するだけにする
     *    (60fps の判定は目視と NFR-PF-1 の性能検査が受け持つ)。
     */
    const canvasBox = await page.locator('canvas.pcad-viewport__canvas').boundingBox();
    if (canvasBox === null) {
      throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
    }
    await page.evaluate(() => {
      const samples: number[] = [];
      let previous = performance.now();
      const step = (): void => {
        const now = performance.now();
        samples.push(now - previous);
        previous = now;
        if (window.pcadFrameSamples !== undefined) {
          requestAnimationFrame(step);
        }
      };
      window.pcadFrameSamples = samples;
      requestAnimationFrame(step);
    });
    const start = worldToCanvas([0, 0, 10], canvasBox.width, canvasBox.height);
    const end = worldToCanvas([40, 30, 10], canvasBox.width, canvasBox.height);
    for (let index = 0; index < 100; index += 1) {
      const ratio = index / 99;
      await page.mouse.move(
        canvasBox.x + start[0] + (end[0] - start[0]) * ratio,
        canvasBox.y + start[1] + (end[1] - start[1]) * ratio,
      );
    }
    const frames = await page.evaluate(() => {
      const samples = window.pcadFrameSamples ?? [];
      window.pcadFrameSamples = undefined;
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        count: sorted.length,
        median: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)],
        max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
      };
    });
    expect(frames.count).toBeGreaterThan(0);
    // 実測は報告に載せる(統括が §5 の目視と突き合わせる)。
    console.log(
      `[実測] pointermove 100 回のあいだの描画間隔: 中央値 ${frames.median.toFixed(2)}ms / 最大 ${frames.max.toFixed(2)}ms(${String(frames.count)} フレーム)`,
    );

    expect(errors).toEqual([]);
  });

  test('上流の形を変えても加工が付いてくる(§2.2、FR-502)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 40 × 30 × 10 の板の上面に φ6 の貫通穴を 1 つあける。
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
    await extrudeFace(page, '面1', null);
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });

    await sketchTool(page, '点').click();
    await fillFields(page, ['20', '15', '0']);
    await commitPopover(page);
    await cancelPopover(page);

    await openToolMenu(page, '加工');
    const holeButton = machiningTool(page, '穴');
    await holeButton.click({ force: true });
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await clickWorldPoint(page, topFaceCenter(10));
    await treeRow(page, '点1').click({ modifiers: ['Shift'] });
    await openToolMenu(page, '加工');
    await holeButton.click();
    await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
    await commitPopover(page);
    await expect(solidRow(page, '穴1')).toBeVisible();
    await solidRow(page, '穴1').click();
    await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);

    // 2) 押し出しの距離を 10 → 20 に変えても、穴は上の面に残る(指紋で選び直す、§2.2)。
    await solidRow(page, '押し出し1').click();
    await propertyField(page, '距離').fill('20');
    await solidRow(page, '穴1').click();
    await expectVolume(page, 40 * 30 * 20 - Math.PI * 9 * 20);

    // 3) 断面そのものを 40 × 30 → 40 × 60 に広げても、穴は残る。
    //    奥行きは線分2 の ΔY と線分4 の ΔY の 2 つで決まるので、両方を書き換える
    //    (途中は輪が閉じず面が作れないが、アプリは落ちない。FR-504)。
    await treeRow(page, '線分2').click();
    await expect(propertyInputs(page).nth(4)).toHaveValue('30');
    await propertyInputs(page).nth(4).fill('60');
    await treeRow(page, '線分4').click();
    await expect(propertyInputs(page).nth(4)).toHaveValue('-30');
    await propertyInputs(page).nth(4).fill('-60');

    await solidRow(page, '穴1').click();
    await expectVolume(page, 40 * 60 * 20 - Math.PI * 9 * 20);

    expect(errors).toEqual([]);
  });

  test('加工の間違った操作は理由が出て、何も作られない(NFR-UX-5、FR-504)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
    await extrudeFace(page, '面1', null);
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 1) 面を選ばずに「穴」。押せない状態でも選ぶものが「面」へ切り替わり(§0.a-0.6、
    //    タスク30 不具合(b) の修正)、ツールチップと帯の両方に理由が読める。
    await openToolMenu(page, '加工');
    const holeButton = machiningTool(page, '穴');
    await expect(holeButton).toBeDisabled();
    await expect(holeButton).toHaveAttribute('title', '穴: 穴をあける面が選ばれていません。');
    await holeButton.click({ force: true });
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await expect(statusText(page)).toHaveText(
      `${SOLID_ERROR_PREFIX} 穴をあける面が選ばれていません。`,
    );
    await expect(solidRows(page)).toHaveCount(1);

    // 2) 立体の上面の中央を押す(押し出したもとのスケッチ面より立体の面が優先して当たる、
    //    タスク30 不具合(c) の修正)。今度は中心の点が無いという理由に変わる。
    await clickWorldPoint(page, topFaceCenter(10));
    await openToolMenu(page, '加工');
    await expect(holeButton).toHaveAttribute('title', '穴: 穴の中心にする点が選ばれていません。');
    await holeButton.click({ force: true });
    await expect(statusText(page)).toHaveText(
      `${SOLID_ERROR_PREFIX} 穴の中心にする点が選ばれていません。`,
    );
    await expect(solidRows(page)).toHaveCount(1);

    // 3) 穴でない立体を選んで「直線パターン」(§0.a-0.20 の「対象は穴とねじ穴だけ」)。
    await page.keyboard.press('4');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');
    await solidRow(page, '押し出し1').click();
    await openToolMenu(page, '加工');
    const patternButton = machiningTool(page, '直線パターン');
    await expect(patternButton).toBeDisabled();
    await patternButton.click({ force: true });
    await expect(statusText(page)).toHaveText(
      `${SOLID_ERROR_PREFIX} 並べられるのは穴とねじ穴だけです。`,
    );
    await expect(solidRows(page)).toHaveCount(1);

    // 4) 選ぶ種類は `1`〜`4` で切り替わる(§0.a-0.6)。
    await page.keyboard.press('1');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 頂点');
    await page.keyboard.press('2');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
    await page.keyboard.press('3');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await page.keyboard.press('4');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');

    // 5) 式の欄に文字を打っているあいだは横取りしない(数字はそのまま欄へ入る)。
    await solidRow(page, '押し出し1').click();
    const distanceInput = propertyField(page, '距離');
    await distanceInput.click();
    await distanceInput.press('2');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');
    await expect(distanceInput).toHaveValue('102');
    await distanceInput.fill('10');
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`);

    /*
     * 6) 大きすぎる半径の R 面取りは、赤い印と理由が出るだけでアプリは落ちない(NFR-RE-1)。
     *    直前まで式の欄に焦点があるので、まず道具を選び直してビューポートへ焦点を戻す
     *    (5) で確かめたとおり、欄に焦点があるあいだは `2` が横取りされないため)。
     */
    await sketchTool(page, '選択').click();
    await page.keyboard.press('2');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
    await clickWorldPoint(page, [0, 0, 5]);
    await openToolMenu(page, '加工');
    await machiningTool(page, 'R面取り').click();
    await commitPopover(page);
    await expect(solidRow(page, 'R面取り1')).toBeVisible();
    await solidRow(page, 'R面取り1').click();
    await expectVolume(page, BOARD_VOLUME - 10 * (4 - Math.PI));

    await propertyField(page, '半径').fill('50');
    await expect(solidRowBox(page, 'R面取り1').locator('.pcad-tree__alert')).toHaveAttribute(
      'title',
      /丸められない辺が 1 本ありました。半径を小さくしてください。/,
      { timeout: KERNEL_TIMEOUT_MS },
    );
    await expect(propertyPanel(page).locator('.pcad-panel__error')).toHaveText(
      '丸められない辺が 1 本ありました。半径を小さくしてください。',
    );

    // 7) 値を戻すと形も戻る。ここまでの失敗で画面が固まっていないことの証拠になる。
    await propertyField(page, '半径').fill('2');
    await expect(solidRowBox(page, 'R面取り1').locator('.pcad-tree__alert')).toHaveCount(0, {
      timeout: KERNEL_TIMEOUT_MS,
    });
    await expectVolume(page, BOARD_VOLUME - 10 * (4 - Math.PI));

    expect(errors).toEqual([]);
  });

  test('点からコイルばねが作れる(FR-414)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 始点になる点を 1 つ打ち、それを選んで「ばね」を押す(§0.a-0.29)。
    await sketchTool(page, '点').click();
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await treeRow(page, '点1').click();

    // 2) 1 段目「ばねの形」。コイル径 20・線径 2 が既定(§0.a-0.30)。
    await openToolMenu(page, '作る');
    await solidTool(page, 'ばね').click();
    await expect(popoverTitle(page)).toHaveText('ばねの形を決める');
    await expect(popoverInputs(page).nth(0)).toHaveValue('20');
    await expect(popoverInputs(page).nth(1)).toHaveValue('2');
    await commitPopover(page);

    // 3) 2 段目「ばねの長さ」。ピッチ 5・巻数 4 が既定で、全長は計算値なので欄に出ない。
    await expect(popoverTitle(page)).toHaveText('ばねの長さを決める');
    await expect(popoverInputs(page)).toHaveCount(2);
    await expect(popoverInputs(page).nth(0)).toHaveValue('5');
    await expect(popoverInputs(page).nth(1)).toHaveValue('4');
    await commitPopover(page);

    /*
     * 4) ばね1 ができる。体積は線材の断面積 × らせんの長さ(§2.7b.5)。
     *    らせんは曲がっているので厳密には掃引体の体積と一致しない。許容は相対 0.5%。
     */
    const springVolume = (turns: number, pitch: number): number =>
      Math.PI * 1 ** 2 * turns * Math.hypot(Math.PI * 20, pitch);
    await expect(solidRow(page, 'ばね1')).toBeVisible();
    await expectVolume(page, springVolume(4, 5), springVolume(4, 5) * 0.005);
    // ばねは対象を消費しない「作る」フィーチャー(§0.a-0.36)。
    await expect(solidRowBox(page, 'ばね1')).not.toContainText('統合済み');

    // 5) 求める値は「全長」で、全長は読み取り専用の計算値(= ピッチ × 巻数)。
    await expect(
      propertyChoice(page, '求める値').getByRole('button', { name: '全長', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(propertyField(page, '全長')).toHaveAttribute('readonly', '');
    await expect(propertyFieldMessage(page, '全長')).toHaveText('= 20');

    // 6) 巻数を 8 にすると全長も体積も倍になる(FR-311、FR-502)。
    await propertyField(page, '巻数').fill('8');
    await expect(propertyFieldMessage(page, '全長')).toHaveText('= 40');
    await expectVolume(page, springVolume(8, 5), springVolume(8, 5) * 0.005);

    // 7) 求める値を「ピッチ」に切り替え、全長に 20 を入れるとピッチが 20/8 になる。
    await propertyChoice(page, '求める値').getByRole('button', { name: 'ピッチ', exact: true }).click();
    await propertyField(page, '全長').fill('20');
    await expect(propertyFieldMessage(page, 'ピッチ')).toHaveText('= 2.5');
    await expectVolume(page, springVolume(8, 2.5), springVolume(8, 2.5) * 0.005);

    // 8) 巻き方向を変えても体積は変わらない(鏡像になるだけ、§0.a-0.33)。
    await propertyChoice(page, '巻き方向').getByRole('button', { name: '左巻き', exact: true }).click();
    await expectVolume(page, springVolume(8, 2.5), springVolume(8, 2.5) * 0.005);

    // 9) ピッチより太い線径は理由が出て、アプリは落ちない(NFR-RE-1、NFR-UX-5)。
    await propertyField(page, '線径').fill('10');
    await expect(solidRowBox(page, 'ばね1').locator('.pcad-tree__alert')).toHaveAttribute(
      'title',
      /ピッチは線径より大きくしてください/,
      { timeout: KERNEL_TIMEOUT_MS },
    );
    await expect(propertyPanel(page).locator('.pcad-panel__error')).toContainText(
      'ピッチは線径より大きくしてください。隣どうしの線がぶつかります。',
    );

    // 10) 戻せば形も戻る。
    await propertyField(page, '線径').fill('2');
    await expect(solidRowBox(page, 'ばね1').locator('.pcad-tree__alert')).toHaveCount(0, {
      timeout: KERNEL_TIMEOUT_MS,
    });
    await expectVolume(page, springVolume(8, 2.5), springVolume(8, 2.5) * 0.005);

    expect(errors).toEqual([]);
  });

  test('形の計算部が止まっても作り直して計算を続けられる(NFR-RE-1、§0.a-0.19)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    /*
     * 頁が作る Worker を控えておく。実物の Worker をそのまま作り、作られたものを
     * 覚えるだけの入れ子にする(アプリのコードは変えない)。
     *
     * OCCT の C++ 側が `abort()` すると WASM ごと止まり、Worker は応答しなくなって
     * `error` が上がる。**大きすぎるフィレットなど、実際に abort を起こせる形は
     * 見つかっていない**(docs/報告記録.md 2026-09-04 00:30 の③)ので、ここでは
     * その状態を「止める(terminate)+ 壊れた合図(error)」で作り、
     * `KernelBridge` の作り直し(§2.9)が効くことを確かめる。
     */
    await page.addInitScript(() => {
      const NativeWorker = globalThis.Worker;
      const created: Worker[] = [];
      window.pcadWorkers = created;
      class RecordingWorker extends NativeWorker {
        constructor(scriptUrl: string | URL, options?: WorkerOptions) {
          super(scriptUrl, options);
          created.push(this);
        }
      }
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: RecordingWorker,
      });
    });

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
    await extrudeFace(page, '面1', null);
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 1) 幾何カーネルの Worker を止め、壊れた合図を上げる。
    const stopped = await page.evaluate(() => {
      const workers = window.pcadWorkers ?? [];
      const worker = workers[workers.length - 1];
      if (worker === undefined) {
        return 0;
      }
      worker.terminate();
      worker.dispatchEvent(new ErrorEvent('error', { message: '検査が止めました' }));
      return workers.length;
    });
    expect(stopped).toBe(1);

    /*
     * 2) 次の再計算で作り直され、計算が続く。作り直さなければ、止めた Worker は
     *    二度と応答しないので体積は永遠に変わらない(この検査が時間切れで落ちる)。
     *    作り直すとキャッシュが空になり全段の作り直しになるので、待ちは長めに取る。
     */
    await propertyField(page, '距離').fill('20');
    await expectVolume(page, 40 * 30 * 20);

    // 3) Worker は 2 本目が作られている(1 本目は止めたまま捨てられた)。
    expect(await page.evaluate(() => (window.pcadWorkers ?? []).length)).toBe(2);

    expect(errors).toEqual([]);
  });
});
