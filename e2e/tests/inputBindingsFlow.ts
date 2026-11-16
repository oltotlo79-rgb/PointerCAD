import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { command, tree } from './sheetUiFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';
import { cameraDistance, expectSameCamera, observeControlsInput, rememberCamera } from './cameraControlsSettingsFlow.js';
import { closeInputBindings, inputBindingsWindow, openInputBindings } from './inputBindingsWindowSupport.js';

/*
 * 操作の割り当ての窓の画面検査(設計 1-5、B-07)。既存の cameraControlsSettingsFlow(名前付きビューと実際の .pcad で視点を読む)と
 * shortcutSettingsFlow(表の行を選んでキーを押す)の作りをなぞる。期待の視点は製品の計算を使わず、届いた入力から独立に求める。
 */
const camera = (key: string) => uiMessage('view', `settings.camera.${key}`);
const windowText = (key: string) => uiMessage('view', `settings.inputBindings.${key}`);
const keyText = (key: string) => uiMessage('commands', `settings.shortcuts.${key}`);
const cameraForm = (page: Page) => page.getByRole('form', { name: camera('title'), exact: true });
const keyForm = (page: Page) => page.getByRole('form', { name: keyText('title'), exact: true });
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const action = (page: Page, name: 'orbit' | 'pan' | 'zoom') => cameraForm(page).getByRole('group', { name: camera(name), exact: true });
const slot = (page: Page, name: 'orbit' | 'pan' | 'zoom', index: number) =>
  action(page, name).getByRole('combobox', { name: camera('binding').replace('{number}', String(index + 1)), exact: true });
const addButton = (page: Page, name: 'orbit' | 'pan' | 'zoom') =>
  action(page, name).getByRole('button', { name: camera('addGuide').replace('{action}', camera(name)), exact: true });
const capturePad = (page: Page) => cameraForm(page).getByRole('group', { name: camera('capture.pad'), exact: true });
const cameraButton = (page: Page, key: string) => cameraForm(page).getByRole('button', { name: camera(key), exact: true });
const keyButton = (page: Page, key: string) => keyForm(page).getByRole('button', { name: keyText(key), exact: true });

async function renders(page: Page): Promise<number> {
  return page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
}
/** 視点の遷移が描画を終えて止まるまで待つ(viewcube.spec.ts と同じ見方)。 */
async function settle(page: Page, previous: number): Promise<void> {
  await expect.poll(() => page.evaluate(count => {
    const stats = window.pcadViewportRenderStats?.();
    return stats !== undefined && stats.completedRenders > count && performance.now() - stats.lastCompletedAtMs > 350;
  }, previous), { timeout: 10_000, message: '視点の遷移が描画を終えて止まる' }).toBe(true);
}
/** 描画が 400ms 止まるのを待ち、その時の描画の回数を返す(前の操作の描き直しを、次の「描かれない」の基準に含めない)。 */
async function quietRenders(page: Page): Promise<number> {
  await expect.poll(() => page.evaluate(() => {
    const stats = window.pcadViewportRenderStats?.();
    return stats !== undefined && performance.now() - stats.lastCompletedAtMs > 400;
  }), { timeout: 10_000, message: '前の操作の描画が止まる' }).toBe(true);
  return renders(page);
}
/** 何も描かれないまま 400ms が過ぎる(キーが視点を動かさなかった)。 */
async function stayStill(page: Page, previous: number): Promise<void> {
  await expect.poll(() => page.evaluate(count => {
    const stats = window.pcadViewportRenderStats?.();
    return stats !== undefined && stats.completedRenders === count && performance.now() - stats.lastCompletedAtMs > 400;
  }, previous), { timeout: 10_000, message: '視点が動かない' }).toBe(true);
}
async function homeButton(page: Page): Promise<void> {
  const before = await renders(page);
  await page.locator('.pcad-viewcube-home').click();
  await settle(page, before);
}
async function centre(page: Page): Promise<{ x: number; y: number }> {
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error('Camera viewport missing');
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
/** 2 つの点の部品を作り、選択の道具でホームの視点にする(cameraControlsSettingsFlow と同じ始まり)。 */
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
/** 中ボタンで 48・24px 動かし、届いた移動量(押下から最後の移動まで)を返す。 */
async function middleDrag(page: Page): Promise<{ dx: number; dy: number }> {
  const start = await centre(page), observation = await observeControlsInput(page);
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(start.x + 48, start.y + 24, { steps: 6 });
    await page.mouse.up({ button: 'middle' });
    const events = await observation.evaluate(value => value.events);
    const down = events.find(event => event.type === 'pointerdown');
    const last = events.filter(event => event.type === 'pointermove' && event.buttons === 4).at(-1);
    if (down?.x == null || down.y === null || last?.x == null || last.y === null) throw new Error('Native middle drag missing');
    expect(events.every(event => event.isTrusted)).toBe(true);
    return { dx: last.x - down.x, dy: last.y - down.y };
  } finally {
    await page.mouse.up({ button: 'middle' });
    await observation.evaluate(value => value.stop()); await observation.dispose();
  }
}
/** 窓は画面の中に収まり、その操作は窓の中へ送って届く(A-21: 字の幅や行の高さの違いで画面の外へ伸びない)。 */
async function expectInsideWindow(page: Page, control: Locator): Promise<void> {
  const viewport = page.viewportSize(), shown = await inputBindingsWindow(page).boundingBox();
  if (viewport === null || shown === null) throw new Error('操作の割り当ての窓がありません。');
  expect(shown.y).toBeGreaterThanOrEqual(0); expect(shown.x).toBeGreaterThanOrEqual(0);
  expect(shown.y + shown.height).toBeLessThanOrEqual(viewport.height);
  expect(shown.x + shown.width).toBeLessThanOrEqual(viewport.width);
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox();
  if (bounds === null) throw new Error('窓の中の操作がありません。');
  expect(bounds.y).toBeGreaterThanOrEqual(shown.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(shown.y + shown.height);
}
async function restoreViewDefaults(page: Page): Promise<void> {
  await openInputBindings(page, 'view');
  await cameraButton(page, 'defaults').click();
  const apply = cameraButton(page, 'apply');
  if (await apply.isEnabled()) await apply.click();
  await expect(apply).toBeDisabled();
}

/** 1: 窓を開いたまま 3D を回せ(窓は閉じない)、回転の速さ 2 で回転が 2 倍。下書きがあれば × で窓の中の確かめ。 */
export async function inputBindingsLiveFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await prepare(page);
  const before = await rememberCamera(page, info, 'bindings-home', app);
  await openInputBindings(page, 'view');
  const speed = cameraForm(page).getByRole('spinbutton', { name: camera('orbitSensitivity'), exact: true });
  await speed.fill('2'); await cameraButton(page, 'apply').click(); await expect(cameraButton(page, 'apply')).toBeDisabled();
  const { dx, dy } = await middleDrag(page);
  await expect(inputBindingsWindow(page)).toBeVisible();
  await closeInputBindings(page);
  const after = await rememberCamera(page, info, 'bindings-orbit-x2', app);
  const azimuth = -Math.PI / 4 - 2 * dx * 0.008, elevation = Math.atan(Math.SQRT1_2) + 2 * dy * 0.008;
  const expected = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
  for (const axis of [0, 1, 2]) expect(after.view.position[axis]).toBeCloseTo(200 * expected[axis], 9);
  expect(after.view.target).toEqual(before.view.target);
  // 下書きがある時の × は窓の中で確かめる。「続ける」は下書きを残し、「捨てて閉じる」は適用済みの値を残す。
  await openInputBindings(page, 'view');
  await speed.fill('3');
  await inputBindingsWindow(page).getByRole('button', { name: windowText('close'), exact: true }).click();
  const prompt = inputBindingsWindow(page).getByRole('group', { name: windowText('draft.message'), exact: true });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: windowText('draft.continue'), exact: true }).click();
  await expect(prompt).toHaveCount(0); await expect(speed).toHaveValue('3');
  await inputBindingsWindow(page).getByRole('button', { name: windowText('close'), exact: true }).click();
  await prompt.getByRole('button', { name: windowText('draft.discardClose'), exact: true }).click();
  await expect(inputBindingsWindow(page)).toHaveCount(0);
  await openInputBindings(page, 'view'); await expect(speed).toHaveValue('2');
  await restoreViewDefaults(page); await closeInputBindings(page);
}

/** 2: 取り込みの枠。左だけは断る。平行移動にホイールを足し(拡大から外す)、ホイールで注視点が動き、Ctrl＋ホイールで距離が変わる。 */
export async function inputBindingsCaptureFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await prepare(page);
  await openInputBindings(page, 'view');
  await addButton(page, 'orbit').click();
  await capturePad(page).click({ button: 'left' });
  await expect(capturePad(page).getByRole('alert')).toHaveText(camera('capture.leftNeedsAlt'));
  await cameraButton(page, 'capture.cancel').click(); await expect(capturePad(page)).toHaveCount(0);
  await addButton(page, 'pan').click();
  await capturePad(page).hover(); await page.mouse.wheel(0, 100);
  await expect(capturePad(page).getByRole('status')).toContainText(camera('chip.wheel'));
  await expect(capturePad(page).getByRole('status')).toContainText(camera('capture.used').replace('{action}', camera('zoom')));
  await cameraButton(page, 'capture.take').click();
  await expect(slot(page, 'pan', 2)).toHaveValue('wheel');
  // 札の × で外せる(下書きだけ。取消で戻し、もう一度足す)。
  await action(page, 'pan').getByRole('button', { name: camera('chipRemove').replace('{input}', camera('chip.wheel')), exact: true }).click();
  await expect(action(page, 'pan').getByRole('combobox')).toHaveCount(2);
  await cameraButton(page, 'cancel').click();
  await addButton(page, 'pan').click();
  await capturePad(page).hover(); await page.mouse.wheel(0, 100);
  await cameraButton(page, 'capture.take').click();
  await expect(slot(page, 'pan', 2)).toHaveValue('wheel');
  await expect(slot(page, 'zoom', 0)).toHaveValue('wheel');
  await expect(action(page, 'zoom').getByRole('checkbox', { name: camera('ctrl'), exact: true }).nth(0)).toBeChecked();
  await cameraButton(page, 'apply').click(); await expect(cameraButton(page, 'apply')).toBeDisabled();
  await closeInputBindings(page);
  const start = await rememberCamera(page, info, 'capture-before', app), point = await centre(page);
  await page.mouse.move(point.x, point.y);
  let previous = await renders(page);
  await page.mouse.wheel(0, 100); await settle(page, previous);
  const panned = await rememberCamera(page, info, 'capture-wheel-pan', app);
  expect(panned.view.target).not.toEqual(start.view.target);
  expect(cameraDistance(panned.view)).toBeCloseTo(cameraDistance(start.view), 9);
  await page.mouse.move(point.x, point.y);
  previous = await renders(page);
  await page.keyboard.down('Control');
  try { await page.mouse.wheel(0, 100); await settle(page, previous); } finally { await page.keyboard.up('Control'); }
  const zoomed = await rememberCamera(page, info, 'capture-ctrl-wheel-zoom', app);
  expect(zoomed.view.target).toEqual(panned.view.target);
  expect(cameraDistance(zoomed.view)).not.toBeCloseTo(cameraDistance(panned.view), 6);
  await restoreViewDefaults(page); await closeInputBindings(page);
}

/** 表の行を選ぶ。 */
async function choose(page: Page, id: string): Promise<void> {
  const row = keyForm(page).locator(`[data-command-id="${id}"]`);
  await row.scrollIntoViewIfNeeded(); await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

/** 3a: キーで探す(Ctrl＋Z は「元に戻す」の行だけ)。「正面から見る」にテンキー 5、「ホーム視点」に H を割り当てて適用する。 */
export async function assignViewKeysFlow(page: Page): Promise<void> {
  await openInputBindings(page, 'keys');
  await keyButton(page, 'keySearch').click();
  await page.keyboard.press('Control+z');
  await expect(keyForm(page).locator('[data-command-id]')).toHaveCount(1);
  await expect(keyForm(page).locator('[data-command-id="history.undo"]')).toBeVisible();
  await keyButton(page, 'keySearchClear').click();
  await expect(keyForm(page).locator('[data-command-id="history.redo"]')).toHaveCount(1);
  // ↑↓ で行を移り、Enter で新しいキーの欄へ移る(キーボードだけで割り当てを変えられる)。
  await choose(page, 'history.undo');
  await keyForm(page).locator('[data-command-id="history.undo"]').press('ArrowDown');
  await expect(keyForm(page).locator('[data-command-id="history.redo"]')).toBeFocused();
  await expect(keyForm(page).locator('[data-command-id="history.redo"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(keyForm(page).locator('[data-command-id="history.undo"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(keyForm(page).getByLabel(keyText('capture'), { exact: true })).toBeFocused();
  for (const [id, key] of [['toolbar.view.front', 'Numpad5'], ['toolbar.view.home', 'h']] as const) {
    await choose(page, id);
    await keyForm(page).getByLabel(keyText('capture'), { exact: true }).press(key);
  }
  await expect(keyForm(page).getByRole('alert')).toHaveCount(0);
  await keyButton(page, 'apply').click();
  await expect(keyForm(page).getByRole('status').filter({ hasText: keyText('applied') })).toHaveCount(1);
  await closeInputBindings(page);
}

/** 3b: テンキー 5 で正面の向きになり、Home では戻らず H でホームへ戻る。 */
export async function exerciseViewKeysFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const home = await rememberCamera(page, info, 'keys-home', app);
  await canvas(page).focus();
  let previous = await renders(page);
  await page.keyboard.press('Numpad5'); await settle(page, previous);
  const front = await rememberCamera(page, info, 'keys-front', app);
  expect(front.view.position[0]).toBeCloseTo(front.view.target[0], 6);
  expect(front.view.position[2]).toBeCloseTo(front.view.target[2], 6);
  expect(front.view.position[1]).toBeLessThan(front.view.target[1]);
  await canvas(page).focus();
  // 直前の保存(名前付きビューの欄の開け閉め・保存の後の描き直し)が描き終わってから基準を取る。Home で描かれない事だけを見る。
  previous = await quietRenders(page);
  await page.keyboard.press('Home'); await stayStill(page, previous);
  expectSameCamera((await rememberCamera(page, info, 'keys-after-home', app)).view, front.view);
  await canvas(page).focus();
  previous = await renders(page);
  await page.keyboard.press('h'); await settle(page, previous);
  expectSameCamera((await rememberCamera(page, info, 'keys-after-h', app)).view, home.view);
}

/** 3c: 割当をすべて元へ戻して適用する。 */
export async function restoreKeysFlow(page: Page): Promise<void> {
  await openInputBindings(page, 'keys');
  await keyButton(page, 'restoreAll').click();
  await keyButton(page, 'apply').click();
  await expect(keyButton(page, 'apply')).toBeDisabled();
  await closeInputBindings(page);
}

/** 3: キーのタブの一続き(Web)。 */
export async function inputBindingsKeysFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await prepare(page);
  await assignViewKeysFlow(page);
  await exerciseViewKeysFlow(page, info, app);
  await restoreKeysFlow(page);
}

/** 再起動の後: 割り当てたキーが表に残る(Electron の保存の場所)。 */
export async function assignedViewKeysRestoredFlow(page: Page): Promise<void> {
  await openInputBindings(page, 'keys');
  for (const [id, label] of [['toolbar.view.front', 'テンキー5'], ['toolbar.view.home', 'H']] as const) {
    await expect(keyForm(page).locator('tr').filter({ has: page.locator(`[data-command-id="${id}"]`) })).toContainText(label);
  }
  await closeInputBindings(page);
}

/** 4: 字の幅を広げても(Linux の Electron の字、A-21)、窓は画面に収まり、両方のタブの操作が窓の中へ送って届く。 */
export async function inputBindingsWideTextFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addStyleTag({ content: '.pcad-input-bindings { letter-spacing: 0.12em; line-height: 1.8; }' });
  await openInputBindings(page, 'keys');
  for (const key of ['apply', 'restoreAll', 'keySearch'] as const) await expectInsideWindow(page, keyButton(page, key));
  await openInputBindings(page, 'view');
  await addButton(page, 'zoom').click();
  for (const key of ['capture.cancel', 'apply', 'defaults'] as const) await expectInsideWindow(page, cameraButton(page, key));
  await cameraButton(page, 'capture.cancel').click();
  await closeInputBindings(page);
}
