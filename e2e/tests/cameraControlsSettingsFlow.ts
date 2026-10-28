import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import type { LengthUnit } from '../../packages/model/src/index.js';
import { command, tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { pointOnScreen } from './connectPointsFlow.js';
import { uiMessage } from './uiMessages.js';

// A valid nondefault unit isolates malformed camera data from unrelated validation.
const preservedLengthUnit = 'inch' satisfies LengthUnit;

const label = (key: string) => uiMessage('view', `settings.camera.${key}`);
const form = (page: Page) => page.getByRole('form', { name: label('title'), exact: true });
const action = (page: Page, name: 'orbit' | 'pan' | 'zoom') =>
  form(page).getByRole('group', { name: label(name), exact: true });
const slot = (page: Page, name: 'orbit' | 'pan' | 'zoom', index: number) =>
  action(page, name).getByRole('combobox', { name: label('binding').replace('{number}', String(index + 1)), exact: true });
const button = (page: Page, name: 'apply' | 'cancel' | 'defaults') =>
  form(page).getByRole('button', { name: label(name), exact: true });
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const menu = (page: Page) => page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('pointercad.settings'));

async function open(page: Page): Promise<void> {
  if (!await form(page).isVisible()) await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(form(page)).toBeVisible();
}
async function close(page: Page): Promise<void> {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
}
async function centre(page: Page): Promise<{ x: number; y: number }> {
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error('Camera viewport missing');
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
async function home(page: Page): Promise<void> {
  await canvas(page).focus();
  await page.keyboard.press('Home');
}
async function drag(page: Page, keys: readonly string[]): Promise<void> {
  const start = await centre(page);
  await page.mouse.move(start.x, start.y);
  for (const key of keys) await page.keyboard.down(key);
  try {
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(start.x + 48, start.y + 24, { steps: 6 });
    await page.mouse.up({ button: 'left' });
  } finally {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
}
async function wheel(page: Page) {
  const start = await centre(page);
  await page.mouse.move(start.x, start.y);
  // Observe delivered native DOM input without changing it or installing product hooks.
  const observation = await canvas(page).evaluateHandle(element => {
    const events: { deltaX: number; deltaY: number; deltaMode: number; isTrusted: boolean;
      ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }[] = [];
    const record = (event: Event) => {
      if (!(event instanceof WheelEvent)) return;
      events.push({ deltaX: event.deltaX, deltaY: event.deltaY,
        deltaMode: event.deltaMode, isTrusted: event.isTrusted, ctrlKey: event.ctrlKey,
        altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey });
    };
    element.addEventListener('wheel', record, { capture: true, passive: true });
    return { events, stop: () => element.removeEventListener('wheel', record, { capture: true }) };
  });
  try {
    const previous = await page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
    await page.mouse.wheel(0, 100);
    await expect.poll(() => page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0))
      .toBeGreaterThan(previous);
    return await observation.evaluate(value => value.events);
  } finally {
    await observation.evaluate(value => value.stop());
    await observation.dispose();
  }
}

/** Ordinary named-view save plus the actual .pcad reader, as in rightDragPanFlow. */
async function remember(page: Page, info: TestInfo, name: string, app?: ElectronApplication) {
  const views = page.locator('.pcad-named-views');
  await views.locator('summary').click();
  await views.getByRole('textbox', { name: uiMessage('view', 'view.named.name'), exact: true }).fill(name);
  await views.getByRole('button', { name: uiMessage('view', 'view.named.save'), exact: true }).click();
  await expect(views.getByRole('option', { name, exact: true })).toHaveCount(1);
  await views.locator('summary').click();
  const document = await savePart(page, info, `${name}.pcad`, app);
  const view = document.namedViews.find(candidate => candidate.name === name);
  if (view === undefined) throw new Error(`Saved camera missing: ${name}`);
  return { view, document };
}
function sameCamera(actual: Awaited<ReturnType<typeof remember>>['view'], expected: Awaited<ReturnType<typeof remember>>['view']): void {
  expect(actual.position).toEqual(expected.position);
  expect(actual.target).toEqual(expected.target);
  expect(actual.up).toEqual(expected.up);
  expect(actual.zoom).toBe(expected.zoom);
  expect(actual.projection).toBe(expected.projection);
}
function cameraDistance(view: Awaited<ReturnType<typeof remember>>['view']): number {
  return Math.hypot(...view.position.map((value, axis) => value - view.target[axis]));
}

// The native host may scale the injected wheel (Electron delivered 200 for a
// request of 100). Derive the expectation from independently recorded DOM input;
// never from the camera result or the production settings/normalizer.
function deliveredWheelNotches(events: Awaited<ReturnType<typeof wheel>>): number {
  expect(events).toHaveLength(1);
  const event = events[0];
  expect(event).toMatchObject({ deltaX: 0, deltaMode: 0, isTrusted: true,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  expect(Number.isFinite(event.deltaY)).toBe(true);
  expect(event.deltaY).toBeGreaterThan(0);
  return event.deltaY / 100;
}

async function expectCustomForm(page: Page): Promise<void> {
  await expect(slot(page, 'pan', 0)).toHaveValue('right');
  await expect(slot(page, 'pan', 1)).toHaveValue('left');
  await expect(action(page, 'pan').getByRole('checkbox', { name: label('alt'), exact: true }).nth(1)).toBeChecked();
  await expect(action(page, 'pan').getByRole('checkbox', { name: label('shift'), exact: true }).nth(1)).toBeChecked();
  await expect(slot(page, 'zoom', 1)).toHaveValue('none');
  await expect(form(page).getByRole('spinbutton', { name: label('wheelSensitivity'), exact: true })).toHaveValue('2');
  await expect(form(page).getByRole('checkbox', { name: label('invertWheel'), exact: true })).toBeChecked();
}

export async function cameraControlsSettingsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<string> {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const value of ['0,0', '30,0']) {
    const generation = await beginRecompute(page);
    await command(page, 'PO'); await command(page, value); await page.keyboard.press('Escape');
    await waitForRecompute(page, generation);
  }
  await expect(tree(page, '点2')).toBeVisible();
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  await home(page);
  const initial = await remember(page, info, 'controls-original', app);
  let original = initial.document;
  const storageBefore = await stored(page);
  await open(page);
  await expect(form(page).getByRole('combobox')).toHaveCount(6);
  for (const name of ['orbit', 'pan', 'zoom'] as const) {
    await expect(action(page, name).getByRole('combobox')).toHaveCount(2);
  }
  await expect(button(page, 'apply')).toBeDisabled();
  const appliedBeforeDraft = {
    storage: storageBefore,
    controls: await form(page).locator('input,select').evaluateAll(elements => elements.map(element => {
      if (element instanceof HTMLInputElement) return { id: element.id, value: element.value, checked: element.checked };
      if (element instanceof HTMLSelectElement) return { id: element.id, value: element.value };
      throw new Error('Unexpected camera settings control');
    })),
  };

  // A draft neither writes storage nor alters the currently applied settings.
  await form(page).getByRole('spinbutton', { name: label('wheelSensitivity'), exact: true }).fill('2');
  expect(await stored(page)).toBe(storageBefore);
  const deliveredWheelEvents = await wheel(page);
  const storageAfterWheel = await stored(page);
  await button(page, 'cancel').click();
  await expect(form(page).getByRole('spinbutton', { name: label('wheelSensitivity'), exact: true })).toHaveValue('1');
  await expect(button(page, 'apply')).toBeDisabled();
  expect(await stored(page)).toBe(storageBefore);
  await close(page);
  const staged = await remember(page, info, 'controls-staged-wheel', app);
  const diagnostic = { requestedWheel: { deltaX: 0, deltaY: 100 }, deliveredWheelEvents,
    deliveredWheelCount: deliveredWheelEvents.length, appliedBeforeDraft,
    unappliedDraftWheelSensitivity: 2, storageAfterWheel, storageAfterCancel: await stored(page),
    beforeSavedCamera: initial.view, afterSavedCamera: staged.view,
    beforeDistance: cameraDistance(initial.view), afterDistance: cameraDistance(staged.view) };
  await info.attach('controls-staged-wheel-diagnostic', {
    body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json',
  });
  // Home distance is 200; the staged 2x sensitivity must not be applied.
  const stagedNotches = deliveredWheelNotches(deliveredWheelEvents);
  expect(cameraDistance(initial.view)).toBeCloseTo(200, 9);
  expect(cameraDistance(staged.view), JSON.stringify(diagnostic)).toBeCloseTo(200 * Math.pow(1.1, stagedNotches), 9);
  expect(cameraDistance(staged.view)).not.toBeCloseTo(200 * Math.pow(1.1, stagedNotches * 2), 9);
  expect(staged.document.sketches).toEqual(original.sketches);
  expect(staged.document.solids).toEqual(original.solids);
  original = staged.document;
  await home(page);
  await open(page);

  await slot(page, 'orbit', 0).selectOption('right');
  await expect(form(page).getByRole('alert')).toHaveText(label('error.collision'));
  await expect(button(page, 'apply')).toBeDisabled();
  expect(await stored(page)).toBe(storageBefore);
  await button(page, 'cancel').click();
  await expect(form(page).getByRole('alert')).toHaveCount(0);
  await expect(slot(page, 'orbit', 0)).toHaveValue('middle');

  // Replace an explicit pan slot, keep right-click ownership, and use one zoom slot.
  await slot(page, 'pan', 1).selectOption('left');
  await action(page, 'pan').getByRole('checkbox', { name: label('alt'), exact: true }).nth(1).check();
  await slot(page, 'zoom', 1).selectOption('none');
  await form(page).getByRole('spinbutton', { name: label('wheelSensitivity'), exact: true }).fill('2');
  await form(page).getByRole('checkbox', { name: label('invertWheel'), exact: true }).check();
  await expect(button(page, 'apply')).toBeEnabled();
  expect(await stored(page)).toBe(storageBefore);
  await button(page, 'apply').click();
  await expect(button(page, 'apply')).toBeDisabled();
  await expectCustomForm(page);
  const configured = await stored(page);
  expect(configured).not.toBeNull(); expect(configured).not.toBe(storageBefore);
  if (configured === null) throw new Error('Applied controls were not persisted');
  await button(page, 'defaults').click();
  await expect(slot(page, 'pan', 1)).toHaveValue('middle');
  await expect(slot(page, 'zoom', 1)).toHaveValue('wheel');
  expect(await stored(page)).toBe(configured);
  await button(page, 'cancel').click();
  await expectCustomForm(page);
  await close(page);
  expect(await savePart(page, info, 'controls-configured.pcad', app)).toEqual(original);

  await home(page);
  const before = await remember(page, info, 'controls-home', app);
  // Unassigned extra Ctrl must not turn Alt+Shift+left into a camera gesture.
  await drag(page, ['Alt', 'Shift', 'Control']);
  const ignored = await remember(page, info, 'controls-extra-modifier', app);
  sameCamera(ignored.view, before.view);
  await drag(page, ['Alt', 'Shift']);
  const panned = await remember(page, info, 'controls-custom-pan', app);
  expect(panned.view.target).not.toEqual(before.view.target);
  expect(panned.view.up).toEqual(before.view.up);
  expect(panned.view.zoom).toBe(before.view.zoom);
  await home(page);
  const invertedNotches = deliveredWheelNotches(await wheel(page));
  const zoomed = await remember(page, info, 'controls-inverted-wheel', app);
  expect(cameraDistance(zoomed.view) / cameraDistance(before.view)).toBeCloseTo(Math.pow(1.1, -2 * invertedNotches), 9);
  expect(zoomed.view.target).toEqual(before.view.target);

  await home(page);
  const a = await pointOnScreen(page, [0, 0, 0]), b = await pointOnScreen(page, [30, 0, 0]);
  await page.mouse.click(...a);
  await expect(tree(page, '点1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('Shift');
  try { await page.mouse.click(...b); } finally { await page.keyboard.up('Shift'); }
  await expect(tree(page, '点1')).toHaveAttribute('aria-pressed', 'true');
  await expect(tree(page, '点2')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('Control');
  try { await page.mouse.click(...a); } finally { await page.keyboard.up('Control'); }
  await expect(tree(page, '点1')).toHaveAttribute('aria-pressed', 'false');
  await expect(tree(page, '点2')).toHaveAttribute('aria-pressed', 'true');
  await canvas(page).focus(); await page.keyboard.press('Escape');
  const location = await centre(page);
  await page.mouse.click(location.x, location.y, { button: 'right' });
  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole('button', { name: uiMessage('commands', 'radial.cancel'), exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  const after = await remember(page, info, 'controls-selection-menu', app);
  sameCamera(after.view, before.view);
  expect(after.document.sketches).toEqual(original.sketches);
  expect(after.document.solids).toEqual(original.solids);
  expect(await stored(page)).toBe(configured);
  return configured;
}

/** Called after Web reload or a real same-profile Desktop close/relaunch. */
export async function cameraControlsRestoredFlow(page: Page, info: TestInfo, configured: string, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await stored(page)).toBe(configured);
  await open(page); await expectCustomForm(page); await expect(button(page, 'apply')).toBeDisabled();
  await close(page);
  await home(page);
  const before = await remember(page, info, 'restored-home', app);
  await drag(page, ['Alt', 'Shift']);
  const moved = await remember(page, info, 'restored-custom-pan', app);
  expect(moved.view.target).not.toEqual(before.view.target);
  await open(page); await button(page, 'defaults').click();
  expect(await stored(page)).toBe(configured);
  await button(page, 'apply').click();
  await expect(button(page, 'apply')).toBeDisabled();
  expect(await stored(page)).not.toBe(configured);
  await expect(slot(page, 'pan', 1)).toHaveValue('middle');
  await expect(slot(page, 'zoom', 1)).toHaveValue('wheel');
  await close(page);
  await home(page);
  const defaults = await remember(page, info, 'defaults-home', app);
  await drag(page, ['Alt', 'Shift']);
  const retired = await remember(page, info, 'defaults-retired-pan', app);
  sameCamera(retired.view, defaults.view);
  const defaultNotches = deliveredWheelNotches(await wheel(page));
  const zoomed = await remember(page, info, 'defaults-wheel', app);
  expect(cameraDistance(zoomed.view) / cameraDistance(defaults.view)).toBeCloseTo(Math.pow(1.1, defaultNotches), 9);
  await customOrbitAndZoom(page, info, app);
  await heldModifierRelease(page, info, app);
}

/** Passive evidence only: ordinary Playwright input is still handled by the product. */
export async function observeControlsInput(page: Page) {
  return canvas(page).evaluateHandle(element => {
    const events: { type: string; isTrusted: boolean; key: string | null; x: number | null; y: number | null;
      button: number | null; buttons: number | null; deltaX: number | null; deltaY: number | null; deltaMode: number | null;
      alt: boolean; shift: boolean; ctrl: boolean; meta: boolean }[] = [];
    const types = ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'keyup', 'wheel'];
    const record = (event: Event) => {
      if (!(event instanceof MouseEvent) && !(event instanceof KeyboardEvent)) return;
      events.push({ type: event.type, isTrusted: event.isTrusted,
        key: event instanceof KeyboardEvent ? event.key : null,
        x: event instanceof MouseEvent ? event.clientX : null, y: event instanceof MouseEvent ? event.clientY : null,
        button: event instanceof MouseEvent ? event.button : null, buttons: event instanceof MouseEvent ? event.buttons : null,
        deltaX: event instanceof WheelEvent ? event.deltaX : null, deltaY: event instanceof WheelEvent ? event.deltaY : null,
        deltaMode: event instanceof WheelEvent ? event.deltaMode : null,
        alt: event.altKey, shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey });
    };
    for (const type of types) element.addEventListener(type, record, { capture: true, passive: true });
    return { events, stop: () => {
      for (const type of types) element.removeEventListener(type, record, { capture: true });
    } };
  });
}

async function heldModifierRelease(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await home(page);
  const before = await remember(page, info, 'held-alt-home', app);
  const start = await centre(page);
  await canvas(page).focus(); await page.mouse.move(start.x, start.y);
  const observation = await observeControlsInput(page);
  try {
    await page.keyboard.down('Alt'); await page.mouse.down({ button: 'left' });
    await page.mouse.move(start.x + 24, start.y + 12, { steps: 3 });
    await page.keyboard.up('Alt');
    await page.mouse.move(start.x + 48, start.y + 24, { steps: 3 });
    // An otherwise assigned wheel must not zoom while the pointer owns orbit.
    await page.mouse.wheel(0, 100);
    await expect.poll(() => observation.evaluate(value => value.events.filter(event => event.type === 'wheel').length)).toBe(1);
    await page.mouse.up({ button: 'left' });
    const events = await observation.evaluate(value => value.events);
    await info.attach('controls-held-alt-release-native', { body: JSON.stringify({ requested: { dx: 48, dy: 24, wheel: 100 }, events }), contentType: 'application/json' });
    expect(events.length).toBeGreaterThan(0); expect(events.every(event => event.isTrusted)).toBe(true);
    const downs = events.filter(event => event.type === 'pointerdown');
    expect(downs).toHaveLength(1); expect(downs[0]).toMatchObject({ buttons: 1, alt: true, ctrl: false, shift: false, meta: false });
    const released = events.findIndex(event => event.type === 'keyup' && event.key === 'Alt');
    expect(released).toBeGreaterThan(0); expect(events[released].alt).toBe(false);
    const moves = events.slice(released + 1).filter(event => event.type === 'pointermove' && event.buttons === 1);
    expect(moves.length).toBeGreaterThan(0); expect(moves.every(event => !event.alt)).toBe(true);
    const wheels = events.filter(event => event.type === 'wheel');
    expect(wheels).toHaveLength(1); expect(wheels[0].deltaY).toBeGreaterThan(0);
    const first = downs[0], last = moves.at(-1);
    const held = events.slice(0, released).filter(event => event.type === 'pointermove' && event.buttons === 1).at(-1);
    if (first.x === null || first.y === null || last?.x == null || last.y === null || held?.x == null || held.y === null) throw new Error('Native held-drag coordinates missing');
    const dx = last.x - first.x, dy = last.y - first.y;
    expect(last.x).toBeGreaterThan(held.x); expect(last.y).toBeGreaterThan(held.y);
    const after = await remember(page, info, 'held-alt-released-orbit', app);
    const azimuth = -Math.PI / 4 - dx * 0.008, elevation = Math.atan(Math.SQRT1_2) + dy * 0.008;
    const expected = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
    for (const axis of [0, 1, 2]) expect(after.view.position[axis]).toBeCloseTo(200 * expected[axis], 9);
    expect(cameraDistance(after.view)).toBeCloseTo(200, 9);
    expect(after.view.target).toEqual(before.view.target); expect(after.view.up).toEqual(before.view.up);
    expect(after.view.zoom).toBe(before.view.zoom); expect(after.view.projection).toBe(before.view.projection);
    expect(after.document.sketches).toEqual(before.document.sketches); expect(after.document.solids).toEqual(before.document.solids);
  } finally {
    await page.mouse.up({ button: 'left' }); await page.keyboard.up('Alt');
    await observation.evaluate(value => value.stop()); await observation.dispose();
  }
}

// Reuse the established named-view/real-pcad oracle in the two controls-only flows.
export { remember as rememberCamera, sameCamera as expectSameCamera, cameraDistance };

/** Record the actual trusted pointer stream, rather than assume host movement scaling. */
async function observedDrag(page: Page, keys: readonly string[], input: 'left' | 'middle', cancelWithExtraButton = false) {
  const start = await centre(page);
  await page.mouse.move(start.x, start.y);
  const observation = await canvas(page).evaluateHandle(element => {
    const events: { type: string; x: number; y: number; trusted: boolean; buttons: number;
      alt: boolean; shift: boolean; ctrl: boolean; meta: boolean }[] = [];
    const record = (event: Event) => {
      if (!(event instanceof PointerEvent)) return;
      events.push({ type: event.type, x: event.clientX, y: event.clientY,
        trusted: event.isTrusted, buttons: event.buttons, alt: event.altKey,
        shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey });
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) element.addEventListener(type, record, true);
    return { events, stop: () => {
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) element.removeEventListener(type, record, true);
    } };
  });
  for (const key of keys) await page.keyboard.down(key);
  try {
    await page.mouse.down({ button: input });
    await page.mouse.move(start.x + (cancelWithExtraButton ? 24 : 48), start.y + (cancelWithExtraButton ? 12 : 24), { steps: 6 });
    if (cancelWithExtraButton) {
      await page.mouse.down({ button: 'left' });
      await page.mouse.move(start.x + 48, start.y + 24, { steps: 3 });
      await page.mouse.up({ button: 'left' });
      await page.mouse.move(start.x + 72, start.y + 36, { steps: 3 });
    }
    await page.mouse.up({ button: input });
    const events = await observation.evaluate(value => value.events);
    const down = events.filter(event => event.type === 'pointerdown');
    const moves = events.filter(event => event.type === 'pointermove' && event.buttons !== 0);
    // Pointer Events emits pointerdown only for the transition from no buttons.
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ buttons: input === 'left' ? 1 : 4,
      alt: keys.includes('Alt'), shift: keys.includes('Shift'),
      ctrl: keys.includes('Control'), meta: keys.includes('Meta') });
    expect(moves.length).toBeGreaterThan(0);
    expect(events.every(event => event.trusted)).toBe(true);
    const cancelledAt = moves.findIndex(event => event.buttons === 5);
    if (cancelWithExtraButton) expect(cancelledAt).toBeGreaterThan(0);
    const last = moves[cancelWithExtraButton ? cancelledAt - 1 : moves.length - 1];
    expect(last.x - down[0].x).toBeGreaterThan(0);
    expect(last.y - down[0].y).toBeGreaterThan(0);
    return { dx: last.x - down[0].x, dy: last.y - down[0].y, events };
  } finally {
    if (cancelWithExtraButton) await page.mouse.up({ button: 'left' });
    await page.mouse.up({ button: input });
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await observation.evaluate(value => value.stop());
    await observation.dispose();
  }
}

async function setBinding(page: Page, name: 'orbit' | 'zoom', index: number,
  input: 'left' | 'middle', modifiers: readonly ('alt' | 'shift' | 'ctrl' | 'meta')[]): Promise<void> {
  await slot(page, name, index).selectOption(input);
  for (const modifier of ['alt', 'shift', 'ctrl', 'meta'] as const) {
    await action(page, name).getByRole('checkbox', { name: label(modifier), exact: true })
      .nth(index).setChecked(modifiers.includes(modifier));
  }
}

/** Four configured drag alternatives, with independent saved-camera geometry expectations. */
async function customOrbitAndZoom(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await open(page);
  await setBinding(page, 'orbit', 0, 'middle', ['ctrl']);
  await setBinding(page, 'orbit', 1, 'left', ['alt', 'ctrl']);
  await setBinding(page, 'zoom', 0, 'middle', ['alt', 'shift']);
  await setBinding(page, 'zoom', 1, 'left', ['alt', 'shift', 'ctrl']);
  await form(page).getByRole('spinbutton', { name: label('dragSensitivity'), exact: true }).fill('2');
  await form(page).getByRole('checkbox', { name: label('invertDrag'), exact: true }).check();
  await expect(form(page).getByRole('alert')).toHaveCount(0);
  await expect(button(page, 'apply')).toBeEnabled();
  await button(page, 'apply').click();
  await expect(button(page, 'apply')).toBeDisabled();
  await close(page);
  const cases = [
    { name: 'orbit-middle', action: 'orbit', input: 'middle', keys: ['Control'], rejected: ['Control', 'Shift'] },
    { name: 'orbit-left', action: 'orbit', input: 'left', keys: ['Alt', 'Control'], rejected: ['Control'] },
    { name: 'zoom-middle', action: 'zoom', input: 'middle', keys: ['Alt', 'Shift'], rejected: ['Alt', 'Shift', 'Control'] },
    { name: 'zoom-left', action: 'zoom', input: 'left', keys: ['Alt', 'Shift', 'Control'], rejected: ['Shift', 'Control'] },
    { name: 'orbit-cancel-buttons', action: 'orbit', input: 'middle', keys: ['Control'], rejected: ['Control', 'Shift'] },
  ] as const;
  for (const item of cases) {
    await home(page);
    const before = await remember(page, info, `${item.name}-home`, app);
    const rejected = await observedDrag(page, item.rejected, item.input);
    await info.attach(`controls-${item.name}-rejected-native`, { body: JSON.stringify(rejected), contentType: 'application/json' });
    const ignored = await remember(page, info, `${item.name}-rejected`, app);
    sameCamera(ignored.view, before.view);
    // Adding a second physical button cancels ownership. Later middle-only
    // movement must remain ignored until another pointerdown begins a gesture.
    const delivered = await observedDrag(page, item.keys, item.input, item.name === 'orbit-cancel-buttons');
    const after = await remember(page, info, `${item.name}-applied`, app);
    expect(after.view.target).toEqual(before.view.target);
    expect(after.view.up).toEqual(before.view.up);
    expect(after.view.zoom).toBe(before.view.zoom);
    expect(after.view.projection).toBe(before.view.projection);
    if (item.action === 'orbit') {
      const azimuth = Math.atan2(before.view.position[1] - before.view.target[1], before.view.position[0] - before.view.target[0]) - delivered.dx * 0.008;
      const elevation = Math.asin((before.view.position[2] - before.view.target[2]) / cameraDistance(before.view)) + delivered.dy * 0.008;
      const expected = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
      for (const axis of [0, 1, 2]) {
        expect(after.view.position[axis]).toBeCloseTo(before.view.target[axis] + cameraDistance(before.view) * expected[axis], 9);
      }
      expect(cameraDistance(after.view)).toBeCloseTo(cameraDistance(before.view), 9);
    } else {
      const ratio = Math.pow(1.1, -2 * delivered.dy / 100);
      expect(cameraDistance(after.view) / cameraDistance(before.view)).toBeCloseTo(ratio, 9);
      for (const axis of [0, 1, 2]) {
        expect(after.view.position[axis] - after.view.target[axis]).toBeCloseTo((before.view.position[axis] - before.view.target[axis]) * ratio, 9);
      }
    }
    expect(after.document.sketches).toEqual(before.document.sketches);
    expect(after.document.solids).toEqual(before.document.solids);
    await info.attach(`controls-${item.name}-trusted-input`, { body: JSON.stringify(delivered), contentType: 'application/json' });
  }
  await open(page); await button(page, 'defaults').click(); await button(page, 'apply').click(); await close(page);
}

/** Fault fixture changes stored input only; actual host startup must perform recovery. */
export async function prepareMalformedCameraSettings(page: Page): Promise<string> {
  return page.evaluate<string, LengthUnit>((lengthUnit: LengthUnit) => {
    const raw = localStorage.getItem('pointercad.settings');
    if (raw === null) throw new Error('Camera settings record missing before corruption fixture');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Settings record is not an object');
    const malformed = JSON.stringify({ ...parsed,
      theme: 'lightModern', uiScale: 125, lengthUnit, trackAngleStep: 30,
      cameraControls: { version: 1, orbit: [] } });
    localStorage.setItem('pointercad.settings', malformed);
    return malformed;
  }, preservedLengthUnit);
}

export async function malformedCameraSettingsRestored(page: Page, info: TestInfo, malformed: string, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  for (const [name, inputs] of [['orbit', ['middle', 'left']], ['pan', ['right', 'middle']], ['zoom', ['wheel', 'wheel']]] as const) {
    for (const index of [0, 1]) {
      await expect(slot(page, name, index)).toHaveValue(inputs[index]);
      for (const modifier of ['alt', 'shift', 'ctrl', 'meta'] as const) {
        const checked = index === 1 && ((name === 'orbit' && modifier === 'alt')
          || (name === 'pan' && modifier === 'shift') || (name === 'zoom' && modifier === 'ctrl'));
        await expect(action(page, name).getByRole('checkbox', { name: label(modifier), exact: true }).nth(index))
          .toBeChecked({ checked });
      }
    }
  }
  await expect(form(page).getByRole('spinbutton', { name: label('dragSensitivity'), exact: true })).toHaveValue('1');
  await expect(form(page).getByRole('spinbutton', { name: label('wheelSensitivity'), exact: true })).toHaveValue('1');
  await expect(form(page).getByRole('checkbox', { name: label('invertDrag'), exact: true })).not.toBeChecked();
  await expect(form(page).getByRole('checkbox', { name: label('invertWheel'), exact: true })).not.toBeChecked();
  await expect(button(page, 'apply')).toBeDisabled();
  await expect(page.getByRole('radio', { name: uiMessage('view', 'settings.theme.lightModern'), exact: true })).toHaveAttribute('aria-checked', 'true');
  // Applying a valid camera draft must preserve the other preferences read at startup.
  await form(page).getByRole('spinbutton', { name: label('dragSensitivity'), exact: true }).fill('2');
  await button(page, 'apply').click();
  const raw = await stored(page);
  expect(raw).not.toBeNull();
  const saved: unknown = JSON.parse(raw ?? 'null');
  expect(saved).toMatchObject({ theme: 'lightModern', uiScale: 125, lengthUnit: preservedLengthUnit, trackAngleStep: 30 });
  const unrelated = (serialized: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Settings record is not an object');
    const fields: Record<string, unknown> = { ...value };
    delete fields.cameraControls;
    return fields;
  };
  expect(unrelated(raw ?? 'null')).toEqual(unrelated(malformed));
  await close(page); await home(page);
  const before = await remember(page, info, 'corrupt-default-home', app);
  const delivered = await observedDrag(page, ['Alt'], 'left');
  const after = await remember(page, info, 'corrupt-default-orbit', app);
  expect(delivered.events.length).toBeGreaterThan(0);
  expect(after.view.position).not.toEqual(before.view.position);
  expect(after.view.target).toEqual(before.view.target);
  expect(cameraDistance(after.view)).toBeCloseTo(cameraDistance(before.view), 9);
  await home(page);
  const homeView = await remember(page, info, 'corrupt-default-wheel-home', app);
  const notches = deliveredWheelNotches(await wheel(page));
  const zoomed = await remember(page, info, 'corrupt-default-wheel', app);
  expect(cameraDistance(zoomed.view) / cameraDistance(homeView.view)).toBeCloseTo(Math.pow(1.1, notches), 9);
}
