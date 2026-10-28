/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, readDrawingBundle, writeDrawingBundle } from '../../packages/io/src/index.js';
import { createDrawingDocument, embedDrawingSource, emptyDrawingSourceLibrary, partLibraryOfBundle,
  type DrawingDocument, type DrawingSourceInput } from '../../packages/model/src/index.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { waitForDrawingReady } from './drawingManufacturingFixture.js';
import { uiMessage } from './uiMessages.js';

async function fixture(): Promise<Uint8Array> {
  const read = await readDocumentBundle(await twoBoxAssemblyFile(), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('Assembly fixture required');
  const source: DrawingSourceInput = { sourceKind: 'assembly', document: read.bundle.document, library: partLibraryOfBundle(read.bundle) };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'boxes.pcada', '', { importedAt: '2026-10-26T00:00:00Z' });
  const base = createDrawingDocument('Drawing navigation', embedded.source);
  const document: DrawingDocument = { ...base,
    views: [{ id: 'view-nav', name: 'Navigation front', kind: 'front', position: [200, 170], direction: [0, 1, 0], xDir: [1, 0, 0],
      scale: 1, showHidden: true, showCenterLines: true, layerId: 'layer-1' }],
    annotations: [{ id: 'note-nav', kind: 'note', text: 'Navigation anchor', height: 5, position: [170, 125], layerId: 'layer-5' }],
    dimensions: [{ id: 'dim-nav', kind: 'length', measurement: 'trueDistance', origin: 'manual', reference: false, layerId: 'layer-4',
      placement: { commonNormalCoordinate: 225, textPosition: [220, 225] }, targets: [
        { kind: 'point', viewId: 'view-nav', paperPoint: [200, 170], modelPoint: [0, 0, 0] },
        { kind: 'point', viewId: 'view-nav', paperPoint: [240, 170], modelPoint: [40, 0, 0] },
      ] }],
  };
  return writeDrawingBundle(document, { source, savedAt: '2026-10-26T00:00:00Z' });
}

const sheet = (page: Page) => page.locator('.pcad-drawing-sheet');
const svg = (page: Page) => page.locator('.pcad-drawing-svg svg');
const owner = (page: Page, id: string) => page.locator(`.pcad-drawing-svg [data-owner-id="${id}"]`);
async function matrix(page: Page) {
  return svg(page).evaluate(element => {
    if (!(element instanceof SVGSVGElement)) throw new Error('SVG sheet required');
    const value = element.getScreenCTM(); if (value === null) throw new Error('Screen matrix required');
    return { a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f };
  });
}
// Inline style is a CSSOM serialization, rather than the product's raw double.
async function appliedScale(page: Page): Promise<number> {
  return sheet(page).evaluate(element => {
    if (!(element instanceof HTMLElement)) throw new Error('HTML sheet required');
    const match = /scale\(([^)]+)\)/.exec(element.style.transform);
    const scale = match === null ? NaN : Number(match[1]);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Finite inline scale required');
    return scale;
  });
}
async function calibratedScale(page: Page, info: TestInfo, name: string, input: number, actual: number): Promise<number> {
  const calibration = await page.evaluate(value => {
    // Test-owned and detached: no product state or rendered sheet is changed.
    const probe = document.createElement('div');
    probe.style.transform = `translate(0px, 0px) scale(${value})`;
    const serialized = probe.style.transform, match = /scale\(([^)]+)\)/.exec(serialized);
    return { input: value, serialized, scale: match === null ? NaN : Number(match[1]) };
  }, input);
  await info.attach(`drawing-navigation-cssom-${name}`, { body: JSON.stringify({ ...calibration, actual }, null, 2), contentType: 'application/json' });
  expect(Number.isFinite(calibration.scale) && calibration.scale > 0).toBe(true);
  return calibration.scale;
}
async function expectScreenZoom(page: Page, before: Awaited<ReturnType<typeof matrix>>,
  anchor: { x: number; y: number }, ratio: number) {
  const after = await matrix(page);
  const { x: left, y: top, width, height } = await svg(page).evaluate(element => {
    if (!(element instanceof SVGSVGElement)) throw new Error('SVG sheet required');
    const box = element.viewBox.baseVal;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  // Screen matrices are graphics measurements; check their effect in CSS pixels.
  for (const [x, y] of [[left, top], [left + width, top], [left, top + height], [left + width, top + height]]) {
    const start = { x: before.a * x + before.c * y + before.e, y: before.b * x + before.d * y + before.f };
    const end = { x: after.a * x + after.c * y + after.e, y: after.b * x + after.d * y + after.f };
    expect(Math.abs(end.x - (anchor.x + ratio * (start.x - anchor.x)))).toBeLessThanOrEqual(1);
    expect(Math.abs(end.y - (anchor.y + ratio * (start.y - anchor.y)))).toBeLessThanOrEqual(1);
    const determinant = after.a * after.d - after.b * after.c;
    expect(Number.isFinite(determinant) && determinant !== 0).toBe(true);
    const relativeX = end.x - after.e, relativeY = end.y - after.f;
    expect(Math.abs((after.d * relativeX - after.c * relativeY) / determinant - x)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs((after.a * relativeY - after.b * relativeX) / determinant - y)).toBeLessThanOrEqual(1e-9);
  }
  return after;
}
async function noteAnchor(page: Page) {
  return owner(page, 'note-nav').locator('g[aria-label]').first().evaluate(element => {
    if (!(element instanceof SVGGraphicsElement)) throw new Error('Outlined annotation required');
    const bounds = element.getBBox(), value = element.getScreenCTM();
    if (value === null) throw new Error('Annotation matrix required');
    const point = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(value);
    return { x: point.x, y: point.y };
  });
}
async function drag(page: Page, info: TestInfo, point: { x: number; y: number }, button: 'left' | 'middle' | 'right',
  dx: number, dy: number, modifiers: readonly string[] = []) {
  await page.mouse.move(point.x, point.y);
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  const observation = await page.evaluateHandle(() => {
    const geometry = () => {
      const root = document.querySelector('.pcad-drawing-svg svg');
      if (!(root instanceof SVGSVGElement)) throw new Error('SVG sheet required at native event');
      const value = root.getScreenCTM();
      if (value === null) throw new Error('Screen matrix required at native event');
      const ancestors: { tag: string; className: string; x: number; y: number; scrollLeft: number; scrollTop: number }[] = [];
      for (let element: Element | null = root.parentElement; element !== null; element = element.parentElement) {
        const box = element.getBoundingClientRect();
        ancestors.push({ tag: element.localName, className: element.getAttribute('class') ?? '',
          x: box.x, y: box.y, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop });
      }
      return { matrix: { a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f },
        ancestors, active: document.activeElement?.getAttribute('class') ?? null, scrollX, scrollY };
    };
    type ObservedEvent = { type: string; x: number; y: number; pointer: number; trusted: boolean;
      geometry: ReturnType<typeof geometry> };
    const events: ObservedEvent[] = [], afterHandlers: ObservedEvent[] = [];
    const observe = (event: PointerEvent): ObservedEvent => ({ type: event.type, x: event.clientX, y: event.clientY,
      pointer: event.pointerId, trusted: event.isTrusted, geometry: geometry() });
    const listener = (event: PointerEvent) => events.push(observe(event));
    const afterListener = (event: PointerEvent) => afterHandlers.push(observe(event));
    for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
      document.addEventListener(type, listener, true); document.addEventListener(type, afterListener);
    }
    return { events, afterHandlers, stop: () => {
      for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
        document.removeEventListener(type, listener, true); document.removeEventListener(type, afterListener);
      }
    } };
  });
  try {
    await page.mouse.down({ button }); await page.mouse.move(point.x + dx, point.y + dy, { steps: 4 });
    await page.mouse.up({ button });
    const { events, afterHandlers } = await observation.evaluate(value => ({ events: value.events, afterHandlers: value.afterHandlers }));
    await info.attach('drawing-navigation-pointer', { body: JSON.stringify({ requested: { point, dx, dy, button, modifiers }, events, afterHandlers }, null, 2),
      contentType: 'application/json' });
    const start = events.find(event => event.type === 'pointerdown');
    const moveEnd = events.filter(event => event.type === 'pointermove').at(-1) ?? (dx === 0 && dy === 0 ? start : undefined);
    const end = events.find(event => event.type === 'pointerup');
    if (start === undefined || moveEnd === undefined || end === undefined) throw new Error('Native drag observations required');
    expect(events.every(event => event.trusted && event.pointer === start.pointer)).toBe(true);
    // Navigation consumes pointermove; document edits commit the pointerup point.
    const delivered = { x: moveEnd.x - start.x, y: moveEnd.y - start.y };
    expect(Math.abs(delivered.x - dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(delivered.y - dy)).toBeLessThanOrEqual(1);
    return { start, end, delivered, afterHandlers };
  } finally {
    await observation.evaluate(value => value.stop()); await observation.dispose();
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  }
}
function paperDelta(transform: Awaited<ReturnType<typeof matrix>>, movement: Awaited<ReturnType<typeof drag>>) {
  const { a, b, c, d, e, f } = transform, determinant = a * d - b * c;
  const project = (point: { x: number; y: number }) => ({
    x: (d * (point.x - e) - c * (point.y - f)) / determinant,
    y: (a * (point.y - f) - b * (point.x - e)) / determinant,
  });
  const start = project(movement.start), end = project(movement.end);
  return { x: end.x - start.x, y: start.y - end.y };
}

export async function drawingNavigationFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = info.outputPath('navigation-original.pcadd'); await writeFile(input, await fixture());
  const open = async (): Promise<void> => {
    if (app !== undefined) await openTarget(app, input);
    const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
    await page.getByRole('button', { name: '開く', exact: true }).click();
    if (chooser !== undefined) await (await chooser).setFiles(input);
    await waitForDrawingReady(page); await expect(owner(page, 'note-nav').locator('g[aria-label]').first()).toBeVisible();
  };
  const save = async (name: string): Promise<DrawingDocument> => {
    const path = info.outputPath(`${name}.pcadd`);
    if (app !== undefined) await saveTarget(app, path);
    const download = app === undefined ? page.waitForEvent('download') : undefined;
    await sheet(page).focus(); await page.keyboard.press('Control+Shift+s');
    if (download !== undefined) await (await download).saveAs(path); else await diskFile(path);
    const result = await readDrawingBundle(await readFile(path)); if (!result.ok) throw new Error(result.error.message);
    return result.document;
  };
  await open(); const original = await save('navigation-before');
  const label = (key: string) => uiMessage('view', `settings.camera.${key}`);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const form = page.getByRole('form', { name: label('title'), exact: true }); await expect(form).toBeVisible();
  await form.getByRole('button', { name: label('defaults'), exact: true }).click();
  const zoom = form.getByRole('group', { name: label('zoom'), exact: true });
  await zoom.getByRole('combobox', { name: label('binding').replace('{number}', '2'), exact: true }).selectOption('middle');
  const pan = form.getByRole('group', { name: label('pan'), exact: true });
  await pan.getByRole('combobox', { name: label('binding').replace('{number}', '2'), exact: true }).selectOption('left');
  await pan.getByRole('checkbox', { name: label('alt'), exact: true }).nth(1).check();
  await form.getByRole('button', { name: label('apply'), exact: true }).click();
  await expect(form.getByRole('button', { name: label('apply'), exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const initialMatrix = await matrix(page);

  // Both pan slots: the same physical point follows the actual mouse in CSS pixels.
  for (const [button, modifiers] of [['right', []], ['left', ['Alt', 'Shift']]] as const) {
    const point = await noteAnchor(page), before = await matrix(page);
    const movement = await drag(page, info, point, button, 31.25, 18.5, modifiers);
    await expect.poll(async () => (await matrix(page)).e).toBeCloseTo(before.e + movement.delivered.x, 0);
    const after = await noteAnchor(page);
    expect(Math.abs(after.x - point.x - movement.delivered.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - point.y - movement.delivered.y)).toBeLessThanOrEqual(1);
  }

  // Observe delivered native wheel input before the product's capture listener.
  const anchor = await noteAnchor(page), beforeZoom = await matrix(page), beforeZoomScale = await appliedScale(page);
  const observation = await page.evaluateHandle(() => {
    const events: { deltaY: number; deltaMode: number; trusted: boolean }[] = [];
    const listener = (event: WheelEvent) => events.push({ deltaY: event.deltaY, deltaMode: event.deltaMode, trusted: event.isTrusted });
    document.addEventListener('wheel', listener, { capture: true, passive: true });
    return { events, stop: () => document.removeEventListener('wheel', listener, true) };
  });
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await matrix(page)).a).not.toBe(beforeZoom.a);
  const delivered = await observation.evaluate(value => value.events);
  await observation.evaluate(value => value.stop()); await observation.dispose();
  expect(delivered).toHaveLength(1); expect(delivered[0].trusted).toBe(true);
  const factor = delivered[0].deltaMode === 1 ? 16 : delivered[0].deltaMode === 2 ? 100 : 1;
  const wheelRatio = 1.1 ** (-delivered[0].deltaY * factor / 100), afterZoomScale = await appliedScale(page);
  // The fixture starts at scale 1; preceding pans do not change it.
  expect(beforeZoomScale).toBe(await calibratedScale(page, info, 'initial', 1, beforeZoomScale));
  const wheelScale = 1 * wheelRatio;
  expect(afterZoomScale).toBe(await calibratedScale(page, info, 'wheel', wheelScale, afterZoomScale));
  const afterZoomMatrix = await expectScreenZoom(page, beforeZoom, anchor, wheelRatio);
  const afterZoom = await noteAnchor(page);
  expect(Math.abs(afterZoom.x - anchor.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterZoom.y - anchor.y)).toBeLessThanOrEqual(1);
  // Zoom centre and ordinary left selection must resolve the same annotation.
  await page.mouse.click(anchor.x, anchor.y);
  await expect.poll(() => owner(page, 'note-nav').locator('path').evaluateAll(elements =>
    elements.some(element => element.getAttribute('fill') === '#2563eb'))).toBe(true);

  // Second zoom slot is a Ctrl+middle drag; anchor remains at its initial position.
  const secondAnchor = await noteAnchor(page), beforeDragZoom = await matrix(page), beforeDragScale = await appliedScale(page);
  const zoomMovement = await drag(page, info, secondAnchor, 'middle', 0, 20, ['Control']);
  const dragRatio = 1.1 ** (-zoomMovement.delivered.y / 100), afterDragScale = await appliedScale(page);
  expect(beforeDragScale).toBe(await calibratedScale(page, info, 'before-drag', wheelScale, beforeDragScale));
  expect(afterDragScale).toBe(await calibratedScale(page, info, 'drag', wheelScale * dragRatio, afterDragScale));
  const afterDragMatrix = await expectScreenZoom(page, beforeDragZoom, secondAnchor, dragRatio);
  const afterDragZoom = await noteAnchor(page);
  expect(Math.abs(afterDragZoom.x - secondAnchor.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterDragZoom.y - secondAnchor.y)).toBeLessThanOrEqual(1);

  const unchanged = await matrix(page), negativePoint = await noteAnchor(page);
  await drag(page, info, negativePoint, 'right', 0, 0); // zero pixels
  await drag(page, info, negativePoint, 'right', 30, 20, ['Meta']); // extra modifier
  await drag(page, info, negativePoint, 'left', 30, 20, ['Alt', 'Shift', 'Control']); // unmatched left navigation must not edit
  await drag(page, info, negativePoint, 'middle', 30, 20); // orbit is inapplicable to paper
  expect(await matrix(page)).toEqual(unchanged);
  // Real DOM event route, with a single React batch: no document write for 100 operations.
  await sheet(page).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    for (let index = 0; index < 100; index++) element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: bounds.left + 250, clientY: bounds.top + 150,
      deltaY: index % 2 === 0 ? 5 : -5, deltaMode: 0, buttons: 0,
    }));
  });
  expect(await save('navigation-after-100')).toEqual(original);

  // Observe the real pointer ID rather than assuming a browser/host-specific value.
  const pointerObservation = await page.evaluateHandle(() => {
    let pointer: number | null = null;
    const listener = (event: PointerEvent) => { pointer = event.pointerId; };
    document.addEventListener('pointerdown', listener, true);
    return { get: () => pointer, stop: () => document.removeEventListener('pointerdown', listener, true) };
  });
  // Cancellation and capture loss end the owner; later movement must be inert.
  for (const type of ['pointercancel', 'lostpointercapture', 'blur'] as const) {
    const point = await noteAnchor(page); await page.mouse.move(point.x, point.y); await page.mouse.down({ button: 'right' });
    const pointer = await pointerObservation.evaluate(value => value.get());
    if (pointer === null) throw new Error('Native pointer observation missing');
    await page.getByTestId('drawing-viewport').evaluate((element, ending) => {
      if (ending.type === 'blur') window.dispatchEvent(new Event('blur'));
      else {
        element.dispatchEvent(new PointerEvent(ending.type, { bubbles: true, pointerId: ending.pointer }));
      }
    }, { type, pointer });
    const cancelled = await matrix(page);
    await page.mouse.move(point.x + 25, point.y + 15); await page.mouse.up({ button: 'right' });
    expect(await matrix(page)).toEqual(cancelled);
  }
  await pointerObservation.evaluate(value => value.stop()); await pointerObservation.dispose();
  expect(await save('navigation-cancelled')).toEqual(original);

  // At a transformed scale, normal annotation and dimension drags still edit once and Undo restores them.
  const note = await noteAnchor(page), noteMatrix = await matrix(page);
  const noteMovement = await drag(page, info, note, 'left', 12, -9), noteDelta = paperDelta(noteMatrix, noteMovement);
  await waitForDrawingReady(page);
  const movedNote = await save('navigation-note-moved');
  expect(movedNote.annotations[0].position[0] - original.annotations[0].position[0]).toBeCloseTo(noteDelta.x, 8);
  expect(movedNote.annotations[0].position[1] - original.annotations[0].position[1]).toBeCloseTo(noteDelta.y, 8);
  await page.keyboard.press('Control+z'); await waitForDrawingReady(page); expect(await save('navigation-note-undo')).toEqual(original);
  const dimension = await owner(page, 'dim-nav').locator('g[aria-label]').first().boundingBox();
  if (dimension === null) throw new Error('Dimension text required');
  const dimensionMatrix = await matrix(page);
  const dimensionMovement = await drag(page, info, { x: dimension.x + dimension.width / 2, y: dimension.y + dimension.height / 2 }, 'left', 0, -10);
  const dimensionDelta = paperDelta(dimensionMatrix, dimensionMovement);
  await waitForDrawingReady(page);
  const movedDimension = await save('navigation-dimension-moved');
  expect(movedDimension.dimensions[0].placement.commonNormalCoordinate - original.dimensions[0].placement.commonNormalCoordinate)
    .toBeCloseTo(dimensionDelta.y, 8);
  await page.keyboard.press('Control+z'); await waitForDrawingReady(page); expect(await save('navigation-dimension-undo')).toEqual(original);

  await page.getByRole('button', { name: 'Navigation front', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Navigation front', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const projection = await svg(page).evaluateHandle((root, view) => {
    // Assembly curves belong to occurrences; data-view-id identifies their view.
    const excluded = Array.from(root.querySelectorAll('[data-owner-id="note-nav"], [data-owner-id="dim-nav"]'))
      .map(element => element.getBoundingClientRect());
    for (const group of Array.from(root.querySelectorAll('[data-view-id][data-owner-id]'))) {
      const ownerId = group.getAttribute('data-owner-id');
      if (group.getAttribute('data-view-id') !== view.id || group.getAttribute('data-layer-id') !== view.layerId
        || ownerId === null || !ownerId.startsWith('projection:')) continue;
      const identity: unknown = JSON.parse(ownerId.slice('projection:'.length));
      if (!Array.isArray(identity) || identity.length !== 2 || identity[0] !== view.id
        || typeof identity[1] !== 'string' || identity[1] === '') continue;
      for (const element of Array.from(group.children)) {
        if (!(element instanceof SVGGeometryElement)) continue;
        const length = element.getTotalLength(), transform = element.getScreenCTM();
        if (!Number.isFinite(length) || length <= 0 || transform === null) continue;
        for (const fraction of [0.5, 0.25, 0.75]) {
          const onCurve = element.getPointAtLength(length * fraction);
          const screen = new DOMPoint(onCurve.x, onCurve.y).matrixTransform(transform);
          // Native clients can quantize coordinates: choose an integer still on the real stroke.
          const point = { x: Math.round(screen.x), y: Math.round(screen.y) };
          const local = new DOMPoint(point.x, point.y).matrixTransform(transform.inverse());
          if (!element.isPointInStroke(local) || document.elementFromPoint(point.x, point.y) !== element
            || excluded.some(box => point.x >= box.left - 7 && point.x <= box.right + 7
              && point.y >= box.top - 7 && point.y <= box.bottom + 7)) continue;
          let down: { sameGeometry: boolean; ownerId: string | null; viewId: string | null; trusted: boolean } | null = null;
          const listener = (event: PointerEvent) => {
            const hit = event.target instanceof Element ? event.target.closest('[data-owner-id]') : null;
            down = { sameGeometry: event.target === element, ownerId: hit?.getAttribute('data-owner-id') ?? null,
              viewId: hit?.getAttribute('data-view-id') ?? null, trusted: event.isTrusted };
          };
          document.addEventListener('pointerdown', listener, true);
          return { point, ownerId, tag: element.localName, length, fraction, onCurve: { x: onCurve.x, y: onCurve.y },
            screen: { x: screen.x, y: screen.y }, read: () => down,
            stop: () => document.removeEventListener('pointerdown', listener, true) };
        }
      }
    }
    throw new Error('Visible assembly projection stroke required, clear of annotations and dimensions');
  }, original.views[0]);
  const viewPoint = await projection.evaluate(value => value.point), viewMatrix = await matrix(page);
  const viewMovement = await (async () => {
    try {
      const movement = await drag(page, info, viewPoint, 'left', 10, 8);
      const hit = await projection.evaluate(value => ({ point: value.point, ownerId: value.ownerId, tag: value.tag,
        length: value.length, fraction: value.fraction, onCurve: value.onCurve, screen: value.screen, down: value.read() }));
      await info.attach('drawing-navigation-projection-hit', { body: JSON.stringify(hit, null, 2), contentType: 'application/json' });
      expect(hit.down).toEqual({ sameGeometry: true, ownerId: hit.ownerId, viewId: original.views[0].id, trusted: true });
      return movement;
    } finally { await projection.evaluate(value => value.stop()); await projection.dispose(); }
  })(), viewDelta = paperDelta(viewMatrix, viewMovement);
  await waitForDrawingReady(page);
  const movedView = await save('navigation-view-moved');
  // Independently invert the actual down/up matrices; retain the pre-drag expectation below.
  const projectEvent = (event: typeof viewMovement.start) => {
    const { a, b, c, d, e, f } = event.geometry.matrix, determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || determinant === 0) throw new Error('Invertible native-event matrix required');
    return { x: (d * (event.x - e) - c * (event.y - f)) / determinant,
      y: (a * (event.y - f) - b * (event.x - e)) / determinant };
  };
  const downPaper = projectEvent(viewMovement.start), upPaper = projectEvent(viewMovement.end);
  const eventDelta = { x: upPaper.x - downPaper.x, y: downPaper.y - upPaper.y };
  const savedDelta = { x: movedView.views[0].position[0] - original.views[0].position[0],
    y: movedView.views[0].position[1] - original.views[0].position[1] };
  await info.attach('drawing-navigation-projection-delta', { body: JSON.stringify({ viewMatrix, viewMovement,
    downPaper, upPaper, eventDelta, viewDelta, savedDelta,
    residual: { x: savedDelta.x - eventDelta.x, y: savedDelta.y - eventDelta.y } }, null, 2), contentType: 'application/json' });
  // Focusing an already visible sheet must not scroll its clipped viewport during an edit.
  // In Electron a 2px focus scroll previously added 0.8182028191982624mm to this drag.
  const afterDown = viewMovement.afterHandlers.find(event => event.type === 'pointerdown');
  expect.soft(afterDown?.geometry.active).toBe('pcad-drawing-sheet');
  expect.soft(viewMovement.start.geometry.matrix).toEqual(viewMatrix);
  const scrollPositions = (geometry: typeof viewMovement.start.geometry) => ({
    x: geometry.scrollX, y: geometry.scrollY,
    ancestors: geometry.ancestors.map(item => ({ tag: item.tag, className: item.className,
      left: item.scrollLeft, top: item.scrollTop })),
  });
  for (const event of [...viewMovement.afterHandlers, viewMovement.end]) {
    expect.soft(event.geometry.matrix).toEqual(viewMovement.start.geometry.matrix);
    expect.soft(scrollPositions(event.geometry)).toEqual(scrollPositions(viewMovement.start.geometry));
  }
  // Soft assertions preserve failure while allowing Undo and same-ID reload evidence in this run.
  expect.soft(savedDelta.x).toBeCloseTo(viewDelta.x, 8);
  expect.soft(savedDelta.y).toBeCloseTo(viewDelta.y, 8);
  await page.keyboard.press('Control+z'); await waitForDrawingReady(page); expect(await save('navigation-view-undo')).toEqual(original);

  // Replace the document while a drag owns capture. Even the same drawing ID is a fresh session.
  const switchPoint = await noteAnchor(page); await page.mouse.move(switchPoint.x, switchPoint.y);
  await page.mouse.down({ button: 'right' });
  if (app !== undefined) await openTarget(app, input);
  const switchChooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await page.keyboard.press('Control+o');
  if (switchChooser !== undefined) await (await switchChooser).setFiles(input);
  await waitForDrawingReady(page); await expect.poll(() => matrix(page)).toEqual(initialMatrix);
  await page.mouse.move(switchPoint.x + 40, switchPoint.y + 20); await page.mouse.up({ button: 'right' });
  expect(await matrix(page)).toEqual(initialMatrix);
  expect(await save('navigation-reopened')).toEqual(original);
  await info.attach('drawing-navigation-geometry', { body: JSON.stringify({ initialMatrix, beforeZoom, delivered,
    beforeZoomScale, afterZoomScale, wheelRatio, afterZoomMatrix, afterZoom,
    beforeDragZoom, beforeDragScale, afterDragScale, dragRatio, afterDragMatrix, afterDragZoom,
    noteMatrix, noteMovement, noteDelta, dimensionMatrix, dimensionMovement, dimensionDelta, viewMatrix, viewMovement, viewDelta,
    paper: original.sheet }, null, 2), contentType: 'application/json' });
}
