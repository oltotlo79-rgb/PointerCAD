import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { updateHoleWallMatePhi8Scenario, inspectFreshNativeHoleWallMatePhi8, reopenHoleWallMatePhi8Scenario, createHoleWallMateScenario, inspectFreshNativeHoleWallMate, reopenHoleWallMateScenario, createCylinderColdScenario, createImportedHoleScenario, inspectFreshNativeCylinderOrigins,
  reopenCylinderColdScenario, reopenImportedHoleScenario, type CylinderColdOperation } from './cylinderSubshapeColdFlow.js';
import { launchDesktop } from './electronAppFlow.js';

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

for (const operation of ['hole', 'threadShaft'] as const satisfies readonly CylinderColdOperation[]) {
  test(`実Electronの円柱A/B所有と${operation}を通常PCAD ZIPで冷再開する`, async ({ playwright }, info) => {
    const first = await launchDesktop(playwright, info);
    let active: ElectronApplication | null = first.app;
    try {
      const firstPage = await first.app.firstWindow();
      expect(firstPage.url()).toBe('app://pointercad/index.html');
      const firstErrors = pageErrors(firstPage);
      const saved = await createCylinderColdScenario(firstPage, info, operation, first.app);
      expect(firstErrors).toEqual([]);
      await first.app.close();
      active = null;

      // The disk file is the bytes saved by the old app. Fresh Node native proof is
      // separate from the new app Worker that will open the same file below.
      await inspectFreshNativeCylinderOrigins(saved);

      const second = await launchDesktop(playwright, info);
      active = second.app;
      const freshPage = await second.app.firstWindow();
      expect(freshPage.url()).toBe('app://pointercad/index.html');
      const freshErrors = pageErrors(freshPage);
      await reopenCylinderColdScenario(freshPage, info, saved, second.app);
      expect(freshErrors).toEqual([]);
    } finally {
      if (active !== null) await active.close();
    }
  });
}

test('実Electronの輸入形状(履歴なし)の穴は指紋補助の参照のまま冷再開する', async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info);
  let active: ElectronApplication | null = first.app;
  try {
    const firstPage = await first.app.firstWindow();
    expect(firstPage.url()).toBe('app://pointercad/index.html');
    const firstErrors = pageErrors(firstPage);
    const saved = await createImportedHoleScenario(firstPage, info, first.app);
    expect(firstErrors).toEqual([]);
    await first.app.close();
    active = null;

    const second = await launchDesktop(playwright, info);
    active = second.app;
    const freshPage = await second.app.firstWindow();
    expect(freshPage.url()).toBe('app://pointercad/index.html');
    const freshErrors = pageErrors(freshPage);
    await reopenImportedHoleScenario(freshPage, info, saved, second.app);
    expect(freshErrors).toEqual([]);
  } finally {
    if (active !== null) await active.close();
  }
});

test('R18 actual new hole walls concentric mate survives PCADA full Electron restart', async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info);
  let active: ElectronApplication | null = first.app;
  try {
    const firstPage = await first.app.firstWindow();
    const firstErrors = pageErrors(firstPage);
    const scenario = await createHoleWallMateScenario(firstPage, info, first.app, false, true);
    expect(firstErrors).toEqual([]);
    await first.app.close();
    active = null;
    await inspectFreshNativeHoleWallMate(scenario);
    const second = await launchDesktop(playwright, info);
    active = second.app;
    const secondPage = await second.app.firstWindow();
    const secondErrors = pageErrors(secondPage);
    await reopenHoleWallMateScenario(secondPage, info, scenario, second.app);
    expect(secondErrors).toEqual([]);
  } finally {
    await active?.close();
  }
});

test('R18 Electron same phi6 to expression phi8 keeps old wall refs and Undo across full application restart', async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info);
  let active: ElectronApplication | null = first.app;
  try {
    const firstPage = await first.app.firstWindow();
    expect(firstPage.url()).toBe('app://pointercad/index.html');
    const firstErrors = pageErrors(firstPage);
    const scenario = await createHoleWallMateScenario(firstPage, info, first.app);
    const updated = await updateHoleWallMatePhi8Scenario(firstPage, info, scenario, first.app);
    expect(firstErrors).toEqual([]);
    await first.app.close();
    active = null;
    await inspectFreshNativeHoleWallMatePhi8(updated);
    const second = await launchDesktop(playwright, info);
    active = second.app;
    const secondPage = await second.app.firstWindow();
    expect(secondPage.url()).toBe('app://pointercad/index.html');
    const secondErrors = pageErrors(secondPage);
    await reopenHoleWallMatePhi8Scenario(secondPage, info, updated, second.app);
    expect(secondErrors).toEqual([]);
  } finally { await active?.close(); }
});

test('R18 Electron legacy native confirmation Escape Cancel doubleclick and phi6 to expression phi8 keeps old wall refs and Undo across full application restart', async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info);
  let active: ElectronApplication | null = first.app;
  try {
    const firstPage = await first.app.firstWindow();
    expect(firstPage.url()).toBe('app://pointercad/index.html');
    const firstErrors = pageErrors(firstPage);
    const scenario = await createHoleWallMateScenario(firstPage, info, first.app, true);
    const updated = await updateHoleWallMatePhi8Scenario(firstPage, info, scenario, first.app, true);
    expect(firstErrors).toEqual([]);
    await first.app.close();
    active = null;
    await inspectFreshNativeHoleWallMatePhi8(updated);
    const second = await launchDesktop(playwright, info);
    active = second.app;
    const secondPage = await second.app.firstWindow();
    expect(secondPage.url()).toBe('app://pointercad/index.html');
    const secondErrors = pageErrors(secondPage);
    await reopenHoleWallMatePhi8Scenario(secondPage, info, updated, second.app);
    expect(secondErrors).toEqual([]);
  } finally { await active?.close(); }
});
import { createHoleRimScenario, inspectFreshNativeHoleRim, reopenHoleRimScenario, updateHoleRimPhi8Scenario } from './cylinderSubshapeColdFlow.js';

for (const operation of ['R面取り', 'C面取り'] as const) {
  test(`R18 actual Electron hole rim ${operation} native semantic owner expression UndoRedo and full application-cold ZIP`, async ({ playwright }, info) => {
    const first = await launchDesktop(playwright, info);
    let active: ElectronApplication | null = first.app;
    try {
      const firstPage = await first.app.firstWindow();
      expect(firstPage.url()).toBe('app://pointercad/index.html');
      const firstErrors = pageErrors(firstPage);
      const saved = await createHoleRimScenario(firstPage, info, operation, first.app);
      expect(firstErrors).toEqual([]);
      await first.app.close(); active = null;
      await inspectFreshNativeHoleRim(saved, info);
      const second = await launchDesktop(playwright, info); active = second.app;
      const secondPage = await second.app.firstWindow();
      expect(secondPage.url()).toBe('app://pointercad/index.html');
      const secondErrors = pageErrors(secondPage);
      await reopenHoleRimScenario(secondPage, info, saved, second.app);
      const updated = await updateHoleRimPhi8Scenario(secondPage, info, saved, second.app);
      expect(secondErrors).toEqual([]);
      await second.app.close(); active = null;
      await inspectFreshNativeHoleRim(updated, info);
      const third = await launchDesktop(playwright, info); active = third.app;
      const thirdPage = await third.app.firstWindow();
      expect(thirdPage.url()).toBe('app://pointercad/index.html');
      const thirdErrors = pageErrors(thirdPage);
      await reopenHoleRimScenario(thirdPage, info, updated, third.app);
      expect(thirdErrors).toEqual([]);
    } finally { await active?.close(); }
  });
}

import { updateIndependentHoleWallMatePhi8Scenario, inspectIndependentHoleWallMatePhi8, reopenIndependentHoleWallMatePhi8Scenario } from './cylinderSubshapeColdFlow.js';

test('R18 Electron independent A phi6 to expression phi8 keeps old wall refs and Undo across full application restart', async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info);
  let active: ElectronApplication | null = first.app;
  try {
    const firstPage = await first.app.firstWindow();
    expect(firstPage.url()).toBe('app://pointercad/index.html');
    const firstErrors = pageErrors(firstPage);
    const scenario = await createHoleWallMateScenario(firstPage, info, first.app, false, true);
    const updated = await updateIndependentHoleWallMatePhi8Scenario(firstPage, info, scenario, first.app);
    expect(firstErrors).toEqual([]);
    await first.app.close();
    active = null;
    await inspectIndependentHoleWallMatePhi8(updated);
    const second = await launchDesktop(playwright, info);
    active = second.app;
    const secondPage = await second.app.firstWindow();
    expect(secondPage.url()).toBe('app://pointercad/index.html');
    const secondErrors = pageErrors(secondPage);
    await reopenIndependentHoleWallMatePhi8Scenario(secondPage, info, updated, second.app);
    expect(secondErrors).toEqual([]);
  } finally { await active?.close(); }
});
