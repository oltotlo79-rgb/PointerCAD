import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { command, tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';
import { cameraDistance, expectSameCamera, observeControlsInput, rememberCamera } from './cameraControlsSettingsFlow.js';

// Independent acceptance table: cameraControlSettings.ts:34-44. Never import the
// production preset builder, validator, binding matcher, or camera math as an oracle.
// Tuple columns: input, Alt, Shift, Ctrl, Meta. The twelve action rows are explicit.
const presets = [
  { name: 'pointercad',
    orbit: [['middle', false, false, false, false], ['left', true, false, false, false]],
    pan: [['right', false, false, false, false], ['middle', false, true, false, false]],
    zoom: [['wheel', false, false, false, false], ['wheel', false, false, true, false]] },
  { name: 'solidworks',
    orbit: [['middle', false, false, false, false]],
    pan: [['middle', false, false, true, false]],
    zoom: [['wheel', false, false, false, false], ['middle', false, true, false, false]] },
  { name: 'fusion',
    orbit: [['middle', false, true, false, false]],
    pan: [['middle', false, false, false, false]],
    zoom: [['wheel', false, false, false, false]] },
  { name: 'onshape',
    orbit: [['right', false, false, false, false]],
    pan: [['middle', false, false, false, false], ['right', false, false, true, false]],
    zoom: [['wheel', false, false, false, false]] },
] as const;
export type CameraControlsPresetName = typeof presets[number]['name'];
const label = (key: string) => uiMessage('view', `settings.camera.${key}`);
const form = (page: Page) => page.getByRole('form', { name: label('title'), exact: true });
const action = (page: Page, name: 'orbit' | 'pan' | 'zoom') => form(page).getByRole('group', { name: label(name), exact: true });
const slot = (page: Page, name: 'orbit' | 'pan' | 'zoom', index: number) =>
  action(page, name).getByRole('combobox', { name: label('binding').replace('{number}', String(index + 1)), exact: true });
const button = (page: Page, name: 'apply' | 'cancel') => form(page).getByRole('button', { name: label(name), exact: true });
const preset = (page: Page, name: string) => form(page).getByRole('group', { name: label('presets'), exact: true })
  .getByRole('button', { name: label(`preset.${name}`), exact: true });
const scalar = (page: Page, name: string) => form(page).getByRole('spinbutton', { name: label(name), exact: true });
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('pointercad.settings'));

async function open(page: Page): Promise<void> {
  if (!await form(page).isVisible()) await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(form(page)).toBeVisible();
}
async function close(page: Page): Promise<void> {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
}
async function home(page: Page): Promise<void> {
  await canvas(page).focus(); await page.keyboard.press('Home');
}
async function fields(page: Page) {
  return form(page).locator('input,select').evaluateAll(elements => elements.map(element => {
    if (element instanceof HTMLInputElement) return { value: element.value, checked: element.checked };
    if (element instanceof HTMLSelectElement) return { value: element.value };
    throw new Error('Unexpected preset field');
  }));
}
function expectedSettings(item: typeof presets[number]) {
  const bindings = (rows: typeof item.orbit | typeof item.pan | typeof item.zoom) =>
    rows.map(([input, alt, shift, ctrl, meta]) => ({ input, alt, shift, ctrl, meta }));
  return { version: 1, orbit: bindings(item.orbit), pan: bindings(item.pan), zoom: bindings(item.zoom),
    wheelSensitivity: 2, dragSensitivity: 2, invertWheel: true, invertDrag: true };
}
async function expectPreset(page: Page, item: typeof presets[number]): Promise<void> {
  await expect(form(page).getByRole('combobox')).toHaveCount(6);
  for (const name of ['orbit', 'pan', 'zoom'] as const) {
    await expect(action(page, name).getByRole('combobox')).toHaveCount(2);
    for (const index of [0, 1]) {
      const binding = item[name][index];
      await expect(slot(page, name, index)).toHaveValue(binding?.[0] ?? 'none');
      for (const [column, modifier] of ['alt', 'shift', 'ctrl', 'meta'].entries()) {
        const checkbox = action(page, name).getByRole('checkbox', { name: label(modifier), exact: true }).nth(index);
        await expect(checkbox).toBeChecked({ checked: binding?.[column + 1] === true });
        if (binding === undefined) await expect(checkbox).toBeDisabled();
        else await expect(checkbox).toBeEnabled();
      }
    }
  }
  for (const name of ['wheelSensitivity', 'dragSensitivity']) await expect(scalar(page, name)).toHaveValue('2');
  for (const name of ['invertWheel', 'invertDrag']) await expect(form(page).getByRole('checkbox', { name: label(name), exact: true })).toBeChecked();
  await expect(form(page).getByRole('alert')).toHaveCount(0);
}
async function draft(page: Page, item: typeof presets[number]): Promise<void> {
  for (const name of ['wheelSensitivity', 'dragSensitivity']) await scalar(page, name).fill('2');
  for (const name of ['invertWheel', 'invertDrag']) await form(page).getByRole('checkbox', { name: label(name), exact: true }).check();
  await preset(page, item.name).click(); await expectPreset(page, item);
  await expect(button(page, 'apply')).toBeEnabled();
}
function expectDocument(actual: Awaited<ReturnType<typeof savePart>>, expected: Awaited<ReturnType<typeof savePart>>): void {
  // Named-view additions are intentional; every other document field must stay identical.
  const { namedViews: actualViews, ...actualDocument } = actual;
  const { namedViews: expectedViews, ...expectedDocument } = expected;
  expect(actualViews.length).toBeGreaterThanOrEqual(expectedViews.length);
  expect(actualViews.slice(0, expectedViews.length)).toEqual(expectedViews);
  expect(actualDocument).toEqual(expectedDocument);
}
async function reopen(page: Page, info: TestInfo, fileName: string, app?: ElectronApplication): Promise<void> {
  const path = info.outputPath(fileName);
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const generation = await beginRecompute(page);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecompute(page, generation); await expect(tree(page, '点1')).toBeVisible();
}

async function actualGesture(page: Page, info: TestInfo, item: typeof presets[number],
  name: 'orbit' | 'pan' | 'zoom', index: number, app?: ElectronApplication, stage = 'applied'): Promise<void> {
  const binding = expectedSettings(item)[name][index];
  if (binding === undefined) throw new Error('Preset gesture absent from independent table');
  await home(page);
  const before = await rememberCamera(page, info, `${item.name}-${stage}-${name}-${index}-home`, app);
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error('Camera viewport missing');
  // Layout can have fractional CSS pixels; expectations use native delivered coordinates.
  const height = await canvas(page).evaluate(element => element.clientHeight);
  await canvas(page).focus(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const observation = await observeControlsInput(page);
  const keys = [binding.alt ? 'Alt' : '', binding.shift ? 'Shift' : '', binding.ctrl ? 'Control' : '', binding.meta ? 'Meta' : ''].filter(Boolean);
  try {
    for (const key of keys) await page.keyboard.down(key);
    if (binding.input === 'wheel') {
      await page.mouse.wheel(0, 100);
      await expect.poll(() => observation.evaluate(value => value.events.filter(event => event.type === 'wheel').length)).toBe(1);
    } else {
      await page.mouse.down({ button: binding.input });
      await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2 + 24, { steps: 6 });
      await page.mouse.up({ button: binding.input });
    }
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    const events = await observation.evaluate(value => value.events);
    await info.attach(`preset-${item.name}-${stage}-${name}-${index}-native`, { body: JSON.stringify({ binding, requested: { dx: 48, dy: 24, wheel: 100 }, height, events }), contentType: 'application/json' });
    expect(events.length).toBeGreaterThan(0); expect(events.every(event => event.isTrusted)).toBe(true);
    const input = events.filter(event => event.type === (binding.input === 'wheel' ? 'wheel' : 'pointerdown'));
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ alt: binding.alt, shift: binding.shift, ctrl: binding.ctrl, meta: binding.meta });
    let dx = 0, dy = 0;
    if (binding.input === 'wheel') {
      expect(input[0]).toMatchObject({ deltaX: 0, deltaMode: 0 });
      if (input[0].deltaY === null) throw new Error('Native wheel delta missing');
      expect(input[0].deltaY).toBeGreaterThan(0); dy = input[0].deltaY;
    } else {
      const mask = binding.input === 'left' ? 1 : binding.input === 'right' ? 2 : 4;
      expect(input[0].buttons).toBe(mask);
      const last = events.filter(event => event.type === 'pointermove' && event.buttons === mask).at(-1);
      if (last?.x == null || last.y === null || input[0].x === null || input[0].y === null) throw new Error('Native drag coordinates missing');
      dx = last.x - input[0].x; dy = last.y - input[0].y;
      expect(dx).toBeGreaterThan(0); expect(dy).toBeGreaterThan(0);
    }
    const after = await rememberCamera(page, info, `${item.name}-${stage}-${name}-${index}-result`, app);
    expectDocument(after.document, before.document);
    expect(after.view.up).toEqual(before.view.up); expect(after.view.zoom).toBe(before.view.zoom);
    expect(after.view.projection).toBe(before.view.projection);
    if (name === 'orbit') {
      const azimuth = -Math.PI / 4 - dx * 0.008, elevation = Math.atan(Math.SQRT1_2) + dy * 0.008;
      const direction = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
      for (const axis of [0, 1, 2]) expect(after.view.position[axis]).toBeCloseTo(200 * direction[axis], 9);
      expect(after.view.target).toEqual(before.view.target); expect(cameraDistance(after.view)).toBeCloseTo(200, 9);
    } else if (name === 'pan') {
      const scale = 400 * Math.tan(25 * Math.PI / 180) / height;
      const target = [(-dx * Math.SQRT1_2 - dy / Math.sqrt(6)) * scale,
        (-dx * Math.SQRT1_2 + dy / Math.sqrt(6)) * scale, dy * Math.sqrt(2 / 3) * scale];
      for (const axis of [0, 1, 2]) {
        expect(after.view.target[axis]).toBeCloseTo(target[axis], 9);
        expect(after.view.position[axis] - before.view.position[axis]).toBeCloseTo(target[axis], 9);
      }
      expect(cameraDistance(after.view)).toBeCloseTo(200, 9);
    } else {
      expect(after.view.target).toEqual(before.view.target);
      const ratio = Math.pow(1.1, -2 * dy / 100);
      expect(cameraDistance(after.view) / cameraDistance(before.view)).toBeCloseTo(ratio, 9);
      for (const axis of [0, 1, 2]) expect(after.view.position[axis]).toBeCloseTo(before.view.position[axis] * ratio, 9);
    }
  } finally {
    if (binding.input !== 'wheel') await page.mouse.up({ button: binding.input });
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await observation.evaluate(value => value.stop()); await observation.dispose();
  }
}

/** One independent preset per case; preserve each adjacent transition through real UI. */
export async function cameraControlsPresetsFlow(page: Page, info: TestInfo, app?: ElectronApplication,
  presetName: CameraControlsPresetName = 'onshape') {
  const item = presets.find(candidate => candidate.name === presetName);
  if (item === undefined) throw new Error('Preset absent from independent table');
  await page.setViewportSize({ width: 1440, height: 900 });
  const empty = await savePart(page, info, 'presets-empty.pcad', app);
  let generation = await beginRecompute(page);
  await command(page, 'PO'); await command(page, '12,34'); await page.keyboard.press('Escape');
  await waitForRecompute(page, generation); await expect(tree(page, '点1')).toBeVisible();
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  const original = await savePart(page, info, 'presets-model.pcad', app);
  await open(page);
  const storageBefore = await stored(page);
  // Preserve the legacy accessible-error checks, using the current fieldset/group UI.
  await scalar(page, 'wheelSensitivity').fill('');
  const alert = form(page).getByRole('alert'); await expect(alert).toHaveText(label('error.sensitivity'));
  const alertId = await alert.getAttribute('id'); expect(alertId).not.toBeNull();
  await expect(scalar(page, 'wheelSensitivity')).toHaveAttribute('aria-invalid', 'true');
  await expect(scalar(page, 'wheelSensitivity')).toHaveAttribute('aria-describedby', alertId ?? '');
  for (const name of ['orbit', 'pan', 'zoom'] as const) for (const index of [0, 1]) await expect(slot(page, name, index)).toHaveAttribute('aria-invalid', 'false');
  await expect(button(page, 'apply')).toBeDisabled(); await button(page, 'cancel').click();
  await slot(page, 'orbit', 0).selectOption('right');
  await expect(form(page).getByRole('alert')).toHaveText(label('error.collision'));
  await expect(slot(page, 'orbit', 0)).toHaveAttribute('aria-invalid', 'true');
  await expect(scalar(page, 'wheelSensitivity')).toHaveAttribute('aria-invalid', 'false');
  expect(await stored(page)).toBe(storageBefore); await button(page, 'cancel').click();
  await close(page);
  // Recreate the original predecessor through ordinary UI, without sharing state
  // across cases or injecting settings. Cancel/close below must restore that preset.
  const previous = presets[presets.findIndex(candidate => candidate.name === presetName) - 1];
  if (previous !== undefined) {
    await open(page); await draft(page, previous); await button(page, 'apply').click();
    await expect(button(page, 'apply')).toBeDisabled(); await expectPreset(page, previous);
    const raw = await stored(page); if (raw === null) throw new Error('Predecessor preset not stored');
    const settings: unknown = JSON.parse(raw);
    if (typeof settings !== 'object' || settings === null || !('cameraControls' in settings)) throw new Error('Predecessor camera settings missing');
    expect(settings.cameraControls).toEqual(expectedSettings(previous));
    await close(page);
    expect(await savePart(page, info, `${previous.name}-transition-before.pcad`, app)).toEqual(original);
  }
  let saved = original;
  await open(page);
  const priorStorage = await stored(page), priorFields = await fields(page);
  await draft(page, item); expect(await stored(page)).toBe(priorStorage);
  await button(page, 'cancel').click(); expect(await fields(page)).toEqual(priorFields);
  await expect(button(page, 'apply')).toBeDisabled(); expect(await stored(page)).toBe(priorStorage);
  await draft(page, item); await close(page); await open(page);
  expect(await fields(page)).toEqual(priorFields); expect(await stored(page)).toBe(priorStorage);
  await expect(button(page, 'apply')).toBeDisabled();
  await draft(page, item); await button(page, 'apply').click();
  await expect(button(page, 'apply')).toBeDisabled(); await expectPreset(page, item);
  const raw = await stored(page); if (raw === null) throw new Error('Applied preset not stored');
  const configured = raw;
  const settings: unknown = JSON.parse(configured);
  expect(settings).toMatchObject({ cameraControls: expectedSettings(item) });
  if (typeof settings !== 'object' || settings === null || !('cameraControls' in settings)) throw new Error('Camera settings missing');
  expect(settings.cameraControls).toEqual(expectedSettings(item));
  await close(page);
  expect(await savePart(page, info, `${item.name}-settings-only.pcad`, app)).toEqual(saved);
  if (item.name === 'pointercad') {
    // Camera settings must not insert history entries ahead of the model edit.
    generation = await beginRecompute(page); await canvas(page).focus(); await page.keyboard.press('Control+z');
    await waitForRecompute(page, generation); expect(await savePart(page, info, 'presets-model-undone.pcad', app)).toEqual(empty);
    generation = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, generation);
    expect(await savePart(page, info, 'presets-model-redone.pcad', app)).toEqual(original);
  }
  for (const name of ['orbit', 'pan', 'zoom'] as const) await actualGesture(page, info, item, name, 0, app);
  // Keep the old Onshape Ctrl+right/middle pan coverage; include SolidWorks drag zoom.
  if (item.name === 'onshape') await actualGesture(page, info, item, 'pan', 1, app);
  if (item.name === 'solidworks') await actualGesture(page, info, item, 'zoom', 1, app);
  saved = await savePart(page, info, `preset-${item.name}-complete.pcad`, app); expectDocument(saved, original);
  await info.attach(`preset-${item.name}-settings`, { body: JSON.stringify({ expected: expectedSettings(item), stored: configured, documentId: saved.id }), contentType: 'application/json' });
  await page.reload(); await waitForStartupHealth(page, info);
  expect(await stored(page)).toBe(configured); await open(page); await expectPreset(page, item);
  await expect(button(page, 'apply')).toBeDisabled(); await close(page);
  await reopen(page, info, `preset-${item.name}-complete.pcad`, app);
  expect(await savePart(page, info, `${item.name}-reopened.pcad`, app)).toEqual(saved);
  // Verify restored bindings drive an actual camera, beyond the form/storage readback.
  await actualGesture(page, info, item, 'orbit', 0, app, 'reload');
  saved = await savePart(page, info, `preset-${item.name}-restored.pcad`, app);
  return { presetName: item.name, storage: configured, document: saved, fileName: `preset-${item.name}-restored.pcad` };
}

/** Web reload / real Electron same-TestInfo/retry userData relaunch, with real pcad reopen. */
export async function cameraControlsPresetRestoredFlow(page: Page, info: TestInfo,
  configured: Awaited<ReturnType<typeof cameraControlsPresetsFlow>>, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const item = presets.find(candidate => candidate.name === configured.presetName);
  if (item === undefined) throw new Error('Restored preset absent from independent table');
  expect(await stored(page)).toBe(configured.storage); await open(page); await expectPreset(page, item);
  await expect(button(page, 'apply')).toBeDisabled(); await close(page);
  await reopen(page, info, configured.fileName, app);
  expect(await savePart(page, info, 'preset-restart-document.pcad', app)).toEqual(configured.document);
  await actualGesture(page, info, item, item.name === 'onshape' ? 'pan' : 'orbit', item.name === 'onshape' ? 1 : 0, app, 'restart');
  if (item.name !== 'onshape') return;
  await open(page); await preset(page, 'pointercad').click(); await expectPreset(page, presets[0]);
  await button(page, 'apply').click(); await close(page);
  await home(page); const before = await rememberCamera(page, info, 'pointercad-restored-home', app);
  await actualGesture(page, info, presets[0], 'orbit', 0, app, 'defaults');
  await home(page); const after = await rememberCamera(page, info, 'pointercad-restored-final', app);
  expectSameCamera(after.view, before.view); expectDocument(after.document, configured.document);
}
