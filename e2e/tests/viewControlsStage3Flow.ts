import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { command, tree } from './sheetUiFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { cameraDistance, expectSameCamera, observeControlsInput, rememberCamera } from './cameraControlsSettingsFlow.js';
import { worldToCanvas, type WorldPoint } from './homeViewProjection.js';
import { closeInputBindings, inputBindingsWindow, openInputBindings } from './inputBindingsWindowSupport.js';
import { fillFields, popover, popoverInputs } from './popoverFields.js';
import { uiMessage } from './uiMessages.js';

/*
 * 操作の割り当ての第 3 段の画面検査(設計 B-09 3-6): 設定のファイルの書き出しと読み込み(3-1)・吸着を一時止めるキー(3-2)・
 * 何も無い所からの左ドラッグの回転(3-3)・ペンの側面のボタン(3-4)。3D マウス(3-5)は実機が無く、機器の窓も検査で開けないので単体まで。
 * 既存の流れの作りをなぞる: 窓は inputBindingsWindowSupport、視点は名前付きビューと実際の .pcad(cameraControlsSettingsFlow の
 * rememberCamera)、向きの吸着は帯の文言(p4b-tracking.spec.ts)、ファイルはダウンロードとファイル選択(filePickers.ts)。
 * 期待の視点は製品の計算を使わず、届いた入力(押下から最後の移動までの画素)から、ホーム視点の式で独立に求める
 * (cameraControlsSettingsFlow の heldModifierRelease と同じ式。1 画素 0.008 rad)。
 */
const view = (key: string) => uiMessage('view', key);
const camera = (key: string) => view(`settings.camera.${key}`);
const fileText = (key: string) => view(`settings.inputBindings.file.${key}`);
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const cameraForm = (page: Page) => page.getByRole('form', { name: camera('title'), exact: true });
const cameraButton = (page: Page, key: string) => cameraForm(page).getByRole('button', { name: camera(key), exact: true });
const snapForm = (page: Page) => inputBindingsWindow(page).getByRole('form', { name: view('settings.snapPause.title'), exact: true });
const snapChoice = (page: Page) => snapForm(page).getByRole('combobox', { name: view('settings.snapPause.label'), exact: true });
const fileBar = (page: Page) => inputBindingsWindow(page).getByRole('region', { name: fileText('title'), exact: true });
const fileButton = (page: Page, key: string) => fileBar(page).getByRole('button', { name: fileText(key), exact: true });
const statusText = (page: Page) => page.locator('.pcad-statusbar__text');
const polar165 = () => uiMessage('statusBar', 'statusBar.track.polar').replace('{angle}', '165');

type ScreenPoint = { readonly x: number; readonly y: number };

async function renders(page: Page): Promise<number> {
  return page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
}
/** 視点の遷移が描画を終えて止まるまで待つ(inputBindingsFlow と同じ見方)。 */
async function settle(page: Page, previous: number): Promise<void> {
  await expect.poll(() => page.evaluate(count => {
    const stats = window.pcadViewportRenderStats?.();
    return stats !== undefined && stats.completedRenders > count && performance.now() - stats.lastCompletedAtMs > 350;
  }, previous), { timeout: 10_000, message: '視点の遷移が描画を終えて止まる' }).toBe(true);
}
async function homeButton(page: Page): Promise<void> {
  const before = await renders(page);
  await page.locator('.pcad-viewcube-home').click();
  await settle(page, before);
}
/** 何も無い所(2 つの点〔原点と (30, 0)〕から離れた、画面の中心の左下)。ポップアップや視点の立方体とも重ならない。 */
async function emptyPoint(page: Page): Promise<ScreenPoint> {
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error('ビューポートの canvas がありません。');
  return { x: Math.round(bounds.x + bounds.width / 2 - 200), y: Math.round(bounds.y + bounds.height / 2 + 120) };
}
/** 2 つの点の部品を作り、選択の道具でホームの視点にする(inputBindingsFlow の prepare と同じ始まり)。 */
async function prepare(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const value of ['0,0', '30,0']) {
    const generation = await beginRecompute(page);
    await command(page, 'PO'); await command(page, value); await page.keyboard.press('Escape');
    await waitForRecompute(page, generation);
  }
  await expect(tree(page, '点2')).toBeVisible();
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  await homeButton(page);
}
/** ホーム視点(距離 200・注視点は原点)から、届いた移動 dx・dy 画素だけ回した時のカメラの位置。 */
function orbitedFromHome(dx: number, dy: number): readonly [number, number, number] {
  const azimuth = -Math.PI / 4 - dx * 0.008, elevation = Math.atan(Math.SQRT1_2) + dy * 0.008;
  return [200 * Math.cos(elevation) * Math.cos(azimuth), 200 * Math.cos(elevation) * Math.sin(azimuth), 200 * Math.sin(elevation)];
}
async function expectOrbitedFromHome(page: Page, info: TestInfo, name: string, home: Awaited<ReturnType<typeof rememberCamera>>,
  delivered: { readonly dx: number; readonly dy: number }): Promise<void> {
  const after = await rememberCamera(page, info, name);
  const expected = orbitedFromHome(delivered.dx, delivered.dy);
  for (const axis of [0, 1, 2]) expect(after.view.position[axis]).toBeCloseTo(expected[axis], 9);
  expect(cameraDistance(after.view)).toBeCloseTo(200, 9);
  expect(after.view.target).toEqual(home.view.target); expect(after.view.up).toEqual(home.view.up);
  expect(after.view.zoom).toBe(home.view.zoom); expect(after.view.projection).toBe(home.view.projection);
  expect(after.document.sketches).toEqual(home.document.sketches);
}

/* ---------------------------------------------------------------------------------------------------------------------- *
 * 3-1 設定のファイル
 * ---------------------------------------------------------------------------------------------------------------------- */

async function chooseSnapPause(page: Page, value: 'none' | 'shift' | 'ctrl'): Promise<void> {
  await snapChoice(page).selectOption(value);
  await snapForm(page).getByRole('button', { name: view('settings.snapPause.apply'), exact: true }).click();
  await expect(snapForm(page)).toHaveAttribute('data-settings-draft', 'false');
  await expect(snapChoice(page)).toHaveValue(value);
}

/** 書き出したファイル(ダウンロード)を保存し、中身の JSON を返す。名前は窓の既定の名前。 */
async function exportSettings(page: Page, info: TestInfo): Promise<{ readonly path: string; readonly name: string; readonly file: unknown }> {
  const download = page.waitForEvent('download');
  await fileButton(page, 'export').click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(`${fileText('defaultName')}.pcadinput`);
  const path = info.outputPath(saved.suggestedFilename());
  await saved.saveAs(path);
  await expect(fileBar(page).getByRole('status')).toHaveText(fileText('exported'));
  return { path, name: saved.suggestedFilename(), file: JSON.parse(await readFile(path, 'utf8')) };
}

async function pickSettingsFile(page: Page, path: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await fileButton(page, 'import').click();
  await (await chooser).setFiles(path);
}

/** 書き出し → 今の値を変える → 下書きがある間の読み込みは断る → 読んで示す → 置き換える → 元に戻す。 */
export async function settingsFileRoundTripFlow(page: Page, info: TestInfo): Promise<void> {
  await openInputBindings(page, 'mouse');
  await chooseSnapPause(page, 'shift');
  const exported = await exportSettings(page, info);
  expect(exported.file).toMatchObject({ format: 'pointercad-input-settings', version: 1, snapPauseModifier: 'shift' });
  await chooseSnapPause(page, 'none');

  // 適用していない変更(下書き)がある間は、ファイルの選択を開かずに断る。
  await snapChoice(page).selectOption('ctrl');
  await fileButton(page, 'import').click();
  await expect(fileBar(page).getByRole('alert')).toHaveText(fileText('draftFirst'));
  await snapForm(page).getByRole('button', { name: view('settings.snapPause.cancel'), exact: true }).click();
  await expect(snapChoice(page)).toHaveValue('none');

  // 読んだ内容は窓の中に示すだけで、まだ保存しない。5 つの欄は全部読めた。
  await pickSettingsFile(page, exported.path);
  await expect(fileBar(page).getByText(fileText('preview').replace('{name}', exported.name), { exact: true })).toBeVisible();
  const sections = [view('settings.inputBindings.tab.view'), view('settings.inputBindings.tab.keys'),
    view('settings.inputBindings.tab.mouse'), view('settings.inputBindings.tab.radial'), view('settings.snapPause.title')];
  await expect(fileBar(page).getByRole('listitem')).toHaveText(sections.map(section => `${section}: ${fileText('state.read')}`));
  await expect(snapChoice(page)).toHaveValue('none');

  // 置き換えると保存され(下書きではない)、直後なら元に戻せる。
  await fileButton(page, 'replace').click();
  await expect(fileBar(page).getByRole('status')).toContainText(fileText('replaced'));
  await expect(snapChoice(page)).toHaveValue('shift');
  await expect(snapForm(page)).toHaveAttribute('data-settings-draft', 'false');
  await fileButton(page, 'undo').click();
  await expect(fileBar(page).getByRole('status')).toHaveText(fileText('undone'));
  await expect(snapChoice(page)).toHaveValue('none');
  await closeInputBindings(page);
}

/* ---------------------------------------------------------------------------------------------------------------------- *
 * 3-2 吸着を一時止めるキー
 * ---------------------------------------------------------------------------------------------------------------------- */

/** 線分の始点を (0, 0, 0) に置き、終点を聞く段にする(極の起点。p4b-tracking.spec.ts と同じ)。 */
async function startLineAtOrigin(page: Page): Promise<void> {
  const sketch = page.getByRole('group', { name: 'スケッチ', exact: true });
  await sketch.getByRole('button', { name: uiMessage('toolbar', 'toolbar.tool.select'), exact: true }).click();
  await sketch.getByRole('button', { name: uiMessage('toolbar', 'toolbar.tool.line'), exact: true }).click();
  await expect(page.locator('.pcad-popover__title')).toHaveText(uiMessage('numericInput', 'numericInput.title.lineStart'));
  await fillFields(page, ['0', '0', '0']);
  await popoverInputs(page).first().press('Enter');
  await expect(page.locator('.pcad-popover__title')).toHaveText(uiMessage('numericInput', 'numericInput.title.lineEnd'));
}
async function cancelLine(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}
/** 作図面 XY の distance∠angle°(planeToWorld(XY, …) と同じ)へ、ポインタを動かす(押さない)。 */
async function moveToPolar(page: Page, distance: number, angleDegrees: number): Promise<void> {
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error('ビューポートの canvas がありません。');
  const radians = (angleDegrees * Math.PI) / 180;
  const world: WorldPoint = [distance * Math.cos(radians), distance * Math.sin(radians), 0];
  const [x, y] = worldToCanvas(world, bounds.width, bounds.height);
  await page.mouse.move(bounds.x + x, bounds.y + y, { steps: 4 });
}

/**
 * 既定(なし)では Shift を押しても向きの吸着は効く(Shift は推定だけを止める)。キーを Shift にすると、押している間だけ
 * 向きの吸着が止まり、離して動かすと戻る。向きは p4b-tracking と同じ 163° 付近(既定の 15° 刻みで 165° へ丸まる。
 * 画面の中心より左で、その場入力のポップアップに隠れない)。
 */
export async function snapPauseFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText(view('emptyState.firstStep'));
  await startLineAtOrigin(page);
  await page.keyboard.down('Shift');
  try { await moveToPolar(page, 20, 163); await expect(statusText(page)).toContainText(polar165()); } finally { await page.keyboard.up('Shift'); }
  await cancelLine(page);

  await openInputBindings(page, 'mouse');
  await chooseSnapPause(page, 'shift');
  await closeInputBindings(page);
  await startLineAtOrigin(page);
  await moveToPolar(page, 21, 163);
  await expect(statusText(page)).toContainText(polar165());
  await page.keyboard.down('Shift');
  try { await moveToPolar(page, 20, 163); await expect(statusText(page)).not.toContainText(polar165()); } finally { await page.keyboard.up('Shift'); }
  await moveToPolar(page, 22, 163);
  await expect(statusText(page)).toContainText(polar165());
  await cancelLine(page);
}

/* ---------------------------------------------------------------------------------------------------------------------- *
 * 3-3 何も無い所からの左ドラッグで回す
 * ---------------------------------------------------------------------------------------------------------------------- */

/** 何も無い所から左ボタンで 48・24px 動かし、届いた移動量(押下から最後の移動まで)を返す。 */
async function emptyLeftDrag(page: Page): Promise<{ readonly dx: number; readonly dy: number }> {
  const start = await emptyPoint(page), observation = await observeControlsInput(page);
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(start.x + 48, start.y + 24, { steps: 6 });
    await page.mouse.up({ button: 'left' });
    const events = await observation.evaluate(value => value.events);
    expect(events.every(event => event.isTrusted)).toBe(true);
    const down = events.find(event => event.type === 'pointerdown');
    const last = events.filter(event => event.type === 'pointermove' && event.buttons === 1).at(-1);
    if (down?.x == null || down.y === null || last?.x == null || last.y === null) throw new Error('左ドラッグの出来事が届いていません。');
    expect(down).toMatchObject({ button: 0, buttons: 1, alt: false, ctrl: false, shift: false, meta: false });
    return { dx: last.x - down.x, dy: last.y - down.y };
  } finally {
    await page.mouse.up({ button: 'left' });
    await observation.evaluate(value => value.stop()); await observation.dispose();
  }
}

/** 既定(切)では何も無い所の左ドラッグで視点は動かない。入れて適用すると、同じドラッグで届いた量だけ回る。 */
export async function leftEmptyOrbitFlow(page: Page, info: TestInfo): Promise<void> {
  await prepare(page);
  const home = await rememberCamera(page, info, 'left-empty-home');
  await emptyLeftDrag(page);
  expectSameCamera((await rememberCamera(page, info, 'left-empty-off')).view, home.view);

  await openInputBindings(page, 'view');
  const option = cameraForm(page).getByRole('checkbox', { name: camera('leftEmptyOrbit'), exact: true });
  await expect(option).not.toBeChecked();
  await option.check();
  await expect(cameraForm(page).getByRole('note').filter({ hasText: camera('leftEmptyOrbitNote') })).toBeVisible();
  await cameraButton(page, 'apply').click();
  await expect(cameraButton(page, 'apply')).toBeDisabled();
  await closeInputBindings(page);

  await expectOrbitedFromHome(page, info, 'left-empty-on', home, await emptyLeftDrag(page));
}

/* ---------------------------------------------------------------------------------------------------------------------- *
 * 3-4 ペンの側面のボタン(Chromium の CDP の Input.dispatchMouseEvent の pointerType 'pen' で送る。Firefox には無い)
 * ---------------------------------------------------------------------------------------------------------------------- */

type PenButton = 'none' | 'right';

/** ペンの出来事を送る。側面のボタンは右ボタン(button 2・押下の印 2)として届く(cameraControlBindings の PEN_INPUTS)。 */
async function penInput(page: Page, steps: readonly { readonly type: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
  readonly at: ScreenPoint; readonly button: PenButton; readonly buttons: number }[]): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    for (const { type, at, button, buttons } of steps) {
      await session.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button, buttons, pointerType: 'pen',
        clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  } finally { await session.detach(); }
}
/** 側面のボタンを押したまま (dx, dy) を 6 回に分けて動かして離す。 */
async function penBarrelDrag(page: Page, from: ScreenPoint, dx: number, dy: number): Promise<void> {
  const at = (step: number): ScreenPoint => ({ x: from.x + Math.round(dx * step / 6), y: from.y + Math.round(dy * step / 6) });
  await penInput(page, [{ type: 'mouseMoved', at: from, button: 'none', buttons: 0 },
    { type: 'mousePressed', at: from, button: 'right', buttons: 2 },
    ...[1, 2, 3, 4, 5, 6].map(step => ({ type: 'mouseMoved' as const, at: at(step), button: 'right' as const, buttons: 2 })),
    { type: 'mouseReleased', at: at(6), button: 'right', buttons: 0 }]);
}
/** canvas に届いたペンの出来事(種類・ボタン・押下の印・座標・本物か)を控える(製品の処理は変えない)。 */
async function observePen(page: Page) {
  return canvas(page).evaluateHandle(element => {
    const events: { type: string; pointerType: string; button: number; buttons: number; x: number; y: number; isTrusted: boolean }[] = [];
    const types = ['pointerdown', 'pointermove', 'pointerup'];
    const record = (event: Event) => {
      if (!(event instanceof PointerEvent)) return;
      events.push({ type: event.type, pointerType: event.pointerType, button: event.button, buttons: event.buttons,
        x: event.clientX, y: event.clientY, isTrusted: event.isTrusted });
    };
    for (const type of types) element.addEventListener(type, record, { capture: true, passive: true });
    return { events, stop: () => { for (const type of types) element.removeEventListener(type, record, { capture: true }); } };
  });
}
/** 何も無い所から側面のボタンで 48・24px 動かし、届いたペンの移動量を返す。 */
async function deliveredPenDrag(page: Page): Promise<{ readonly dx: number; readonly dy: number }> {
  const start = await emptyPoint(page), observation = await observePen(page);
  try {
    await penBarrelDrag(page, start, 48, 24);
    const events = await observation.evaluate(value => value.events);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => event.isTrusted && event.pointerType === 'pen')).toBe(true);
    const down = events.find(event => event.type === 'pointerdown');
    const last = events.filter(event => event.type === 'pointermove' && event.buttons === 2).at(-1);
    if (down === undefined || last === undefined) throw new Error('ペンのドラッグの出来事が届いていません。');
    expect(down).toMatchObject({ button: 2, buttons: 2 });
    return { dx: last.x - down.x, dy: last.y - down.y };
  } finally {
    await observation.evaluate(value => value.stop()); await observation.dispose();
  }
}

/**
 * 割り当てる前の側面のボタンは今までどおり右ボタン(既定の平行移動)。取り込みの枠でペンの側面のボタンを押すと、その入力を
 * 回転に足せ、適用すると同じドラッグで届いた量だけ回る(注視点は動かない)。
 */
export async function penBarrelFlow(page: Page, info: TestInfo): Promise<void> {
  await prepare(page);
  const home = await rememberCamera(page, info, 'pen-home');
  await deliveredPenDrag(page);
  const panned = await rememberCamera(page, info, 'pen-default-pan');
  expect(panned.view.target).not.toEqual(home.view.target);
  expect(cameraDistance(panned.view)).toBeCloseTo(cameraDistance(home.view), 9);

  await openInputBindings(page, 'view');
  const orbit = cameraForm(page).getByRole('group', { name: camera('orbit'), exact: true });
  await orbit.getByRole('button', { name: camera('addGuide').replace('{action}', camera('orbit')), exact: true }).click();
  const pad = cameraForm(page).getByRole('group', { name: camera('capture.pad'), exact: true });
  await pad.scrollIntoViewIfNeeded();
  const bounds = await pad.boundingBox();
  if (bounds === null) throw new Error('取り込みの枠がありません。');
  const centre = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  await penInput(page, [{ type: 'mouseMoved', at: centre, button: 'none', buttons: 0 },
    { type: 'mousePressed', at: centre, button: 'right', buttons: 2 }, { type: 'mouseReleased', at: centre, button: 'right', buttons: 0 }]);
  await expect(pad.getByRole('status')).toContainText(camera('chip.penBarrel'));
  await expect(pad.getByRole('status')).toContainText(camera('capture.free'));
  await cameraButton(page, 'capture.use').click();
  await expect(orbit.getByRole('combobox', { name: camera('binding').replace('{number}', '3'), exact: true })).toHaveValue('penBarrel');
  await cameraButton(page, 'apply').click();
  await expect(cameraButton(page, 'apply')).toBeDisabled();
  await closeInputBindings(page);

  await homeButton(page);
  const again = await rememberCamera(page, info, 'pen-home-again');
  expectSameCamera(again.view, home.view);
  await expectOrbitedFromHome(page, info, 'pen-barrel-orbit', again, await deliveredPenDrag(page));
}
