import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { openTarget } from './electronAppFlow.js';
import { functionPlotMessage as text } from './functionMessages.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';
import { reportDuration } from '../../packages/test-utils/src/releasePerformance.js';

interface Traffic {
  event: 'math-request' | 'math-reply' | 'cad-request' | 'cad-reply' | 'terminate' | 'stop-click';
  at: number;
  serial?: number;
  kind?: string;
  vertices?: number;
  wire?: 'legacy-array' | 'packed-v1' | 'invalid-packed';
  vertexBufferBytes?: number;
  spline?: boolean;
  status?: unknown;
  reason?: unknown;
  stats?: unknown;
  trusted?: boolean;
  bodies?: { id: unknown; kind: unknown; faces: unknown[]; minimum: number[]; maximum: number[] }[];
}
declare global { interface Window { pcadSplineSurfaceTraffic?: Traffic[]; pcadSurfaceFrames?: { active: boolean; gaps: number[]; previous?: number; first?: number; handle: number; samples: number[] } } }

/** Read the real envelopes and native body metadata; forward every original argument unchanged. */
function installTraffic(): void {
  if (window.pcadSplineSurfaceTraffic !== undefined) return;
  const records: Traffic[] = []; window.pcadSplineSurfaceTraffic = records;
  const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' ? v as Record<string, unknown> : undefined;
  const record = (v: Traffic): void => { records.push(v); if (records.length > 256) records.shift(); };
  const original = Worker.prototype.postMessage, terminate = Worker.prototype.terminate;
  const listened = new WeakSet<Worker>();
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
    if (!listened.has(this)) {
      listened.add(this);
      this.addEventListener('message', event => {
        const reply = object(event.data), result = object(reply?.result), value = object(reply?.value);
        if (typeof reply?.kind === 'string' && reply.kind.includes('function-')) {
          let vertices: number | undefined, wire: Traffic['wire'], vertexBufferBytes: number | undefined;
          if (result !== undefined && 'wireVersion' in result) {
            wire = 'invalid-packed';
            if (result.wireVersion === 1 && result.vertices instanceof ArrayBuffer) {
              vertexBufferBytes = result.vertices.byteLength;
              // Independent wire observation: two parameters + XYZ, each an eight-byte double.
              // An incomplete row or detached/empty buffer must never create a successful vertex count.
              if (vertexBufferBytes >= 3 * 40 && vertexBufferBytes % 40 === 0) {
                vertices = vertexBufferBytes / 40; wire = 'packed-v1';
              }
            }
          } else if (Array.isArray(result?.vertices)) { vertices = result.vertices.length; wire = 'legacy-array'; }
          record({ event: 'math-reply', at: performance.now(), kind: reply.kind,
            serial: typeof reply.serial === 'number' ? reply.serial : undefined,
            status: result?.status, reason: result?.reason, stats: result?.stats,
            vertices, wire, vertexBufferBytes, spline: object(result?.spline) !== undefined });
        }
        if (Array.isArray(value?.bodies)) {
          record({ event: 'cad-reply', at: performance.now(), bodies: value.bodies.map(body => {
            const b = object(body), positions = b?.positions;
            const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
            if (positions instanceof Float32Array) for (let i = 0; i < positions.length; i++) {
              minimum[i % 3] = Math.min(minimum[i % 3], positions[i]); maximum[i % 3] = Math.max(maximum[i % 3], positions[i]);
            }
            return { id: b?.id, kind: b?.bodyKind, minimum, maximum,
              faces: Array.isArray(b?.faces) ? b.faces.map(face => object(face)?.surfaceKind) : [] };
          }) });
        }
      }, { capture: true });
    }
    const message = object(args[0]);
    if (typeof message?.kind === 'string' && message.kind.includes('function-')) record({ event: 'math-request', at: performance.now(), kind: message.kind,
      serial: typeof message.serial === 'number' ? message.serial : undefined });
    if (message?.type === 'APPLY' && Array.isArray(message.path) && message.path.includes('recomputeSolids')) {
      record({ event: 'cad-request', at: performance.now() });
    }
    Reflect.apply(original, this, args);
  };
  Worker.prototype.terminate = function (this: Worker): void {
    record({ event: 'terminate', at: performance.now() }); Reflect.apply(terminate, this, []);
  };
}

async function start(page: Page): Promise<void> {
  await waitForRecompute(page);
  await page.addInitScript(installTraffic); await page.evaluate(installTraffic);
}
async function records(page: Page): Promise<Traffic[]> { return page.evaluate(() => window.pcadSplineSurfaceTraffic ?? []); }
async function attach(page: Page, info: TestInfo): Promise<void> {
  await info.attach('spline-surface-real-traffic', { body: JSON.stringify(await records(page), null, 2), contentType: 'application/json' });
}
// Observation only: frame cadence is not the existing dimension-input latency metric.
function collectSurfaceFrames(): Promise<void> {
  return new Promise<void>(resolve => {
    const state: NonNullable<Window['pcadSurfaceFrames']> = { active: true, gaps: [], samples: [], handle: 0 };
    window.pcadSurfaceFrames = state;
    const tick = (at: number): void => {
      if (!state.active) return;
      if (state.previous !== undefined) state.gaps.push(at - state.previous);
      else state.first = at;
      state.previous = at; state.samples.push(at);
      if (state.gaps.length > 2000) state.gaps.shift();
      if (state.samples.length > 2001) state.samples.shift();
      resolve(); state.handle = requestAnimationFrame(tick);
    };
    state.handle = requestAnimationFrame(tick);
  });
}
function finishSurfaceFrames(): Promise<{ gaps: number[]; samples: number[]; first?: number; final: number }> {
  return new Promise((resolve, reject) => requestAnimationFrame(at => {
    const state = window.pcadSurfaceFrames;
    if (state === undefined || state.previous === undefined) { reject(new Error('Frame observer not started')); return; }
    state.active = false; cancelAnimationFrame(state.handle);
    resolve({ gaps: [...state.gaps, at - state.previous], samples: [...state.samples, at], first: state.first, final: at });
  }));
}
async function beginFrames(page: Page): Promise<void> { await page.evaluate(collectSurfaceFrames); }
async function endFrames(page: Page, info: TestInfo): Promise<void> {
  const observation = await page.evaluate(finishSurfaceFrames);
  const gaps = observation.gaps;
  const replyWire = (await records(page)).filter(row => row.event === 'math-reply' && row.kind === 'function-surface-result')
    .map(({ at, serial, wire, vertexBufferBytes, vertices }) => ({ at, serial, wire, vertexBufferBytes, vertices }));
  await info.attach('large-reply-frame-observation', { body: JSON.stringify({
    observationOnly: true, inputLatencyNotMeasured: true, replyWire, senderDetachmentObserved: false,
    ...observation, gapsMs: gaps, maximumGapMs: Math.max(...gaps),
  }, null, 2), contentType: 'application/json' });
  expect(gaps.length).toBeGreaterThan(0);
  expect(gaps.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
}
async function openPlot(page: Page, surface: boolean): Promise<Locator> {
  await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.shape.groupLabel'), text('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: text('geometry'), exact: true }).selectOption(surface ? 'surface' : 'curve');
  return dialog;
}
async function bounds(dialog: Locator, values: readonly (readonly [string, string, string])[]): Promise<void> {
  for (const [axis, minimum, maximum] of values) {
    await dialog.getByRole('textbox', { name: `${axis} ${text('minimum')}`, exact: true }).fill(minimum);
    await dialog.getByRole('textbox', { name: `${axis} ${text('maximum')}`, exact: true }).fill(maximum);
  }
}
async function preview(dialog: Locator, surface: boolean): Promise<void> {
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  const applyButton = dialog.getByRole('button', { name: text(surface ? 'surfaceApply' : 'apply'), exact: true });
  const failure = dialog.getByRole('alert');
  // A terminal calculation error is a failure now, not a successful preview after150s.
  await expect.poll(async () => await applyButton.isEnabled() || await failure.isVisible(), { timeout: KERNEL_TIMEOUT_MS }).toBe(true);
  if (await failure.isVisible()) throw new Error(`Function preview failed: ${await failure.textContent()}`);
  await expect(applyButton).toBeEnabled({ timeout: KERNEL_TIMEOUT_MS });
  await expect(dialog.locator('canvas')).toBeVisible();
}
async function apply(page: Page, dialog: Locator, surface: boolean): Promise<void> {
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: text(surface ? 'surfaceApply' : 'apply'), exact: true }).click();
  await expect(dialog).toHaveCount(0); await waitForRecompute(page, token);
}
async function reopen(page: Page, info: TestInfo, file: string, app?: ElectronApplication): Promise<void> {
  await page.reload();
  const token = await beginRecompute(page);
  if (app !== undefined) await openTarget(app, info.outputPath(file));
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await page.getByRole('group', { name: uiMessage('toolbar', 'toolbar.file.title'), exact: true }).getByRole('button', { name: uiMessage('toolbar', 'toolbar.file.open'), exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(info.outputPath(file));
  await waitForRecompute(page, token);
}
async function undo(page: Page): Promise<void> {
  const token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
}

export async function functionSplineSurfaceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await start(page);
  try {
    const dialog = await openPlot(page, true);
    await dialog.getByRole('textbox', { name: 'Z =', exact: true }).fill('(X^2+Y^2)/10');
    await bounds(dialog, [['X', '-2', '2'], ['Y', '-2', '2'], ['Z', '-1', '1']]);
    await dialog.getByRole('textbox', { name: text('surfaceTolerance'), exact: true }).fill('0.01');
    await preview(dialog, true); await apply(page, dialog, true);
    const saved = await savePart(page, info, 'spline-surface.pcad', app);
    const feature = saved.solids.find(item => item.kind === 'functionSurface');
    if (feature?.kind !== 'functionSurface') throw new Error('Missing saved surface definition');
    expect(feature.definition).toMatchObject({ formula: { kind: 'coordinate-surface', output: 'Z', expression: { source: '(X^2+Y^2)/10' } },
      bounds: { X: { min: { value: -2 }, max: { value: 2 } }, Y: { min: { value: -2 }, max: { value: 2 } }, Z: { min: { value: -1 }, max: { value: 1 } } } });
    const traffic = await records(page);
    expect(traffic.some(row => row.event === 'math-reply' && row.kind === 'function-surface-result' && row.spline === true)).toBe(true);
    const native = traffic.flatMap(row => row.bodies ?? []).find(body => body.id === feature.id);
    expect(native, 'The real CAD Worker must return the created native body').toBeDefined();
    expect(native?.kind).toBe('shell'); expect(native?.faces.length).toBeGreaterThan(0);
    expect(native?.faces.every(kind => kind === 'other')).toBe(true);
    for (const axis of [0, 1]) { expect(native?.minimum[axis]).toBeCloseTo(-2, 2); expect(native?.maximum[axis]).toBeCloseTo(2, 2); }
    expect(native?.minimum[2]).toBeGreaterThanOrEqual(-0.01); expect(native?.maximum[2]).toBeCloseTo(0.8, 2);
    await attach(page, info);
    await reopen(page, info, 'spline-surface.pcad', app);
    expect((await savePart(page, info, 'spline-surface-reopened.pcad', app)).solids).toEqual(saved.solids);
    await page.getByText(feature.name, { exact: true }).click(); await page.getByRole('button', { name: text('edit'), exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Z =', exact: true })).toHaveValue('(X^2+Y^2)/10');
    await preview(dialog, true);
    await dialog.getByRole('textbox', { name: 'Z =', exact: true }).fill('(X^2+Y^2)/20');
    await expect(dialog.getByRole('button', { name: text('surfaceApply'), exact: true })).toBeDisabled();
    await expect(dialog.locator('canvas')).toHaveCount(0);
    await preview(dialog, true); await apply(page, dialog, true);
    expect((await savePart(page, info, 'spline-surface-edited.pcad', app)).solids.find(item => item.id === feature.id))
      .toMatchObject({ definition: { formula: { expression: { source: '(X^2+Y^2)/20' } } } });
    await undo(page); expect((await savePart(page, info, 'spline-surface-undo.pcad', app)).solids).toEqual(saved.solids);
  } finally { await attach(page, info); }
}

export async function functionSurfaceReplyCancellationFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await start(page);
  let primaryFailed = false;
  let primaryError: unknown;
  let framesStarted = false;
  try {
    const original = await savePart(page, info, 'before-large-surface.pcad', app);
    const dialog = await openPlot(page, true);
    await dialog.getByRole('textbox', { name: 'Z =', exact: true }).fill('(X^2+Y^2)/10');
    await bounds(dialog, [['X', '-4', '4'], ['Y', '-4', '4'], ['Z', '-1', '4']]);
    await dialog.getByRole('textbox', { name: text('surfaceTolerance'), exact: true }).fill('0.001');
    await beginFrames(page); framesStarted = true;
    await preview(dialog, true);
    framesStarted = false; await endFrames(page, info);
    const ready = (await records(page)).filter(row => row.event === 'math-reply' && row.kind === 'function-surface-result');
    expect(ready.some(row => (row.vertices ?? 0) > 1024), 'Finite real reply must exercise more than one decoder element block').toBe(true);
    // A real input invalidates an already displayed result. It may never be committed as the new input.
    await dialog.getByRole('textbox', { name: 'Z =', exact: true }).fill('(X^2+Y^2)/20');
    await expect(dialog.getByRole('button', { name: text('surfaceApply'), exact: true })).toBeDisabled();
    await expect(dialog.locator('canvas')).toHaveCount(0);
    await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
    await expect(dialog.getByRole('button', { name: text('stop'), exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: text('stop'), exact: true }).evaluate(button => {
      button.addEventListener('click', event => {
        window.pcadSplineSurfaceTraffic?.push({ event: 'stop-click', at: performance.now(), trusted: event.isTrusted });
      }, { capture: true, once: true });
    });
    const began = Date.now();
    await dialog.getByRole('button', { name: text('stop'), exact: true }).click();
    await expect(dialog.getByRole('button', { name: text('preview'), exact: true })).toBeVisible();
    reportDuration(Date.now() - began, 200, 'function surface trusted Stop UI response');
    const assertStopped = async (): Promise<void> => {
      const traffic = await records(page), clicked = traffic.findIndex(row => row.event === 'stop-click');
      expect(clicked, 'The actual trusted Stop click must be observed').toBeGreaterThanOrEqual(0);
      expect(traffic[clicked]?.trusted).toBe(true);
      expect(traffic.slice(clicked + 1).filter(row => row.event === 'math-request' || row.event === 'cad-request'),
        'Stop must not submit a replacement calculation').toEqual([]);
    };
    await assertStopped();
    await expect(dialog.getByRole('button', { name: text('surfaceApply'), exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: uiMessage('math', 'math.cancel'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await savePart(page, info, 'after-large-surface-cancel.pcad', app)).solids).toEqual(original.solids);
    await assertStopped();
    // A fresh owner/request after cancellation must succeed; a late reply cannot supply this definition.
    const fresh = await openPlot(page, true);
    await fresh.getByRole('textbox', { name: 'Z =', exact: true }).fill('(X^2+Y^2)/20');
    await bounds(fresh, [['X', '-1', '1'], ['Y', '-1', '1'], ['Z', '-1', '1']]);
    await preview(fresh, true); await apply(page, fresh, true);
    const final = await savePart(page, info, 'after-cancel-fresh-surface.pcad', app);
    expect(final.solids).toHaveLength(original.solids.length + 1);
    expect(final.solids.at(-1)).toMatchObject({ kind: 'functionSurface', definition: { formula: { expression: { source: '(X^2+Y^2)/20' } },
      bounds: { X: { min: { value: -1 }, max: { value: 1 } } } } });
  } catch (error) { primaryFailed = true; primaryError = error; }
  // Cleanup errors cannot replace the original failure, including a thrown undefined.
  const diagnosticErrors: unknown[] = [];
  if (framesStarted) {
    try { await endFrames(page, info); } catch (error) { diagnosticErrors.push(error); }
  }
  try { await attach(page, info); } catch (error) { diagnosticErrors.push(error); }
  if (primaryFailed) {
    for (const error of diagnosticErrors) console.error('Surface diagnostics failed after primary failure', error);
    throw primaryError;
  }
  if (diagnosticErrors.length === 1) throw diagnosticErrors[0];
  if (diagnosticErrors.length > 1) throw new AggregateError(diagnosticErrors, 'Surface diagnostics failed');
}

export async function functionSplineCurveFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await start(page);
  try {
    const dialog = await openPlot(page, false);
    await dialog.getByRole('textbox', { name: 'Y =', exact: true }).fill('X^2');
    await bounds(dialog, [['X', '-2', '2'], ['Y', '-1', '5'], ['Z', '-1', '1']]);
    await preview(dialog, false); await apply(page, dialog, false);
    const saved = await savePart(page, info, 'spline-curve.pcad', app);
    const feature = saved.sketches.flatMap(sketch => sketch.features).find(item => item.kind === 'functionCurve');
    if (feature?.kind !== 'functionCurve') throw new Error('Missing saved function curve');
    await reopen(page, info, 'spline-curve.pcad', app);
    expect((await savePart(page, info, 'spline-curve-reopened.pcad', app)).sketches).toEqual(saved.sketches);
    await page.getByText(feature.name, { exact: true }).click(); await page.getByRole('button', { name: text('edit'), exact: true }).click();
    await preview(dialog, false); await dialog.getByRole('textbox', { name: 'Y =', exact: true }).fill('X^2/2');
    await expect(dialog.getByRole('button', { name: text('apply'), exact: true })).toBeDisabled();
    await preview(dialog, false); await apply(page, dialog, false);
    expect((await savePart(page, info, 'spline-curve-edited.pcad', app)).sketches.flatMap(sketch => sketch.features).find(item => item.id === feature.id))
      .toMatchObject({ definition: { formula: { outputs: { Y: { source: 'X^2/2' } } } } });
    await undo(page); expect((await savePart(page, info, 'spline-curve-undo.pcad', app)).sketches).toEqual(saved.sketches);
    const tree = (name: string) => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
    const popup = page.locator('.pcad-popover'), fields = popup.locator('input.pcad-field__input');
    await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.shape.groupLabel'), uiMessage('toolbar', 'toolbar.tool.circle'));
    await expect(page.locator('.pcad-popover__title')).toHaveText(uiMessage('numericInput', 'numericInput.title.circleCenter'));
    for (let i = 0; i < 3; i++) await fields.nth(i).fill('0');
    await fields.first().press('Enter'); await expect(page.locator('.pcad-popover__title')).toHaveText(uiMessage('numericInput', 'numericInput.title.circleRadius'));
    const circle = await beginRecompute(page); await fields.first().fill('0.05'); await fields.first().press('Enter'); await waitForRecompute(page, circle);
    await fields.first().press('Escape'); await expect(popup).toHaveCount(0);
    await tree(`${uiMessage('toolbar', 'toolbar.tool.arc')}1`).click(); const face = await beginRecompute(page);
    await page.getByRole('group', { name: uiMessage('toolbar', 'toolbar.sketch.groupLabel'), exact: true }).getByRole('button', { name: uiMessage('toolbar', 'toolbar.tool.face'), exact: true }).click();
    await page.locator('canvas.pcad-viewport__canvas').press('Enter'); await waitForRecompute(page, face);
    await tree(`${uiMessage('toolbar', 'toolbar.tool.face')}1`).click(); await tree(feature.name).click({ modifiers: ['Shift'] });
    await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.create.groupLabel'), uiMessage('toolbar', 'toolbar.solid.sweep')); const sweep = await beginRecompute(page);
    await popup.getByRole('button', { name: uiMessage('numericInput', 'numericInput.commit'), exact: true }).click(); await waitForRecompute(page, sweep);
    const swept = await savePart(page, info, 'spline-curve-native-sweep.pcad', app);
    expect(swept.solids[0]).toMatchObject({ kind: 'sweep', path: { curveIds: [feature.id] } });
    await tree(`${uiMessage('toolbar', 'toolbar.solid.sweep')}1`).click();
    const cell = page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: new RegExp(`^${uiMessage('propertyPanel', 'propertyPanel.volume')}$`, 'u') }).locator('xpath=following-sibling::dd[1]');
    const volume = Number((await cell.textContent())?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
    const expected = Math.PI * 0.05 ** 2 * (2 * Math.sqrt(17) + Math.asinh(4) / 2);
    expect(Math.abs(volume / expected - 1)).toBeLessThan(0.005);
  } finally { await attach(page, info); }
}
