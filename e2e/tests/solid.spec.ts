/// <reference lib="dom" />
import { statSync } from 'node:fs';

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
