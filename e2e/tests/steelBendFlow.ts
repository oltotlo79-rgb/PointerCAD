/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { applyPlacementToPoint, IDENTITY_QUATERNION, type RigidPlacement } from '../../packages/model/src/index.js';
import { readDocumentBundle } from '../../packages/io/src/index.js';
import { chooseToolMenuItem, readAssemblyStats, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { waitForStartupReady } from './startupHealth.js';
import { readViewportRenderStats } from './viewportRenderStats.js';

export function registerSteelBendTest(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test('steel bend picker placement, one Undo, Redo and saved editable part reopen', async ({ page }, info) => {
    const app = appForPage(page), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    if (app === undefined) {
      await page.addInitScript(() => {
        for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
          Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
        }
      });
      await page.goto('/');
    }
    await waitForStartupReady(page);
    await resetAssemblyFileGateway(page);
    let token = await beginRecompute(page);
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(0);
    await chooseToolMenuItem(page, '組む', '規格部品');
    const picker = page.getByRole('dialog', { name: '規格部品を置く', exact: true });
    await picker.getByTitle('配置する規格部品の種類を選びます。種類に合わせて寸法の候補が切り替わります。', { exact: true }).selectOption('structuralSection');
    await picker.getByTitle('鋼種を選ぶと、製造元資料で確認した断面と寸法だけを表示します。', { exact: true }).selectOption('SS400');
    await picker.getByTitle('選んだ鋼種で確認済みの断面形状を選びます。', { exact: true }).selectOption('flatBar');
    await picker.locator('select').filter({ has: page.locator('option', { hasText: /^FB 50×6$/u }) })
      .selectOption({ label: 'FB 50×6' });
    await picker.getByRole('checkbox', { name: '曲げ部品を作る', exact: true }).check();
    await expect(picker.getByLabel('曲げ半径 R (mm)', { exact: true })).toBeVisible();
    await expect(picker.getByLabel('曲げ角度 (度)', { exact: true })).toBeVisible();
    await expect(picker.getByLabel('第1脚の寸法 (mm)', { exact: true })).toBeVisible();
    await expect(picker.getByLabel('第2脚の寸法 (mm)', { exact: true })).toBeVisible();
    await expect(picker.getByRole('combobox', { name: '半径の基準', exact: true })).toBeVisible();
    await expect(picker.getByRole('combobox', { name: '脚寸法の基準', exact: true })).toBeVisible();
    await expect(picker.getByRole('button', { name: '曲げ部品の配置へ', exact: true })).toBeVisible();
    await picker.getByLabel('曲げ半径 R (mm)', { exact: true }).fill('15*2');
    await picker.getByLabel('曲げ角度 (度)', { exact: true }).fill('90');
    await picker.getByLabel('第1脚の寸法 (mm)', { exact: true }).fill('100*2');
    await picker.getByLabel('第2脚の寸法 (mm)', { exact: true }).fill('100');
    await picker.getByRole('combobox', { name: '半径の基準', exact: true }).selectOption('inside');
    await picker.getByRole('combobox', { name: '脚寸法の基準', exact: true }).selectOption('tangent');
    const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const layout: unknown[] = [{ originalViewport }];
    const controls = [
      ...['曲げ半径 R (mm)', '曲げ角度 (度)', '第1脚の寸法 (mm)', '第2脚の寸法 (mm)']
        .map(name => picker.getByLabel(name, { exact: true })),
      picker.getByRole('combobox', { name: '半径の基準', exact: true }),
      picker.getByRole('combobox', { name: '脚寸法の基準', exact: true }),
      picker.getByRole('button', { name: '曲げ部品の配置へ', exact: true }),
    ];
    const hit = async (control: Locator): Promise<boolean> => control.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const target = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target !== null && element.contains(target);
    });
    for (const viewport of [originalViewport, { width: 1008, height: 681 }]) {
      if (viewport !== originalViewport) await page.setViewportSize(viewport);
      await expect(page.locator('.pcad-assembly-motion')).toBeVisible();
      for (const [index, control] of controls.entries()) {
        await control.scrollIntoViewIfNeeded();
        layout.push(await control.evaluate((element, index) => {
          const rect = element.getBoundingClientRect();
          const panel = element.closest<HTMLElement>('.pcad-popover--standard-part');
          if (panel === null) throw new Error('Picker containing block unavailable');
          const parent = panel.offsetParent;
          if (!(parent instanceof HTMLElement)) throw new Error('Picker offset parent unavailable');
          const style = getComputedStyle(panel);
          const target = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { index, viewport: { width: innerWidth, height: innerHeight },
            control: rect.toJSON(), panel: panel.getBoundingClientRect().toJSON(),
            parent: parent.getBoundingClientRect().toJSON(), boxSizing: style.boxSizing,
            zIndex: style.zIndex, maxHeight: style.maxHeight, overflowY: style.overflowY,
            clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight, scrollTop: panel.scrollTop,
            hitOwned: target !== null && element.contains(target), hitClass: target?.className ?? null };
        }, index));
        await writeFile(info.outputPath('picker-layout.json'), JSON.stringify(layout, null, 2));
        await expect.poll(() => hit(control)).toBe(true);
      }
      // Playwright's normal pointer actionability checks, without changing or bypassing the timeline.
      await controls[controls.length - 1].click({ trial: true });
    }
    await picker.getByRole('button', { name: '曲げ部品の配置へ', exact: true }).click();
    await page.setViewportSize(originalViewport);
    await expect(picker).toHaveCount(0);
    const placement = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
    await expect(placement).toBeVisible();
    await placement.locator('input').first().fill('10*2');
    token = await beginRecompute(page);
    await placement.getByRole('button', { name: '置く', exact: true }).click();
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(1);
    const placed = await readAssemblyStats(page);
    expect(placed.components[0].sourceKind).toBe('part');
    expect(placed.components[0].resolved?.position).toEqual([20, 0, 0]);
    token = await beginRecompute(page);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(0);
    token = await beginRecompute(page);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await waitForRecompute(page, token);
    expect((await readAssemblyStats(page)).components).toEqual(placed.components);
    const path = info.outputPath('steel-bend.pcada');
    await saveFlowFile(page, path, app);
    const saved = await readDocumentBundle(await readFile(path), 'assembly');
    if (!saved.ok || saved.bundle.kind !== 'assembly') throw new Error('Saved assembly did not decode');
    expect(saved.bundle.document.components).toHaveLength(1);
    const source = saved.bundle.document.components[0].source;
    if (source.kind !== 'part') throw new Error('Bend regressed to straight source');
    const part = saved.bundle.embeddedDocuments.get(source.partRef)?.document;
    if (part === undefined) throw new Error('Editable bend missing from bundle');
    expect(part.steelStockSource).toMatchObject({ catalog: 'flatBar', size: 'FB 50×6' });
    expect(Number(part.steelStockSource?.options.length)).toBeCloseTo(300 + 55 * Math.PI / 2, 12);
    expect(part.solids.map(solid => solid.kind)).toEqual(['sweep']);
    expect(part.sketches.some(sketch => sketch.features.some(feature => feature.kind === 'arc'))).toBe(true);
    const beforeRender = await readViewportRenderStats(page);
    await openSaveFlowFile(page, path, app);
    expect((await readAssemblyStats(page)).components).toEqual(placed.components);
    await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
      .toBeGreaterThan(beforeRender.completedRenders);
    // FramedBodies observes ordinary Part solids, not the separate Assembly layer.
    // A normal canvas hit must select the saved/reopened assembly component itself.
    const firstLeg = part.sketches.flatMap(sketch => sketch.features)
      .find(feature => feature.id === 'first-leg');
    if (firstLeg?.kind !== 'line' || firstLeg.from.mode !== 'absolute' || firstLeg.to.mode !== 'absolute') {
      throw new Error('Saved bend first tangent unavailable');
    }
    const pose = placed.components[0].resolved;
    if (pose === null) throw new Error('Saved component pose missing');
    expect(pose.position).toHaveLength(3);
    expect(pose.rotation).toHaveLength(4);
    const rigidPlacement: RigidPlacement = {
      position: [pose.position[0], pose.position[1], pose.position[2]],
      rotation: [pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]],
    };
    expect(rigidPlacement.rotation).toEqual(IDENTITY_QUATERNION);
    // Interior point on the first tangent near its origin, derived from actual saved coordinates.
    const point = applyPlacementToPoint(rigidPlacement, [
      firstLeg.from.x.value + (firstLeg.to.x.value - firstLeg.from.x.value) / 10,
      firstLeg.from.y.value + (firstLeg.to.y.value - firstLeg.from.y.value) / 10,
      firstLeg.from.z.value + (firstLeg.to.z.value - firstLeg.from.z.value) / 10,
    ]);
    await page.keyboard.press('Escape');
    const renderedRow = page.locator('tr.pcad-bom__row').filter({ hasText: part.name });
    await expect(renderedRow).toHaveCount(1);
    await expect(renderedRow).toHaveAttribute('aria-selected', 'false');
    await clickWorldPointChecked(page, point);
    await expect(renderedRow).toHaveAttribute('aria-selected', 'true');
    const reopenedPath = info.outputPath('steel-bend-reopened.pcada');
    await saveFlowFile(page, reopenedPath, app);
    const reopened = await readDocumentBundle(await readFile(reopenedPath), 'assembly');
    if (!reopened.ok || reopened.bundle.kind !== 'assembly') throw new Error('Reopened assembly did not decode');
    expect(reopened.bundle.document).toEqual(saved.bundle.document);
    expect(reopened.bundle.embeddedDocuments.get(source.partRef)?.document).toEqual(part);
    expect(errors).toEqual([]);
  });
}
