/// <reference lib="dom" />
import { statSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 外観(FR-1106〜1110、要件§4.12)を、実際のブラウザで通しで確かめる
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク56 の (a)(b)、§0.a-0.53)。
 * **ヘッドレスで実行する。**
 *
 * ここで押さえるのは 2 つ。
 *
 * (a) 立体に「アルミ」、面 1 枚に「ガラス」を割り当てて**保存 → 新規 → 開き直しても
 *     割り当てが残る**(FR-1106、FR-1110、要件§9 P5 の完了条件)。
 * (b) **色や材質を変えても再計算が走らない**(§2.3 の要)。走っていないことは、
 *     ①作り直さずに済んだ段の数(`cacheHits`)が増えない、②計算中の帯が一度も出ない、
 *     ③三角形の数と体積が 1 も変わらない、の 3 つで確かめる。
 *
 * 補助関数は `e2e/tests/solid.spec.ts` / `e2e/tests/p5-primitive-pick.spec.ts` と同じ作りで、
 * 共有ファイルを作らずここへ書き写す(P1 からの作りに合わせる)。選択子は `data-testid` を
 * 足さず role / aria / class で引く。**CPU 絞りは使わない**(並列作業中の CPU 競合で
 * ゆらぐ検査を作らない。docs/報告記録.md 2026-09-04 06:10 の⑥)。
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';

/** 40 × 30 の面を 10 押し出した板の体積。 */
const PLATE_VOLUME = 40 * 30 * 10;
/** その板の三角形の数(6 面 × 2 枚)。外観を変えても 1 枚も増えない。 */
const PLATE_TRIANGLES = '12';

/** 板の上面(z = 10)の真ん中。ここを押して面 1 枚を選ぶ。 */
const PLATE_TOP_CENTER: readonly [number, number, number] = [20, 15, 10];

declare global {
  interface Window {
    /**
     * **検査専用**。再計算の様子を読む(`packages/ui/src/app/PointerCadApp.tsx` が
     * 差し出す口。アプリ自身はこれを 1 か所も呼ばない)。頁が載る前は `undefined`。
     */
    pcadRecomputeStats?: () => { readonly cacheHits: number; readonly isComputing: boolean };
    /**
     * **検査専用**。計算中の帯が出ていた瞬間に積む控え(この spec だけが読み書きする)。
     * `solid.spec.ts` の `pcadProgressSightings` と同じ仕掛けだが、名前を分けてあるのは
     * e2e の spec が 1 つの型検査の単位に入っており、同じ名前で別の型を書けないため。
     */
    pcadAppearanceProgress?: string[];
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

/** 確認の窓(`window.confirm`)に「はい」で答える(「新規」「開く」で出る)。 */
function acceptConfirms(page: Page): void {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
}

/**
 * File System Access API を無いことにしてから頁を開く(§0.a-0.10)。
 * ヘッドレスでは窓を出せないので、ダウンロードとファイル選択の代替経路へ落とす。
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
 * 計算中の帯が出た瞬間を残らず控える見張りを仕込む(NFR-PF-4)。
 * 「一度も出ていない」は、その場で数えるだけでは一瞬の点滅を見逃すため。
 */
async function watchProgress(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.pcadAppearanceProgress = seen;
    new MutationObserver(() => {
      const bar = document.querySelector('[role="progressbar"]');
      if (bar === null) {
        return;
      }
      const line = document.querySelector('.pcad-statusbar__text');
      const text = line === null ? '' : (line.textContent ?? '');
      if (seen[seen.length - 1] !== text) {
        seen.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
  });
}

/** 見張りの控えを取り出して空にする(次の場面と混ざらないように)。 */
async function takeProgress(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const seen = window.pcadAppearanceProgress;
    return seen === undefined ? [] : seen.splice(0, seen.length);
  });
}

/** 検査専用の口から、いまの `cacheHits` と `isComputing` を読む。 */
async function recomputeStats(
  page: Page,
): Promise<{ readonly cacheHits: number; readonly isComputing: boolean }> {
  return page.evaluate(() => {
    const read = window.pcadRecomputeStats;
    if (read === undefined) {
      throw new Error('検査専用の口 pcadRecomputeStats が見つかりません。');
    }
    return read();
  });
}

/** ツールバーの「スケッチ」区画の道具。 */
function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

/** ツールバーの畳んだ一覧(「作る」「合わせる」「加工」「見た目」)の引き金。 */
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

/** 開いた一覧の中の道具。 */
function menuTool(page: Page, menu: string, label: string): Locator {
  return toolMenuPanel(page, menu).getByRole('button', { name: label, exact: true });
}

/** ツールバーの「ファイル」区画のボタン(新規・開く・保存)。 */
function fileAction(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ファイル' })
    .getByRole('button', { name: label, exact: true });
}

/** その場数値入力のポップアップ。 */
function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

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

async function commitPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Enter');
}

async function cancelPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

/** 左のモデルブラウザ。 */
function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
}

/** 右のプロパティ。 */
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/** ステータスバーの下端の 1 文。 */
function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}

/**
 * 外観の節の選択肢(材質・柄・樹種)の枠。見出しの語で 1 つに絞る
 * (質量特性の節にも同じ作りの選択肢「材料」があるので、語を完全一致で見る)。
 */
function appearanceChoice(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-choice')
    .filter({ has: page.locator('.pcad-choice__label', { hasText: new RegExp(`^${label}$`) }) });
}

/** いま選ばれている選択肢の読み(引き金に出ている語)。 */
function appearanceChoiceValue(page: Page, label: string): Locator {
  return appearanceChoice(page, label).locator('.pcad-menu__count');
}

/** 選択肢を開いて 1 つ選ぶ。 */
async function chooseAppearance(page: Page, label: string, option: string): Promise<void> {
  const choice = appearanceChoice(page, label);
  await choice.locator('.pcad-menu__trigger').click();
  await choice.getByRole('menuitem', { name: option, exact: true }).click();
  await expect(appearanceChoiceValue(page, label)).toHaveText(option);
}

/** 外観の節の数の欄(色・透過率・光沢・粗さ・模様の大きさ)。 */
function appearanceField(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

/* ------------------------------------------------------------------ *
 * ビューポートの当たり判定(ホーム視点のまま押す)
 * ------------------------------------------------------------------ */

type WorldPoint = readonly [number, number, number];

/*
 * ホーム視点の見え方。数値は `packages/ui/src/viewport/cameraMath.ts` の `HOME_ORBIT` と
 * `VERTICAL_FIELD_OF_VIEW` そのままで、写し方は `createViewportScene.ts` の `worldToScreen`
 * (three.js の PerspectiveCamera + lookAt)と同じ。**この検査では視点を一度も動かさない。**
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

/** ワールド座標を canvas の左上を原点とした画素へ写す。 */
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

/* ------------------------------------------------------------------ *
 * 板を 1 枚作る
 * ------------------------------------------------------------------ */

/** 閉じた長方形を線分 4 本でかく(FR-304、FR-307)。 */
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

/** 線分を順に選んで面を張る(FR-106、FR-309)。 */
async function makeFace(page: Page, lineNames: readonly string[]): Promise<void> {
  await treeRow(page, lineNames[0]).click();
  for (const name of lineNames.slice(1)) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}

/**
 * 40 × 30 の面を 10 押し出した板を 1 枚作り、体積が出るまで待つ。
 * カーネル(約 50MB)の読み込みはこの中で終わる。
 */
async function makePlate(page: Page): Promise<void> {
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await treeRow(page, '面1').click();
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);

  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`${String(PLATE_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
  await expect(propertyValue(page, '三角形の数')).toHaveText(PLATE_TRIANGLES);
}

/** 選ぶ種類を「面」にして、板の上面を 1 枚選ぶ。 */
async function selectTopFace(page: Page): Promise<void> {
  await sketchTool(page, '選択').click();
  await page.keyboard.press('3');
  await expect(page.locator('.pcad-statusbar__state').first()).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, PLATE_TOP_CENTER);
  // 「選んでいるもの」が面になっていれば、上面 1 枚が選べている(測定の節の読み取り口)。
  await expect(propertyValue(page, '選んでいるもの')).toHaveText('面');
}

test.describe('P5 外観', () => {
  // 窓の大きさは他の P5 の検査と同じ 1440×900 に固定する(当たり判定は画素で決まる)。
  test.use({ viewport: { width: 1440, height: 900 } });

  test('立体に「アルミ」・面に「ガラス」を割り当て、保存して開き直しても残る(FR-1106、FR-1110)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    acceptConfirms(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await makePlate(page);

    // 1) 立体を選んだままの状態で「材質」を「アルミ」にする(外観の節は選んだだけで出る)。
    await expect(appearanceChoiceValue(page, '材質')).toHaveText('既定');
    await chooseAppearance(page, '材質', 'アルミ');

    /*
     * 2) 上面 1 枚を選ぶ。この時点で欄に出るのは**立体に付けたアルミ**(§2.2.2 の
     *    「面 → 立体 → 既定」の優先順位で、面にはまだ何も付いていないため)。
     *    そこへ「ガラス」を割り当てると、面の割り当てが立体の割り当てより優先される。
     */
    await selectTopFace(page);
    await expect(appearanceChoiceValue(page, '材質')).toHaveText('アルミ');
    await chooseAppearance(page, '材質', 'ガラス');
    // ガラスの既定の透過率が欄に入る(FR-1109、`materialPresets.ts` の glass)。
    await expect(appearanceField(page, '透過率')).toHaveValue('92');

    // 3) 保存する(File System Access API を消してあるのでダウンロードで落ちる)。
    const downloadPromise = page.waitForEvent('download');
    await fileAction(page, '保存').click();
    const download = await downloadPromise;
    const savedPath = testInfo.outputPath('appearance.pcad');
    await download.saveAs(savedPath);
    expect(statSync(savedPath).size).toBeGreaterThan(0);
    await expect(statusText(page)).toHaveText('保存しました');

    // 4) 新規で空にしてから、保存したファイルを開き直す。
    await fileAction(page, '新規').click();
    await expect(featureTree(page)).toContainText('まだ何もありません。');

    const chooserPromise = page.waitForEvent('filechooser');
    await fileAction(page, '開く').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(savedPath);

    await expect(solidRow(page, '押し出し1')).toBeVisible();
    await solidRow(page, '押し出し1').click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(PLATE_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 5) 立体の割り当てが残っている。
    await expect(appearanceChoiceValue(page, '材質')).toHaveText('アルミ');

    // 6) 面の割り当ても、**同じ面**に残っている(形が変わっていないので選び直しも起きない)。
    await selectTopFace(page);
    await expect(appearanceChoiceValue(page, '材質')).toHaveText('ガラス');
    // 「色を付けた面が見つかりません」の知らせは出ていない(§2.2.3)。
    await expect(propertyPanel(page)).not.toContainText('見つからない割り当て');

    expect(errors).toEqual([]);
  });

  test('色や材質を変えても再計算が走らない(FR-1106、§2.3)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);
    await watchProgress(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await makePlate(page);

    /*
     * 1) ここまでの形の計算で出た帯と控えは捨て、**外観を変える直前**の様子を控える。
     *    `cacheHits` は「作り直さずに済んだ段の数」なので、再計算が 1 度でも走れば必ず増える
     *    (板は 1 段だけなので、同じ形の計算し直しは必ず控えに当たる)。
     */
    await takeProgress(page);
    const before = await recomputeStats(page);
    expect(before.isComputing).toBe(false);

    /*
     * 2) 材質・色・光沢・粗さ・透過率を続けて変える(どれも形は 1 ミリも動かさない)。
     *    アルミは色を持つ材質(`colorEditable: false`)なので、色を打ち替えると材質の読みは
     *    「自分で決める」へ移る(`appearanceWithColor`)。ここで見たいのは再計算が
     *    走らないことなので、材質の読みは追わない。
     */
    await chooseAppearance(page, '材質', 'アルミ');
    await appearanceField(page, '色').fill('#ff8800');
    await expect(appearanceField(page, '色')).toHaveValue('#ff8800');
    await appearanceField(page, '光沢').fill('80');
    await expect(appearanceField(page, '光沢')).toHaveValue('80');
    await appearanceField(page, '粗さ').fill('5*2');
    await expect(appearanceField(page, '粗さ')).toHaveValue('5*2');
    await chooseAppearance(page, '材質', 'ガラス');
    await appearanceField(page, '透過率').fill('50');
    await expect(appearanceField(page, '透過率')).toHaveValue('50');

    /*
     * 3) 走っていないことの確かめ。
     *    ①作り直さずに済んだ段の数が 1 つも増えていない = 計算そのものが始まっていない。
     *    ②計算中の帯が一度も出ていない。
     *    ③形の出力(体積・三角形の数)が 1 も変わっていない。
     */
    const after = await recomputeStats(page);
    expect(after.cacheHits).toBe(before.cacheHits);
    expect(after.isComputing).toBe(false);
    expect(await takeProgress(page)).toEqual([]);
    await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
    await expect(propertyValue(page, '体積')).toHaveText(`${String(PLATE_VOLUME)} ${VOLUME_UNIT}`);
    await expect(propertyValue(page, '三角形の数')).toHaveText(PLATE_TRIANGLES);

    /*
     * 4) 取り消し(Ctrl+Z)で外観の変更だけが戻る。ここでも形は変わらないので
     *    再計算は走らない(§2.3。取り消しの段は外観の変更ごとに 1 段ずつ積まれている)。
     *
     *    **先に木の行を押して焦点を欄から外す。** 元に戻す・やり直すは、入力欄に焦点が
     *    あるときは効かない(`AppShell.tsx` の `isTextEntry` の除外。打っている途中の
     *    文字を巻き戻さないため)。行の押し直しは選択を同じ 1 つに置き直すだけ。
     */
    await solidRow(page, '押し出し1').click();
    await page.keyboard.press('Control+z');
    // ガラスの既定(92)へ戻る。50 を打つ前の値がそのまま返ってくる。
    await expect(appearanceField(page, '透過率')).toHaveValue('92');
    const undone = await recomputeStats(page);
    expect(undone.cacheHits).toBe(before.cacheHits);
    expect(await takeProgress(page)).toEqual([]);

    expect(errors).toEqual([]);
  });
});
