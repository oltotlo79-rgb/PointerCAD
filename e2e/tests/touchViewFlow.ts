import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { command } from './sheetUiFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';
import { closeInputBindings, openInputBindings } from './inputBindingsWindowSupport.js';
import { cameraDistance, expectSameCamera, rememberCamera } from './cameraControlsSettingsFlow.js';
import { openNavigationDrawing } from './drawingNavigationFlow.js';

/*
 * タッチ画面の指で視点を動かす画面検査(設計 2-2・B-08g・B-08h)。指は Chromium の CDP の Input.dispatchTouchEvent で送る
 * (Firefox には無いので、spec は chromium と Electron だけ)。視点は今の検査と同じく、名前付きビューの保存と実際の .pcad から読む
 * (cameraControlsSettingsFlow の rememberCamera)。紙の表示は紙の面の inline の transform から読む。
 * 期待は、送った指の座標から手で求めた量(移動の画素・距離の比)で持ち、製品の計算を使わない。
 */
type Point = readonly [number, number];
const label = (key: string) => uiMessage('view', `settings.camera.${key}`);
const form = (page: Page) => page.getByRole('form', { name: label('title'), exact: true });
const slot = (page: Page, action: 'orbit' | 'pan' | 'zoom', index: number) =>
  form(page).getByRole('group', { name: label(action), exact: true })
    .getByRole('combobox', { name: label('binding').replace('{number}', String(index + 1)), exact: true });
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const pointRows = (page: Page) => page.locator('.pcad-panel--left').getByRole('button', { name: /^点\d+$/u });

/** 指の列を送る。touchStart・touchMove は触れている指を全部、touchEnd は空で送る(CDP の決まり)。 */
async function touch(page: Page, steps: readonly { readonly type: 'touchStart' | 'touchMove' | 'touchEnd'; readonly points: readonly Point[] }[]) {
  const session = await page.context().newCDPSession(page);
  try {
    for (const { type, points } of steps) {
      await session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    }
  } finally { await session.detach(); }
}
/** 2 本の指を c の左右 half に置き、両方を (dx, dy) だけ count 回に分けて動かして離す。 */
async function twoFingerDrag(page: Page, c: Point, half: number, dx: number, dy: number, count = 5): Promise<void> {
  const at = (step: number): Point[] => [[c[0] - half + dx * step / count, c[1] + dy * step / count],
    [c[0] + half + dx * step / count, c[1] + dy * step / count]];
  const start = at(0), first = start[0];
  await touch(page, [{ type: 'touchStart', points: [first] }, { type: 'touchStart', points: start },
    ...Array.from({ length: count }, (_, index) => ({ type: 'touchMove' as const, points: at(index + 1) })), { type: 'touchEnd', points: [] }]);
}
/** 2 本の指を c の左右 from に置き、左右 to まで count 回に分けて広げて(すぼめて)離す。 */
async function pinch(page: Page, c: Point, from: number, to: number, count = 5): Promise<void> {
  const at = (step: number): Point[] => {
    const half = from + (to - from) * step / count;
    return [[c[0] - half, c[1]], [c[0] + half, c[1]]];
  };
  const start = at(0), first = start[0];
  await touch(page, [{ type: 'touchStart', points: [first] }, { type: 'touchStart', points: start },
    ...Array.from({ length: count }, (_, index) => ({ type: 'touchMove' as const, points: at(index + 1) })), { type: 'touchEnd', points: [] }]);
}
/** 1 本の指を p に置き、dx だけ count 回に分けて動かして離す。 */
async function oneFingerDrag(page: Page, p: Point, dx: number, count = 5): Promise<void> {
  const at = (step: number): Point => [p[0] + dx * step / count, p[1]];
  await touch(page, [{ type: 'touchStart', points: [p] },
    ...Array.from({ length: count }, (_, index) => ({ type: 'touchMove' as const, points: [at(index + 1)] })), { type: 'touchEnd', points: [] }]);
}
async function centre(page: Page, locator = canvas(page)): Promise<Point> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('操作する画面が表示されていません。');
  return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
}
/** 雛形「タッチ画面向け」を入れる。下書きの間は 1 本指の注意を窓の中に出し、適用は止めない。 */
async function applyTouchscreenPreset(page: Page): Promise<void> {
  await openInputBindings(page, 'view');
  await form(page).getByRole('group', { name: label('presets'), exact: true })
    .getByRole('button', { name: label('preset.touchscreen'), exact: true }).click();
  await expect(form(page).getByRole('note')).toHaveText(label('touch.oneFingerNotice'));
  await form(page).getByRole('button', { name: label('apply'), exact: true }).click();
  await expect(form(page).getByRole('button', { name: label('apply'), exact: true })).toBeDisabled();
  await expect(form(page).getByRole('note')).toHaveCount(0);
  await closeInputBindings(page);
}

/** 3D: 割当なし・2 本指・つまむ・1 本指の回転と軽く触れる操作・再読み込みの後・既定に戻す。 */
export async function touchViewFlow(page: Page, info: TestInfo, reload: () => Promise<void>, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = await centre(page);
  const home = await rememberCamera(page, info, 'touch-home', app);
  // 割当なし(既定): 2 本指でも視点は変わらない。
  await twoFingerDrag(page, c, 50, 60, 0);
  expectSameCamera((await rememberCamera(page, info, 'touch-default-two', app)).view, home.view);

  // 「＋」の取り込みの枠から 2 本指を平行移動に足すと、マウスの割当(右ドラッグ・Shift＋中ドラッグ)は残る。
  await openInputBindings(page, 'view');
  const panGroup = form(page).getByRole('group', { name: label('pan'), exact: true });
  await panGroup.getByRole('button', { name: label('addGuide').replace('{action}', label('pan')), exact: true }).click();
  await form(page).getByRole('group', { name: label('capture.touch'), exact: true })
    .getByRole('button', { name: label('touch.twoFinger'), exact: true }).click();
  await form(page).getByRole('button', { name: label('capture.use'), exact: true }).click();
  await expect(slot(page, 'pan', 0)).toHaveValue('right');
  await expect(slot(page, 'pan', 1)).toHaveValue('middle');
  await expect(slot(page, 'pan', 2)).toHaveValue('twoFinger');
  await form(page).getByRole('button', { name: label('apply'), exact: true }).click();
  await closeInputBindings(page);
  await twoFingerDrag(page, c, 50, 60, 0);
  const added = await rememberCamera(page, info, 'touch-added-two', app);
  expect(added.view.target).not.toEqual(home.view.target);
  expect(cameraDistance(added.view)).toBeCloseTo(cameraDistance(home.view), 6);

  await applyTouchscreenPreset(page);
  // 2 本指＝平行移動: 注視点が動き、距離は変わらない。
  await twoFingerDrag(page, c, 50, 60, 0);
  const panned = await rememberCamera(page, info, 'touch-two-pan', app);
  expect(panned.view.target).not.toEqual(added.view.target);
  expect(cameraDistance(panned.view)).toBeCloseTo(cameraDistance(home.view), 6);
  // つまむ＝拡大縮小: 指の間を 100 → 200 画素へ広げると、距離は半分。
  await pinch(page, c, 50, 100);
  const pinched = await rememberCamera(page, info, 'touch-pinch', app);
  expect(cameraDistance(pinched.view) / cameraDistance(panned.view)).toBeCloseTo(0.5, 6);
  // 1 本指＝回転: 6 画素を超えて動かすと回り、距離は変わらない。
  await oneFingerDrag(page, [c[0] - 100, c[1] + 80], 40);
  const turned = await rememberCamera(page, info, 'touch-one-orbit', app);
  expect(turned.view.position).not.toEqual(pinched.view.position);
  expect(cameraDistance(turned.view)).toBeCloseTo(cameraDistance(pinched.view), 6);

  // 1 本指を超えずに離す(軽く触れる)と、今どおり作図になる。点の道具では、触れた所の座標が欄に入り(マウスで押した時と同じ)、
  // Enter で点が 1 つだけできる(送り直しが二重にならない)。
  await command(page, 'PO');
  const panel = page.getByRole('dialog', { name: '点を作る', exact: true });
  await expect(panel).toBeVisible();
  const fields = panel.locator('input.pcad-field__input');
  const values = () => fields.evaluateAll(list => list.map(field => field instanceof HTMLInputElement ? field.value : ''));
  const before = await values();
  await touch(page, [{ type: 'touchStart', points: [[c[0] + 120, c[1] - 60]] }, { type: 'touchEnd', points: [] }]);
  await expect.poll(values).not.toEqual(before);
  await expect(pointRows(page)).toHaveCount(0);
  const token = await beginRecompute(page);
  await fields.first().press('Enter');
  await waitForRecompute(page, token);
  await expect(pointRows(page)).toHaveCount(1);
  await panel.locator('input.pcad-field__input').first().press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(pointRows(page)).toHaveCount(1);

  // 再読み込みの後も割当が残る。
  await reload();
  await openInputBindings(page, 'view');
  await expect(slot(page, 'orbit', 2)).toHaveValue('oneFinger');
  await expect(slot(page, 'pan', 2)).toHaveValue('twoFinger');
  await expect(slot(page, 'zoom', 2)).toHaveValue('pinch');
  // 既定に戻すと、2 本指で視点が変わらない元の動きに戻る。
  await form(page).getByRole('button', { name: label('defaults'), exact: true }).click();
  await form(page).getByRole('button', { name: label('apply'), exact: true }).click();
  await closeInputBindings(page);
  const restored = await rememberCamera(page, info, 'touch-restored', app);
  await twoFingerDrag(page, await centre(page), 50, 60, 0);
  expectSameCamera((await rememberCamera(page, info, 'touch-restored-two', app)).view, restored.view);
}

/** 紙の面の表示(inline の transform の平行移動と倍率)。 */
async function sheetTransform(page: Page): Promise<{ readonly x: number; readonly y: number; readonly scale: number }> {
  return page.locator('.pcad-drawing-sheet').evaluate(element => {
    if (!(element instanceof HTMLElement)) throw new Error('HTML sheet required');
    const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/u.exec(element.style.transform);
    if (match === null) throw new Error(`Sheet transform unreadable: ${element.style.transform}`);
    return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
  });
}

/** 図面: 2 本指の平行移動とつまむが紙を動かす(紙は回さない)。 */
export async function touchDrawingFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNavigationDrawing(page, info, app);
  await applyTouchscreenPreset(page);
  const viewport = page.getByTestId('drawing-viewport');
  const c = await centre(page, viewport), before = await sheetTransform(page);
  await twoFingerDrag(page, c, 50, 60, 20);
  const moved = await sheetTransform(page);
  expect(moved.x - before.x).toBeCloseTo(60, 0);
  expect(moved.y - before.y).toBeCloseTo(20, 0);
  // 2 本の指は 1 本ずつ動くので途中で距離がわずかに変わるが、比の積は 1(倍率は戻る)。
  expect(moved.scale).toBeCloseTo(before.scale, 9);
  await pinch(page, c, 50, 100);
  const zoomed = await sheetTransform(page);
  expect(zoomed.scale / moved.scale).toBeCloseTo(2, 3);
}
