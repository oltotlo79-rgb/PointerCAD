/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { PartDocument } from '../../packages/model/src/index.js';
import { recomputePart } from '../../packages/model/src/part/recomputePart.js';
import { createInspectableNativeKernelForNodeTests } from '../../packages/model/src/testing/createNativeKernelBridge.node.js';
import { applyPlacementToPoint, IDENTITY_QUATERNION, type RigidPlacement } from '../../packages/model/src/index.js';
import { readDocumentBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import { chooseToolMenuItem, readAssemblyStats, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { waitForStartupReady } from './startupHealth.js';
import { chooseSteelFlatBar50x6 } from './steelPickerFlow.js';
import { readViewportRenderStats } from './viewportRenderStats.js';

export function registerSteelBendTest(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  registerSteelBendLifecycleTests(test, appForPage);
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
    await chooseSteelFlatBar50x6(picker, { grade: 'SS400', size: 'FB 50×6', condition: '熱間圧延材・熱処理条件未指定' });
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


/** W04の独立12組。方向0は幅50、方向90は厚6がRout-Rinとなる。 */
function registerSteelBendLifecycleTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined): void {
  registerSteelBendRecipeRejections(test, appForPage);
  for (const direction of [0, 90] as const) for (const radiusConvention of ['inside', 'outside'] as const)
    for (const legDimension of ['tangent', 'inside', 'outside'] as const) {
      test(`EX-07 current lifecycle ${direction} ${radiusConvention} ${legDimension}`, async ({ page }, info) => {
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
        await waitForStartupReady(page); await resetAssemblyFileGateway(page);
        let token = await beginRecompute(page);
        await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
        await waitForRecompute(page, token); await expect(componentRows(page)).toHaveCount(0);
        const snapshot = async (label: string) => {
          const read = await readDocumentBundle(await saveFlowFile(page, info.outputPath(`${label}.pcada`), app), 'assembly');
          if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('曲げの実保存文書を読めません');
          return { document: read.bundle.document,
            parts: [...read.bundle.embeddedDocuments.entries()].map(([ref, item]) => ({ ref, document: item.document })) };
        };
        const empty = await snapshot('bend-empty');
        const width = direction === 0 ? 50 : 6;
        const radius = radiusConvention === 'inside' ? 30 : 30 + width;
        const setback = legDimension === 'tangent' ? 0 : legDimension === 'inside' ? 30 : 30 + width;
        const sources = {
          radius: `(${radius}) + 0`, angle: '(90) + 0', direction: `(${direction}) + 0`,
          first: `(${100 + setback}) + 0`, second: `(${200 + setback}) + 0`,
        };
        const fields = ['曲げ半径 R (mm)', '曲げ角度 (度)', '断面に対する曲げ方向 (度)',
          '第1脚の寸法 (mm)', '第2脚の寸法 (mm)'] as const;
        const openPicker = async (): Promise<Locator> => {
          await chooseToolMenuItem(page, '組む', '規格部品');
          const picker = page.getByRole('dialog', { name: '規格部品を置く', exact: true });
          await picker.getByTitle('配置する規格部品の種類を選びます。種類に合わせて寸法の候補が切り替わります。', { exact: true }).selectOption('structuralSection');
          await chooseSteelFlatBar50x6(picker, { grade: 'SS400', size: 'FB 50×6', condition: '熱間圧延材・熱処理条件未指定' });
          await picker.getByRole('checkbox', { name: '曲げ部品を作る', exact: true }).check();
          for (const [index, source] of [sources.radius, sources.angle, sources.direction, sources.first, sources.second].entries()) {
            await picker.getByLabel(fields[index], { exact: true }).fill(source);
          }
          await picker.getByRole('combobox', { name: '半径の基準', exact: true }).selectOption(radiusConvention);
          await picker.getByRole('combobox', { name: '脚寸法の基準', exact: true }).selectOption(legDimension);
          return picker;
        };
        // 実配置ダイアログまで進んでから取消。文書も埋込部品も0commit。
        let picker = await openPicker();
        await picker.getByRole('button', { name: '曲げ部品の配置へ', exact: true }).click();
        const placement = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
        await expect(placement).toBeVisible();
        await placement.getByRole('button', { name: '取り消す', exact: true }).click();
        await expect(placement).toHaveCount(0);
        expect(await snapshot('bend-placement-cancel')).toEqual(empty);
        picker = await openPicker();
        await picker.getByRole('button', { name: '曲げ部品の配置へ', exact: true }).click();
        await expect(placement).toBeVisible(); token = await beginRecompute(page);
        await placement.getByRole('button', { name: '置く', exact: true }).click();
        await waitForRecompute(page, token); await expect(componentRows(page)).toHaveCount(1);
        const placed = await snapshot('bend-placed');
        expect(placed.document.components).toHaveLength(1);
        const component = placed.document.components[0];
        if (component.source.kind !== 'part') throw new Error('曲げが実部品参照ではありません');
        const partRef = component.source.partRef;
        const part = placed.parts.find(item => item.ref === partRef)?.document;
        if (part === undefined) throw new Error('配置した曲げ部品がありません');
        const expected = 50 * 6 * (300 + (30 + width / 2) * Math.PI / 2);
        await bendLifecycleNative(part, expected, info);
        // 配置そのものがUndo1回。取消が履歴に挟まっていないことも同時に確認する。
        token = await beginRecompute(page); await page.getByRole('button', { name: '元に戻す', exact: true }).click();
        await waitForRecompute(page, token); expect(await snapshot('bend-placement-undo')).toEqual(empty);
        token = await beginRecompute(page); await page.getByRole('button', { name: 'やり直す', exact: true }).click();
        await waitForRecompute(page, token); expect(await snapshot('bend-placement-redo')).toEqual(placed);
        await openSaveFlowFile(page, info.outputPath('bend-placed.pcada'), app);
        expect(await snapshot('bend-cold-document-reopen')).toEqual(placed);
        const openEdit = async (): Promise<Locator> => {
          await componentRows(page).first().click();
          await chooseToolMenuItem(page, '組む', '規格部品');
          await page.getByRole('dialog', { name: '規格部品を置く', exact: true })
            .getByRole('button', { name: '選択した曲げを再編集', exact: true }).click();
          const edit = page.getByRole('dialog', { name: '曲げの元入力を再編集', exact: true });
          await expect(edit).toBeVisible();
          return edit;
        };
        const expectSources = async (edit: Locator): Promise<void> => {
          for (const [index, source] of [sources.radius, sources.angle, sources.direction, sources.first, sources.second].entries()) {
            await expect(edit.getByLabel(fields[index], { exact: true })).toHaveValue(source);
          }
          await expect(edit.getByRole('combobox', { name: '半径の基準', exact: true })).toHaveValue(radiusConvention);
          await expect(edit.getByRole('combobox', { name: '脚寸法の基準', exact: true })).toHaveValue(legDimension);
        };
        for (const cancel of ['button', 'escape'] as const) {
          const edit = await openEdit(); await expectSources(edit);
          await edit.getByLabel(fields[0], { exact: true }).fill('0');
          await expect(edit.getByRole('alert')).toBeVisible();
          await expect(edit.getByRole('button', { name: '曲げを更新', exact: true })).toBeDisabled();
          if (cancel === 'button') await edit.getByRole('button', { name: '取消', exact: true }).click();
          else await edit.getByLabel(fields[0], { exact: true }).press('Escape');
          await expect(edit).toHaveCount(0);
          expect(await snapshot(`bend-edit-cancel-${cancel}`)).toEqual(placed);
        }
        const edit = await openEdit(); await expectSources(edit);
        const nextConvention = radiusConvention === 'inside' ? 'outside' : 'inside';
        const nextRadius = nextConvention === 'inside' ? 30 : 30 + width;
        await edit.getByRole('combobox', { name: '半径の基準', exact: true }).selectOption(nextConvention);
        await edit.getByLabel(fields[0], { exact: true }).fill(`(${nextRadius}) + 0`);
        await edit.getByLabel(fields[3], { exact: true }).fill(`(${125 + setback}) + 0`);
        token = await beginRecompute(page);
        await edit.getByRole('button', { name: '曲げを更新', exact: true }).click();
        await expect(edit).toHaveCount(0); await waitForRecompute(page, token);
        const edited = await snapshot('bend-edited');
        expect(edited.document).toEqual(placed.document);
        const editedPart = edited.parts.find(item => item.ref === partRef)?.document;
        if (editedPart === undefined) throw new Error('再編集部品がありません');
        expect(editedPart.id).toBe(part.id);
        const stock = part.steelStockSource, updatedStock = editedPart.steelStockSource;
        if (stock === undefined || updatedStock === undefined) throw new Error('元の鋼材出自がありません');
        const { length: oldLength, ...oldOptions } = stock.options;
        const { length: updatedLength, ...updatedOptions } = updatedStock.options;
        expect(oldOptions).toEqual(updatedOptions);
        expect({ ...updatedStock, options: oldOptions }).toEqual({ ...stock, options: oldOptions });
        expect(Number(oldLength)).toBeCloseTo(expected / 300, 12);
        expect(Number(updatedLength)).toBeCloseTo(expected / 300 + 25, 12);
        await bendLifecycleNative(editedPart, expected + 50 * 6 * 25, info);
        token = await beginRecompute(page); await page.getByRole('button', { name: '元に戻す', exact: true }).click();
        await waitForRecompute(page, token); expect(await snapshot('bend-edit-one-undo')).toEqual(placed);
        token = await beginRecompute(page); await page.getByRole('button', { name: 'やり直す', exact: true }).click();
        await waitForRecompute(page, token); expect(await snapshot('bend-edit-redo')).toEqual(edited);
        await openSaveFlowFile(page, info.outputPath('bend-edited.pcada'), app);
        expect(await snapshot('bend-edited-reopened')).toEqual(edited);
        const restored = await openEdit();
        await expect(restored.getByLabel(fields[0], { exact: true })).toHaveValue(`(${nextRadius}) + 0`);
        await expect(restored.getByLabel(fields[3], { exact: true })).toHaveValue(`(${125 + setback}) + 0`);
        await expect(restored.getByRole('combobox', { name: '半径の基準', exact: true })).toHaveValue(nextConvention);
        await restored.getByRole('button', { name: '取消', exact: true }).click();
        expect(errors).toEqual([]);
      });
    }
}

/** 正例とは別identity。実UI作成済文書の元入力だけを壊し、通常のファイル読込→再編集で拒否する。 */
function registerSteelBendRecipeRejections(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined): void {
  for (const reason of ['missing', 'modified', 'unsupported'] as const) {
    test(`EX-07 current recipe rejection ${reason}`, async ({ page }, info) => {
      const app = appForPage(page), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      if (app === undefined) {
        await page.addInitScript(() => {
          for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
          }
        });
        await page.goto('/');
      }
      await waitForStartupReady(page); await resetAssemblyFileGateway(page);
      let token = await beginRecompute(page);
      await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ'); await waitForRecompute(page, token);
      await chooseToolMenuItem(page, '組む', '規格部品');
      const picker = page.getByRole('dialog', { name: '規格部品を置く', exact: true });
      await picker.getByTitle('配置する規格部品の種類を選びます。種類に合わせて寸法の候補が切り替わります。', { exact: true }).selectOption('structuralSection');
      await chooseSteelFlatBar50x6(picker, { grade: 'SS400', size: 'FB 50×6', condition: '熱間圧延材・熱処理条件未指定' });
      await picker.getByRole('checkbox', { name: '曲げ部品を作る', exact: true }).check();
      for (const [name, value] of [['曲げ半径 R (mm)', '30'], ['曲げ角度 (度)', '90'],
        ['第1脚の寸法 (mm)', '100'], ['第2脚の寸法 (mm)', '200']] as const) {
        await picker.getByLabel(name, { exact: true }).fill(value);
      }
      await picker.getByRole('combobox', { name: '半径の基準', exact: true }).selectOption('inside');
      await picker.getByRole('combobox', { name: '脚寸法の基準', exact: true }).selectOption('tangent');
      await picker.getByRole('button', { name: '曲げ部品の配置へ', exact: true }).click();
      const placement = page.getByRole('dialog', { name: '部品を置く位置', exact: true });
      token = await beginRecompute(page); await placement.getByRole('button', { name: '置く', exact: true }).click();
      await waitForRecompute(page, token); await expect(componentRows(page)).toHaveCount(1);
      const read = await readDocumentBundle(await saveFlowFile(page, info.outputPath(`${reason}-valid.pcada`), app), 'assembly');
      if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('負例の元の実UI文書がありません');
      const bundle = read.bundle, source = bundle.document.components[0]?.source;
      if (source?.kind !== 'part') throw new Error('負例の部品参照がありません');
      const embedded = bundle.embeddedDocuments.get(source.partRef);
      if (embedded === undefined) throw new Error('負例の部品原本がありません');
      let changed = 0;
      const solids = embedded.document.solids.map(feature => {
        if (feature.kind !== 'sweep' || feature.steelBend === undefined) return feature;
        changed += 1;
        if (reason === 'missing') { const next = { ...feature }; delete next.steelBend; return next; }
        return { ...feature, steelBend: { ...feature.steelBend,
          ...(reason === 'modified' ? { id: 'unknown-owner' } : { generatorRevision: 'unsupported-current-regression' }) } };
      });
      expect(changed).toBe(1);
      const documents = new Map(bundle.embeddedDocuments);
      documents.set(source.partRef, { ...embedded, document: { ...embedded.document, solids } });
      const corruptPath = info.outputPath(`${reason}-input.pcada`);
      await writeFile(corruptPath, await writeDocumentBundle({ ...bundle, embeddedDocuments: documents }));
      await openSaveFlowFile(page, corruptPath, app);
      const saved = async (name: string) => {
        const result = await readDocumentBundle(await saveFlowFile(page, info.outputPath(`${name}.pcada`), app), 'assembly');
        if (!result.ok || result.bundle.kind !== 'assembly') throw new Error('拒否前後の文書を読めません');
        return { document: result.bundle.document,
          parts: [...result.bundle.embeddedDocuments.entries()].map(([ref, item]) => ({ ref, document: item.document })) };
      };
      const before = await saved(`${reason}-before`);
      await componentRows(page).first().click();
      await chooseToolMenuItem(page, '組む', '規格部品');
      await page.getByRole('dialog', { name: '規格部品を置く', exact: true })
        .getByRole('button', { name: '選択した曲げを再編集', exact: true }).click();
      const edit = page.getByRole('dialog', { name: '曲げの元入力を再編集', exact: true });
      const messages = {
        missing: 'この部品には曲げの元入力が保存されていないため、再編集できません。',
        modified: '曲げの形または材の出自が元入力と対応していないため、再編集できません。',
        unsupported: '保存された曲げの版または材の出自に対応していないため、再編集できません。',
      };
      await expect(edit.getByRole('alert')).toHaveText(messages[reason]);
      await expect(edit.locator('input')).toHaveCount(0);
      await expect(edit.getByRole('button', { name: '曲げを更新', exact: true })).toBeDisabled();
      await edit.getByRole('button', { name: '取消', exact: true }).click();
      expect(await saved(`${reason}-after`)).toEqual(before);
      expect(errors).toEqual([]);
    });
  }
}

/** W01/W04の独立式A×[l1+l2+(Ri+c)θ]。保存した実入力だけを実nativeで再構築する。 */
async function bendLifecycleNative(part: PartDocument, expected: number, info: TestInfo): Promise<void> {
  const native = await createInspectableNativeKernelForNodeTests();
  try {
    let key: string | undefined;
    const result = await recomputePart(part, native.bridge, { onResolved: resolved => { key = resolved.steps.at(-1)?.key; } });
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false); expect(result.bodies).toHaveLength(1);
    if (key === undefined) throw new Error('曲げの実nativeキーがありません');
    const measured = native.inspectShape(key).measure();
    await info.attach('bend-lifecycle-native', { body: JSON.stringify({ expected, measured }), contentType: 'application/json' });
    expect(measured.validity).toMatchObject({ valid: true, solidCount: 1, closed: true });
    expect(measured.meshApproximation).toBeNull(); expect(measured.volume).toBeGreaterThan(0);
    expect(Math.abs(measured.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
  } finally { native.dispose(); }
}
