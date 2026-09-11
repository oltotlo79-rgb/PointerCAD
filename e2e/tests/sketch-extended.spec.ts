/// <reference lib="dom" />
import { statSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P4「スケッチ拡張」の完了条件のうち、**作図面の上でかく新しい図形と、その編集**を
 * 実際のブラウザで通しで確かめる(計画書 docs/plans/P4-スケッチ拡張.md §5.5 の
 * 1〜6・9・10・12、タスク34)。**ヘッドレスで実行する。**
 *
 * 任意の作業平面・基準ジオメトリ・3D スケッチ・投影・原点の再設定は
 * `e2e/tests/workplane-3d.spec.ts` が受け持つ。2 ファイルに分けたのは、既存の 3 ファイルへ
 * 足すと 1 ファイルの所要が長くなり、並列ワーカーで分担できなくなるため。
 *
 * 待ちは Playwright の自動待機(toBeVisible / toHaveText / toHaveCount / expect.poll)だけで
 * 行い、固定の sleep は置かない。幾何カーネル(Worker + OCCT、約 50MB)の読み込みが挟まる
 * 待ちにだけ長めの上限を渡す。
 *
 * 補助関数は `e2e/tests/sketch.spec.ts` / `solid.spec.ts` と同じ作りで、共有ファイルを
 * 作らずここへ書き写す(P1〜P3 の作りに合わせる)。選択子は `data-testid` を足さず
 * role / aria / class で引き、名前がぶつかるものは区画で絞る
 * (docs/報告記録.md 2026-09-02 23:50)。
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/** ja.json の statusBar.editError。編集の道具が断ったときに帯の頭へ付く言葉。 */
const EDIT_ERROR_PREFIX = '編集できませんでした:';

/**
 * ツールバーが 1 段に収まっているときの高さの上限(px)。
 * 1440px の窓での実測は 68.5px(docs/報告記録.md 2026-09-04 10:50・20:30 の利用者の決定)で、
 * 2 段になると 128px 以上になる。書体の差を見込んで 70px を境にする。
 */
const TOOLBAR_SINGLE_ROW_MAX_HEIGHT_PX = 70;

/* ========================================================================== *
 * 補助関数
 * ========================================================================== */

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
 * 確認の窓(`window.confirm`)に「はい」で答える(NFR-UX-3)。
 * 「新規」「開く」は押した瞬間に確認を出すので、**押す前に**答える用意をしておく。
 */
function acceptConfirms(page: Page): void {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
}

/**
 * File System Access API を無いことにしてから頁を開く(solid.spec.ts と同じ)。
 * ヘッドレスでは窓を出せないので、ダウンロードとファイル選択の代替経路へ落とす。
 */
async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'showOpenFilePicker', {
      configurable: true,
      value: undefined,
    });
  });
}

/** ツールバーの「スケッチ」区画の道具(平置きの 6 つ)。 */
function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

/** ツールバーの「ソリッド」区画の操作。図柄だけのボタンなので名前は読み上げ名が持つ。 */
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

/** ポップアップの式の欄。 */
function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

/** 欄の下に出ている赤い理由(FR-204、NFR-UX-5)。 */
function popoverErrors(page: Page): Locator {
  return page.locator('.pcad-popover .pcad-field__message--error');
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

/** モデルブラウザの要素の行。名前のボタンを押すとその要素を選ぶ(FR-106、FR-501)。 */
function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

/** モデルブラウザの節(「スケッチ」「ソリッド」「基準」)。 */
function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

/** 「スケッチ」節に並んでいる要素の数。「増えていない」を数で確かめるのに使う。 */
function sketchRows(page: Page): Locator {
  return treeSection(page, 'スケッチ').locator('.pcad-tree__children > li');
}

/** プロパティの「鍵と値」の値の側。鍵の見出しの次に来る `dd` を引く。 */
function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/** プロパティの式の欄を見出しで引く。見出しは完全一致で照合する。 */
function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

/** プロパティの座標などの式の欄(並び順で引く)。線分なら 0〜2 が始点、3〜5 が終点。 */
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

/**
 * Enter で決定する(§2.9)。
 * 欄を持たない段(スプラインの「決め方」)は Enter を打つ相手がいないので「決定」を押す。
 */
async function commitPopover(page: Page): Promise<void> {
  await expect(popover(page)).toBeVisible();
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Enter');
    return;
  }
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
}

/** Esc で取消して閉じる(§2.9、NFR-UX-3)。開いていなければ何もしない。 */
async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) {
    return;
  }
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Escape');
  } else {
    await page.locator('canvas.pcad-viewport__canvas').press('Escape');
  }
  await expect(popover(page)).toHaveCount(0);
}

/** ポップアップの中の選択肢・つまみを名前で押す。 */
async function pickInPopover(page: Page, label: string): Promise<void> {
  await popover(page).getByRole('button', { name: label, exact: true }).first().click();
}

/**
 * 2 段目以降の座標の欄を「絶対」にする(既定は相対、`numericInput.ts` の
 * `defaultModeForStep`)。世界座標で入れたい段の前に必ず呼ぶ。
 */
async function useAbsolute(page: Page): Promise<void> {
  await pickInPopover(page, '絶対');
}

/**
 * 平置きの道具(点・線分・円弧・点列)を選ぶ。
 *
 * **同じ道具をもう一度押すと「押していたのを解除する」動きになる**ので、先に「選択」へ
 * 戻してから押す(docs/報告記録.md 2026-09-04 の撮影台本の申し送り)。
 */
async function chooseSketchTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await sketchTool(page, label).click();
}

/**
 * 「作図 ▾」の畳んだ一覧から道具を選ぶ(タスク32 の `ToolMenu`)。
 *
 * 同じ道具の解除を避けるため、こちらも先に「選択」へ戻してから開く。
 */
async function chooseShapeTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page
    .locator('.pcad-menu__panel[aria-label="作図"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/**
 * 「編集 ▾」の畳んだ一覧から道具を選ぶ。「編集」はスケッチ区画の **2 つ目**の ▾ ボタン。
 * 選択を残したまま道具だけ切り替えたいので、ここでは「選択」へ戻さない
 * (`setActiveTool` は選ぶものの種類が変わらなければ選択を保つ)。
 */
async function chooseEditTool(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').nth(1).click();
  await page
    .locator('.pcad-menu__panel[aria-label="編集"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** 矩形を 1 つかく(対角の 2 点を世界座標で入れる)。 */
async function drawRectangle(
  page: Page,
  corner1: readonly [string, string],
  corner2: readonly [string, string],
): Promise<void> {
  await chooseShapeTool(page, '矩形');
  await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
  await fillFields(page, [corner1[0], corner1[1], '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('矩形の 2 つ目の角');
  await useAbsolute(page);
  await fillFields(page, [corner2[0], corner2[1], '0']);
  await commitPopover(page);
  await cancelPopover(page);
}

/** 要素を順に選んでから面の道具にして Enter で面を張る(FR-106、FR-309)。 */
async function makeFace(page: Page, elementNames: readonly string[]): Promise<void> {
  await treeRow(page, elementNames[0]).click();
  for (const name of elementNames.slice(1)) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}

/** 面を 1 枚選んで押し出す(FR-401)。 */
async function extrudeFace(page: Page, faceName: string, distance: string): Promise<void> {
  await treeRow(page, faceName).click();
  await openToolMenu(page, '作る');
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await fillFields(page, [distance]);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
}

/** プロパティに出ている体積を数で読む。まだ出ていなければ NaN。 */
async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) {
    return Number.NaN;
  }
  return Number.parseFloat(await cell.innerText());
}

/**
 * 体積が期待値どおりであることを、許容差(mm³)つきで確かめる。
 * 許容の既定 0.01mm³ は solid.spec.ts と同じ(表示の丸めより十分大きく、形の違いより十分小さい)。
 */
async function expectVolume(page: Page, expected: number, toleranceMm3 = 0.01): Promise<void> {
  await expect
    .poll(async () => Math.abs((await volumeNumber(page)) - expected), {
      timeout: KERNEL_TIMEOUT_MS,
      message: `体積が ${String(expected)} mm³ ± ${String(toleranceMm3)} になること`,
    })
    .toBeLessThanOrEqual(toleranceMm3);
}

/* ========================================================================== *
 * 版 3 の `.pcad` を組み立てる(§5.5-10 の前方互換)
 * ========================================================================== */

/**
 * 版 3 の書き手が作っていた形の部品文書(`construction` が無い線分、`layout` を挟まない
 * フラットな点列、`references` の欄そのものが無い)。中身は
 * `packages/io/src/pcad/documentJson.test.ts` の「版3 → 版4の移行」の器と同じもので、
 * `SCHEMA_MIGRATIONS[3]` が通す道をアプリの「開く」から確かめる。
 */
function legacyVersion3DocumentJson(): string {
  const ev = (source: string, value: number): Record<string, unknown> => ({
    source,
    value,
    display: String(value),
  });
  const zero = (): Record<string, unknown> => ({
    mode: 'absolute',
    x: ev('0', 0),
    y: ev('0', 0),
    z: ev('0', 0),
  });
  return JSON.stringify({
    schema: 3,
    kind: 'part',
    app: 'PointerCAD',
    savedAt: '2026-09-04T00:00:00.000Z',
    document: {
      id: 'part-1',
      name: '部品1',
      schemaVersion: 3,
      activeSketchId: 'sketch-1',
      solids: [],
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'line-1',
              kind: 'line',
              name: '線分1',
              planeId: 'xy',
              from: zero(),
              to: { mode: 'absolute', x: ev('10', 10), y: ev('0', 0), z: ev('0', 0) },
            },
            {
              id: 'pointArray-1',
              kind: 'pointArray',
              name: '点列1',
              planeId: 'xy',
              base: zero(),
              azimuth: ev('0', 0),
              spacing: ev('10', 10),
              count: ev('3', 3),
            },
          ],
        },
      ],
    },
  });
}

/**
 * `document.json` だけを無圧縮(STORED)で収めた ZIP を組み立てる。
 *
 * `.pcad` は ZIP で、読み手(`packages/io/src/pcad/pcadFile.ts`)は他のアプリが作った
 * ZIP も読める作りになっている。E2E から版 3 のファイルを用意するために、ここでは
 * 依存を増やさず Node の標準機能(`zlib.crc32`)だけで最小の ZIP を書く。
 * 無圧縮なので deflate の実装は要らない。
 */
function buildStoredZip(entryName: string, contents: Buffer): Buffer {
  const name = Buffer.from(entryName, 'utf8');
  const checksum = crc32(contents);
  const size = contents.length;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // 署名
  localHeader.writeUInt16LE(20, 4); // 取り出しに必要な版
  localHeader.writeUInt16LE(0x0800, 6); // 名前が UTF-8 であることの合図
  localHeader.writeUInt16LE(0, 8); // 無圧縮
  localHeader.writeUInt16LE(0, 10); // 時刻(固定)
  localHeader.writeUInt16LE(33, 12); // 日付(固定。1980-01-01)
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(size, 18);
  localHeader.writeUInt32LE(size, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // 作った版
  centralHeader.writeUInt16LE(20, 6); // 取り出しに必要な版
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(33, 14);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(size, 20);
  centralHeader.writeUInt32LE(size, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30); // 追加の欄
  centralHeader.writeUInt16LE(0, 32); // 注釈
  centralHeader.writeUInt16LE(0, 34); // 分割の番号
  centralHeader.writeUInt16LE(0, 36); // 内部の属性
  centralHeader.writeUInt32LE(0, 38); // 外部の属性
  centralHeader.writeUInt32LE(0, 42); // 中身の先頭までの距離

  const centralSize = centralHeader.length + name.length;
  const centralOffset = localHeader.length + name.length + size;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, name, contents, centralHeader, name, end]);
}

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P4 スケッチ拡張(作図面の上の図形と編集)', () => {
  /*
   * 窓の大きさを固定する。ツールバーが 1 段に収まる条件(§5.5-12)が 1440px で決まり、
   * ビューポートの当たり判定(角のクリック)も画面の画素で決まるため。
   */
  test.use({ viewport: { width: 1440, height: 900 } });

  test('表示テーマ 5 種と拡大率を切り替えられ、端末に残る(FR-908、FR-909)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page).toHaveTitle('PointerCAD');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 既定はダーク(settings.ts の DEFAULT_DISPLAY_SETTINGS)。
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(root).toHaveAttribute('data-ui-scale', '100');

    // 歯車を押すと、非モーダルの一覧にテーマの見本 5 枚と拡大率の段が出る(§5.2)。
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('group', { name: '表示設定' });
    await expect(settings).toBeVisible();
    const themes = page.getByRole('radiogroup', { name: 'テーマ' });
    await expect(themes.getByRole('radio')).toHaveCount(5);

    /*
     * 3D 表示の地の色もテーマに追従する(§0.a-0.1)。`.pcad-viewport` の背景は
     * `--pcad-viewport-top` / `--pcad-viewport-bottom` の縦の帯で、テーマごとに値が違う。
     * three.js の中の色は画面から読めないので、同じトークンを使うこの背景で確かめる。
     */
    const viewportBackground = async (): Promise<string> =>
      page
        .locator('.pcad-viewport')
        .evaluate((element) => globalThis.getComputedStyle(element).backgroundImage);
    const backgrounds = new Map<string, string>([['dark', await viewportBackground()]]);

    // 5 種すべてを順に押す。押すたびにルート要素の data-theme が入れ替わる。
    const themeNames = [
      ['ライト', 'light'],
      ['ダークモダン', 'darkModern'],
      ['ライトモダン', 'lightModern'],
      ['モダン', 'modern'],
      ['ダーク', 'dark'],
    ] as const;
    for (const [label, id] of themeNames) {
      await themes.getByRole('radio', { name: label, exact: true }).click();
      await expect(root).toHaveAttribute('data-theme', id);
      backgrounds.set(id, await viewportBackground());
    }
    /*
     * 明るい系・暗い系・モダンで 3D の地の色が入れ替わる。ライトとライトモダンは
     * 同じ地の色を使う(モダン系の違いは角丸・余白・影で、配色は共有する。
     * `appShell.css` の `--pcad-viewport-top` / `--pcad-viewport-bottom`)ので、
     * 「5 種とも違う」ではなく「系統が違えば違う」で固定する。
     */
    expect(backgrounds.get('light')).not.toBe(backgrounds.get('dark'));
    expect(backgrounds.get('modern')).not.toBe(backgrounds.get('dark'));
    expect(backgrounds.get('modern')).not.toBe(backgrounds.get('light'));
    expect(backgrounds.get('darkModern')).not.toBe(backgrounds.get('lightModern'));

    // 拡大率は 90〜150% の 5 段(FR-909)。150% にすると倍率のトークンも 1.5 になる。
    const scales = page.getByRole('group', { name: '拡大率' });
    await expect(scales.getByRole('button')).toHaveCount(5);
    await scales.getByRole('button', { name: '150%', exact: true }).click();
    await expect(root).toHaveAttribute('data-ui-scale', '150');
    expect(
      await root.evaluate((element) =>
        globalThis.getComputedStyle(element).getPropertyValue('--pcad-scale').trim(),
      ),
    ).toBe('1.5');

    // 最後に「モダン」+ 90% にしてから読み込み直すと、どちらもそのまま残る(localStorage)。
    await themes.getByRole('radio', { name: 'モダン', exact: true }).click();
    await scales.getByRole('button', { name: '90%', exact: true }).click();
    await page.reload();
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
    await expect(root).toHaveAttribute('data-theme', 'modern');
    await expect(root).toHaveAttribute('data-ui-scale', '90');

    expect(errors).toEqual([]);
  });

  test('矩形・正多角形・長穴・楕円・スプライン・円・2 点円弧・3 点の円弧を 1 発でかける(FR-314〜318、FR-326)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 矩形(対角の 2 点)。
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await expect(treeRow(page, '矩形1')).toBeVisible();

    // 2) 正多角形(中心 → 辺数 6・半径 10 が既定、NFR-UX-4)。
    await chooseShapeTool(page, '正多角形');
    await expect(popoverTitle(page)).toHaveText('正多角形の中心');
    await fillFields(page, ['80', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('正多角形の形');
    await expect(popoverInputs(page).nth(0)).toHaveValue('6');
    await expect(popoverInputs(page).nth(1)).toHaveValue('10');
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '正多角形1')).toBeVisible();

    // 3) 長穴(2 つの中心 + 幅)。
    await chooseShapeTool(page, '長穴');
    await expect(popoverTitle(page)).toHaveText('長穴の 1 つ目の中心');
    await fillFields(page, ['0', '60', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('長穴の 2 つ目の中心');
    await useAbsolute(page);
    await fillFields(page, ['40', '60', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('長穴の幅');
    await fillFields(page, ['10']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '長穴1')).toBeVisible();

    // 4) 楕円(中心 → 長半径 20・短半径 10 → 傾き)。
    await chooseShapeTool(page, '楕円');
    await expect(popoverTitle(page)).toHaveText('楕円の中心');
    await fillFields(page, ['80', '60', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('楕円の半径');
    await expect(popoverInputs(page).nth(0)).toHaveValue('20');
    await expect(popoverInputs(page).nth(1)).toHaveValue('10');
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('楕円の傾き');
    await fillFields(page, ['30']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '楕円1')).toBeVisible();

    // 5) スプライン(点を 4 つ置いてから「点を置き終える」→ 通過点方式で決める)。
    await chooseShapeTool(page, 'スプライン');
    await expect(popoverTitle(page)).toHaveText('曲線の点');
    for (const [index, point] of [
      ['0', '-40'],
      ['20', '-20'],
      ['40', '-40'],
      ['60', '-20'],
    ].entries()) {
      if (index > 0) {
        await useAbsolute(page);
      }
      await fillFields(page, [point[0], point[1], '0']);
      await commitPopover(page);
      await expect(popoverTitle(page)).toHaveText('曲線の点');
    }
    await popover(page).getByRole('button', { name: '点を置き終える', exact: true }).click();
    await expect(popoverTitle(page)).toHaveText('曲線の決め方');
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, 'スプライン1')).toBeVisible();

    // 6) 円(中心 + 半径。角度の欄は無い、FR-326)。木に出る名前は「円弧」。
    await chooseShapeTool(page, '円');
    await expect(popoverTitle(page)).toHaveText('円の中心');
    await fillFields(page, ['-60', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円の半径');
    await expect(popoverInputs(page)).toHaveCount(1);
    await fillFields(page, ['15']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '円弧1')).toBeVisible();

    // 7) 2 点 + 半径の円弧。
    await chooseShapeTool(page, '2点円弧');
    await expect(popoverTitle(page)).toHaveText('円弧の 1 点目');
    await fillFields(page, ['-60', '60', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円弧の 2 点目');
    await useAbsolute(page);
    await fillFields(page, ['-20', '60', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円弧の半径');
    await fillFields(page, ['30']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '円弧2')).toBeVisible();

    // 8) 始点・終点・通過点の 3 点の円弧(タスク36、§5.5-17 の 2D 側)。
    await chooseShapeTool(page, '3点の円弧');
    await expect(popoverTitle(page)).toHaveText('円弧の始点');
    await fillFields(page, ['-60', '-60', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円弧の終点');
    await useAbsolute(page);
    await fillFields(page, ['-20', '-60', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円弧の通過点');
    await useAbsolute(page);
    await fillFields(page, ['-40', '-40', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '円弧3')).toBeVisible();

    // 8 つの図形がそれぞれ 1 つのフィーチャーとして積まれている(1 発でかける、§5.5-3・4)。
    await expect(sketchRows(page)).toHaveCount(8);

    expect(errors).toEqual([]);
  });

  test('円周・格子の点列と、構築線は面の境界に選べない(FR-320、FR-327)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 円周状の点列。半径 10・個数 6 が既定。
    await chooseSketchTool(page, '点列');
    await expect(popoverTitle(page)).toHaveText('点列の基準点');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('点列の並べ方');
    await pickInPopover(page, '円周');
    await expect(popoverInputs(page).nth(0)).toHaveValue('10');
    await expect(popoverInputs(page).nth(1)).toHaveValue('6');
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '点列1')).toBeVisible();
    await treeRow(page, '点列1').click();
    await expect(propertyValue(page, '点の数')).toHaveText('6');

    // 2) 格子状の点列。行 3 × 列 3 で 9 点(2 段で聞く)。
    await chooseSketchTool(page, '点列');
    await expect(popoverTitle(page)).toHaveText('点列の基準点');
    await fillFields(page, ['60', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('点列の並べ方');
    await pickInPopover(page, '格子');
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('格子の列');
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '点列2')).toBeVisible();
    await treeRow(page, '点列2').click();
    await expect(propertyValue(page, '点の数')).toHaveText('9');

    /*
     * 3) 構築線(FR-320)。円の半径の段で「構築線にする」を入にしてかくと、
     *    プロパティのつまみも入のままになる(破線での見え方は 3D の描画なので、
     *    ここでは「そう決めた」ことと「面の境界に選べない」ことで固定する)。
     */
    await chooseShapeTool(page, '円');
    await expect(popoverTitle(page)).toHaveText('円の中心');
    await fillFields(page, ['0', '-40', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円の半径');
    await fillFields(page, ['15']);
    await popover(page).getByRole('switch', { name: '構築線にする', exact: true }).click();
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '円弧1')).toBeVisible();
    await treeRow(page, '円弧1').click();
    await expect(
      propertyPanel(page).getByRole('switch', { name: '構築線にする', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');

    // 4) その構築線を境界にして面を張ろうとすると、赤い印と理由が出る(押し出しの材料に
    //    できない、FR-504)。アプリは落ちない。
    await makeFace(page, ['円弧1']);
    await expect(treeRow(page, '面1')).toBeVisible();
    await expect(
      treeSection(page, 'スケッチ')
        .locator('.pcad-tree__row--child')
        .filter({ hasText: '面1' })
        .locator('.pcad-tree__alert'),
    ).toHaveAttribute('title', /構築線は面の境界に使えません。/);

    expect(errors).toEqual([]);
  });

  test('オフセットした輪郭で面を張って押し出せる(FR-321)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 40 × 30 の矩形を外へ 5(角は丸める)。既定のまま決められる(NFR-UX-4)。
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await treeRow(page, '矩形1').click();
    await chooseEditTool(page, 'オフセット');
    await expect(popoverTitle(page)).toHaveText('オフセットの距離');
    await expect(popoverInputs(page).first()).toHaveValue('5');
    await commitPopover(page);
    await expect(treeRow(page, 'オフセット1')).toBeVisible();

    /*
     * オフセットの曲線は幾何カーネルへ 1 往復してから決まる(§2.5 の 2 段の再計算)ので、
     * 曲線が出そろうまで待ってから面を張る。線分 4 本 + 角の円弧 4 本で 8 本。
     * 待たずに面の道具へ進むと、まだ曲線を持たない要素として断られる。
     */
    await treeRow(page, 'オフセット1').click();
    await expect(propertyValue(page, '線の数')).toHaveText('8', { timeout: KERNEL_TIMEOUT_MS });

    // その輪郭で面を張って 10 押し出す。
    await makeFace(page, ['オフセット1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();

    /*
     * 体積は (外へ 5 ずらした輪郭の面積) × 10。
     * 面積は 50 × 40 の外形から 4 隅の「角の外側」を落として丸めたもの:
     * 2000 − (4 × 5² − π × 5²) = 2000 − 100 + 25π = 1978.539816…
     * (docs/報告記録.md 2026-09-04 21:05 の実測 19785.398 と一致する)。
     */
    await expectVolume(page, (2000 - 100 + 25 * Math.PI) * 10);

    expect(errors).toEqual([]);
  });

  test('トリムで切り、延長で伸ばせる(FR-322)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 自動接続を切った十字の2本で、交点まで部分トリムできる。
    // 既定の自動接続による区間削除は intersectionsFlow.ts が3環境で検査する。
    await chooseSketchTool(page, '線分');
    await expect(popoverTitle(page)).toHaveText('線分の始点');
    await fillFields(page, ['-40', '0', '0']);
    await commitPopover(page);
    await useAbsolute(page);
    await fillFields(page, ['40', '0', '0']);
    await commitPopover(page);
    await cancelPopover(page);

    await chooseSketchTool(page, '線分');
    await fillFields(page, ['0', '-40', '0']);
    await commitPopover(page);
    const connectIntersections = page.getByRole('switch', { name: '交点でつなぐ', exact: true });
    await expect(connectIntersections).toBeChecked();
    await connectIntersections.click();
    await expect(connectIntersections).not.toBeChecked();
    await useAbsolute(page);
    await fillFields(page, ['0', '40', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '線分2')).toBeVisible();

    await expect(page.locator('.pcad-panel--left').getByRole('button', { name: /^線分\d+$/u })).toHaveCount(2);
    await expect(treeRow(page, '交点1')).toHaveCount(0);

    await chooseEditTool(page, 'トリム');
    await expect(statusText(page)).toContainText('消したい部分をクリック');
    await clickWorldPoint(page, [25, 0, 0]);

    // 交点(0,0,0)で止まる。触っていない始点の式はそのまま残る(FR-322 の注釈)。
    await sketchTool(page, '選択').click();
    await treeRow(page, '線分1').click();
    await expect(propertyInputs(page).nth(0)).toHaveValue('-40');
    await expect(propertyInputs(page).nth(3)).toHaveValue('0');

    // 2) 離れた 2 本を延長でぶつかるところまで伸ばす。
    await chooseSketchTool(page, '線分');
    await fillFields(page, ['-40', '30', '0']);
    await commitPopover(page);
    await useAbsolute(page);
    await fillFields(page, ['-20', '30', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '線分3')).toBeVisible();

    await chooseEditTool(page, '延長');
    await expect(statusText(page)).toContainText('伸ばしたい端の近く');
    await clickWorldPoint(page, [-21, 30, 0]);

    // 縦線(x = 0)まで伸びる。
    await sketchTool(page, '選択').click();
    await treeRow(page, '線分3').click();
    await expect(propertyInputs(page).nth(3)).toHaveValue('0');

    expect(errors).toEqual([]);
  });

  test('角を丸め・面取りでき、矩形は角を触ると線分へ分解される(FR-323)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) L 字の角(40, 0)を半径 5 で丸める。接点は (35,0) と (40,5)。
    await chooseSketchTool(page, '線分');
    await expect(popoverTitle(page)).toHaveText('線分の始点');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await useAbsolute(page);
    await fillFields(page, ['40', '0', '0']);
    await commitPopover(page);
    await useAbsolute(page);
    await fillFields(page, ['40', '30', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '線分2')).toBeVisible();

    await chooseEditTool(page, 'フィレット');
    await clickWorldPoint(page, [40, 0, 0]);
    await expect(popoverTitle(page)).toHaveText('角を丸める');
    await expect(popoverInputs(page).first()).toHaveValue('5');
    await commitPopover(page);

    await expect(treeRow(page, '円弧1')).toBeVisible();
    await sketchTool(page, '選択').click();
    await treeRow(page, '線分1').click();
    await expect(propertyInputs(page).nth(3)).toHaveValue('35');
    await treeRow(page, '円弧1').click();
    await expect(propertyField(page, '半径')).toHaveValue('5');

    // 2) 元に戻して、同じ角を距離 3 で面取りする。斜めの線分が 1 本増える。
    await page.keyboard.press('Control+z');
    await expect(treeRow(page, '円弧1')).toHaveCount(0);
    await chooseEditTool(page, '面取り');
    await clickWorldPoint(page, [40, 0, 0]);
    await expect(popoverTitle(page)).toHaveText('面を取る');
    await expect(popoverInputs(page).first()).toHaveValue('3');
    await commitPopover(page);

    await expect(treeRow(page, '線分3')).toBeVisible();
    await sketchTool(page, '選択').click();
    await treeRow(page, '線分3').click();
    await expect(propertyInputs(page).nth(0)).toHaveValue('37');
    await expect(propertyInputs(page).nth(4)).toHaveValue('3');

    // 3) 面取りも元に戻し、同じ角で半径が大きすぎるフィレットを試す。
    //    理由が帯に出るだけで、アプリは落ちない(FR-504、NFR-RE-1)。
    await page.keyboard.press('Control+z');
    await expect(treeRow(page, '線分3')).toHaveCount(0);
    await chooseEditTool(page, 'フィレット');
    await clickWorldPoint(page, [40, 0, 0]);
    await expect(popoverTitle(page)).toHaveText('角を丸める');
    await fillFields(page, ['500']);
    await commitPopover(page);
    await expect(statusText(page)).toContainText(EDIT_ERROR_PREFIX);
    await expect(statusText(page)).toContainText('小さくしてください');
    await cancelPopover(page);

    /*
     * 4) 矩形の角を丸めると、矩形が線分 4 本へ分解されてから丸まる(§2.3)。
     *    L 字を元に戻して空にしてから確かめる。押す角を原点の近くに置きたいのと、
     *    L 字の角と紛れないようにするため(視点は動かさないので、原点から遠い点は
     *    画面の外へ出て押せない)。
     */
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(treeRow(page, '線分1')).toHaveCount(0);

    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await expect(treeRow(page, '矩形1')).toBeVisible();
    await chooseEditTool(page, 'フィレット');
    await clickWorldPoint(page, [40, 0, 0]);
    await expect(popoverTitle(page)).toHaveText('角を丸める');
    await commitPopover(page);
    await expect(treeRow(page, '矩形1')).toHaveCount(0);
    await expect(treeRow(page, '線分4')).toBeVisible();
    await expect(treeRow(page, '円弧1')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('ミラー・直線配列・円形配列でき、元を動かすと複製も追う(FR-324、FR-311)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 40 × 30 の矩形を、作図面の縦軸(XY 面なら Y 軸)で折り返す。
    await drawRectangle(page, ['10', '0'], ['50', '30']);
    await treeRow(page, '矩形1').click();
    await chooseEditTool(page, 'ミラー');
    await expect(popoverTitle(page)).toHaveText('ミラー');
    await pickInPopover(page, '作図面の縦軸');
    await commitPopover(page);
    await expect(treeRow(page, '複製1')).toBeVisible();
    await treeRow(page, '複製1').click();
    await expect(propertyValue(page, '複製するもと')).toHaveText('矩形1');

    /*
     * 2) 折り返した側の輪郭で面を張って 10 押し出す。複製は参照で解けているので、
     *    もとの矩形を広げると複製の形も変わり、体積が変わる(= 追従の証拠)。
     */
    await makeFace(page, ['複製1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 40 * 30 * 10);

    await treeRow(page, '矩形1').click();
    // 角 2 の X を 50 → 70 にすると、もとの矩形は 60 × 30 になる。
    await propertyInputs(page).nth(3).fill('70');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 60 * 30 * 10);

    // 3) 直線配列(向き 90 度・間隔 40・個数 3)。
    await treeRow(page, '矩形1').click();
    await chooseEditTool(page, '直線配列');
    await expect(popoverTitle(page)).toHaveText('直線配列(向きと間隔)');
    await fillFields(page, ['90', '40']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('直線配列(個数)');
    await fillFields(page, ['3']);
    await commitPopover(page);
    await expect(treeRow(page, '複製2')).toBeVisible();

    // 4) 円形配列(中心 (0,0,0)・既定の角度と個数)。
    await treeRow(page, '矩形1').click();
    await chooseEditTool(page, '円形配列');
    await expect(popoverTitle(page)).toHaveText('円形配列(中心)');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円形配列(角度と個数)');
    await commitPopover(page);
    await expect(treeRow(page, '複製3')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('P4 の図形を含む部品を保存して開き直すと式のまま直せ、版 3 のファイルも開ける(FR-801、§0.a-0.24)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    acceptConfirms(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 式で入れた矩形(幅 = 20*2)を押し出す。
    await chooseShapeTool(page, '矩形');
    await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await useAbsolute(page);
    await fillFields(page, ['20*2', '30', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await makeFace(page, ['矩形1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 40 * 30 * 10);

    // 2) 保存 → 新規 → 開き直し。
    const downloadPromise = page.waitForEvent('download');
    await fileAction(page, '保存').click();
    const download = await downloadPromise;
    const savedPath = testInfo.outputPath('sketch-extended.pcad');
    await download.saveAs(savedPath);
    expect(statSync(savedPath).size).toBeGreaterThan(0);
    await expect(statusText(page)).toHaveText('保存しました');

    await fileAction(page, '新規').click();
    await expect(featureTree(page)).toContainText('まだ何もありません。');

    const chooserPromise = page.waitForEvent('filechooser');
    await fileAction(page, '開く').click();
    await (await chooserPromise).setFiles(savedPath);

    // 3) 式がそのまま戻り、その場で直せる(FR-202、FR-502)。
    await expect(treeRow(page, '矩形1')).toBeVisible();
    await treeRow(page, '矩形1').click();
    await expect(propertyInputs(page).nth(3)).toHaveValue('20*2');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 40 * 30 * 10);
    await treeRow(page, '矩形1').click();
    await propertyInputs(page).nth(3).fill('20*3');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 60 * 30 * 10);

    // 4) 版 3 で保存された部品も開ける(§0.a-0.24 の前方互換、点列の layout 移行を含む)。
    const legacyPath = testInfo.outputPath('legacy-v3.pcad');
    writeFileSync(
      legacyPath,
      buildStoredZip('document.json', Buffer.from(legacyVersion3DocumentJson(), 'utf8')),
    );
    const legacyChooserPromise = page.waitForEvent('filechooser');
    await fileAction(page, '開く').click();
    await (await legacyChooserPromise).setFiles(legacyPath);

    await expect(treeRow(page, '線分1')).toBeVisible();
    await expect(treeRow(page, '点列1')).toBeVisible();
    await treeRow(page, '点列1').click();
    await expect(propertyValue(page, '点の数')).toHaveText('3');

    expect(errors).toEqual([]);
  });

  test('ツールバーは 1440px で 1 段のまま、断られてもアプリは落ちない(§5.5-12、FR-504)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    /*
     * 1) 1 段かどうかは高さと、折り返さずに並べたときの幅の両方で見る。
     *    区画は縦中央そろえなので上端の位置はもともと区画ごとに違い、段数の目印にならない。
     *    折り返しを一時的に切って `scrollWidth` を測る手は、タスク32 の実測台本
     *    (`measure-p4g.mjs`)と同じやり方で、測り終えたら元へ戻す。
     */
    const toolbar = page.locator('.pcad-toolbar');
    const height = (await toolbar.boundingBox())?.height ?? 0;
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThanOrEqual(TOOLBAR_SINGLE_ROW_MAX_HEIGHT_PX);
    const widths = await toolbar.evaluate((bar) => {
      if (!(bar instanceof HTMLElement)) {
        return { needed: Number.NaN, available: 0 };
      }
      const before = bar.style.flexWrap;
      bar.style.flexWrap = 'nowrap';
      const needed = bar.scrollWidth;
      bar.style.flexWrap = before;
      return { needed, available: bar.clientWidth };
    });
    expect(widths.needed).toBeLessThanOrEqual(widths.available);

    // 2) 区画は 5 つのまま(ツールバー / ツリー / ビューポート / プロパティ / 帯)。
    await expect(page.locator('.pcad-panel--left')).toBeVisible();
    await expect(page.locator('.pcad-panel--right')).toBeVisible();
    await expect(page.locator('.pcad-statusbar')).toBeVisible();

    // 3) 正多角形の辺数に 2 を入れると、赤い理由が出て決められない(NFR-UX-5)。
    await chooseShapeTool(page, '正多角形');
    await expect(popoverTitle(page)).toHaveText('正多角形の中心');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('正多角形の形');
    await fillFields(page, ['2', null]);
    await expect(popoverErrors(page)).toHaveCount(1);
    await commitPopover(page);
    // 決まっていないので、段は開いたままで木にも何も増えない。
    await expect(popoverTitle(page)).toHaveText('正多角形の形');
    await cancelPopover(page);
    await expect(featureTree(page)).toContainText('まだ何もありません。');

    // 4) 何も選ばずに複製系の道具を開くと、押せない理由がツールチップに読める。
    await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').nth(1).click();
    const disabledTitles = await page
      .locator('.pcad-menu__panel[aria-label="編集"] button[aria-disabled="true"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
    expect(disabledTitles.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');

    // 5) ここまでで画面は生きている(道具を選べば案内が帯へ出る)。
    await chooseSketchTool(page, '点');
    await expect(popoverTitle(page)).toHaveText('点を作る');
    await cancelPopover(page);

    expect(errors).toEqual([]);
  });
});

/* ========================================================================== *
 * ワールド座標 → 画面の画素(solid.spec.ts の写し。視点を動かさないので成り立つ)
 * ========================================================================== */

type WorldPoint = readonly [number, number, number];

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
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalizePoint(a: WorldPoint): WorldPoint {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

const CAMERA_EYE: WorldPoint = [
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH),
  HOME_DISTANCE * Math.sin(HOME_ELEVATION),
];
const CAMERA_Z = normalizePoint(CAMERA_EYE);
const CAMERA_X = normalizePoint(crossPoints([0, 0, 1], CAMERA_Z));
const CAMERA_Y = crossPoints(CAMERA_Z, CAMERA_X);

function worldToCanvas(
  world: WorldPoint,
  widthPixels: number,
  heightPixels: number,
): readonly [number, number] {
  const view = subtractPoints(world, CAMERA_EYE);
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
