import { expect, test } from '@playwright/test';
import { extrudeMultipleFacesFlow } from './flows/extrudeMultipleFacesFlow.js';
import { extrudeOperationFlow, extrudeRegionFlow, extrudeStaleTargetFlow } from './flows/extrudeOperationFlow.js';

for (const operation of ['new', 'join', 'cut'] as const) {
  test(`Extrude ${operation}: real preview cancel atomic Undo and saved geometry`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
      }
    });
    await page.goto('/');
    await extrudeOperationFlow(page, info, operation);
    expect(errors).toEqual([]);
  });
}

test('Extrude stale explicitly selected target refuses without a new Undo entry', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/');
  await extrudeStaleTargetFlow(page, info);
  expect(errors).toEqual([]);
});

test('Extrude closed and holed regions, atomic Undo, saved holes and Join/Cut suggestions (M-01)', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/');
  await extrudeRegionFlow(page, info);
  expect(errors).toEqual([]);
});

test('Extrude two selected faces with one distance and one Undo', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await extrudeMultipleFacesFlow(page, info);
  expect(errors).toEqual([]);
});
