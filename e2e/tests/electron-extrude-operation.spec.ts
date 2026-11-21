import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { extrudeMultipleFacesFlow } from './flows/extrudeMultipleFacesFlow.js';
import { extrudeOperationFlow, extrudeRegionFlow, extrudeStaleTargetFlow } from './flows/extrudeOperationFlow.js';

for (const operation of ['new', 'join', 'cut'] as const) {
  test(`Electron extrude ${operation}: real preview cancel atomic Undo and saved geometry`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow();
      expect(page.url()).toBe('app://pointercad/index.html');
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await extrudeOperationFlow(page, info, operation, app);
      expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}

test('Electron extrude stale selected target refuses without a new Undo entry', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await extrudeStaleTargetFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('Electron extrude closed and holed regions, atomic Undo, saved holes and Join/Cut suggestions (M-01)', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await extrudeRegionFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('Electron extrude two selected faces with one distance and one Undo', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await extrudeMultipleFacesFlow(page, info);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
