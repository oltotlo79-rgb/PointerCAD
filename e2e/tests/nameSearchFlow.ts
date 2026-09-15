import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  absoluteCoordinate, createPointFeature, createEmptyPartDocument, createPrimitiveFeature, createAssemblyDocument,
  createAssemblyDocumentBundle, createComponentFor, addComponent, emptyEmbeddedPartAttachments, type PartDocument,
} from '../../packages/model/src/index.js';
import { writeDocumentBundle, writePcadFile } from '../../packages/io/src/index.js';
import { reopenPart } from './reopenPart.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { readAssemblyStats } from './assemblyTestSupport.js';

const rowForKey = (panel: Locator, key: string) => panel.locator(`[data-name-search-key=${JSON.stringify(key)}]`);
async function choose(panel: Locator, query: string, afterCancel?: () => Promise<void>): Promise<void> {
  const search = panel.getByRole('searchbox');
  await search.fill(query); await expect(panel.locator('.pcad-name-search li button')).toHaveCount(1);
  await search.press('ArrowDown'); await expect(panel.locator('.pcad-name-search li button')).toBeFocused();
  await search.press('Escape'); await expect(search).toHaveValue('');
  await afterCancel?.();
  await search.fill(query); await panel.locator('.pcad-name-search li button').click();
  await expect(search).toHaveValue('');
}

export async function partNameSearchFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const empty = createEmptyPartDocument(), first = empty.sketches[0];
  const targetId = 'search-point-198', source = createPointFeature(first, absoluteCoordinate(0, 0, 0));
  const points = Array.from({ length: 199 }, (_, index) => ({ ...source, id: `search-point-${index}`,
    name: index === 198 ? '共有点' : `確認点${index}`, at: absoluteCoordinate(index, 0, 0) }));
  const document: PartDocument = { ...empty, sketches: [
    { ...first, name: '正面', features: [{ ...source, id: targetId, name: '共有点' }] },
    { ...first, id: 'side', name: '側面', features: points },
  ], featureFolders: [
    { id: 'outside', name: '側面の作図', children: [{ kind: 'folder', id: 'inside' }] },
    { id: 'inside', name: '点の一覧', children: [{ kind: 'sketch', id: 'side' }] },
  ] };
  await writeFile(info.outputPath('search-200.pcad'), writePcadFile(document), { flag: 'wx' });
  await reopenPart(page, info, 'search-200.pcad', app);
  const panel = page.locator('.pcad-panel--left'), search = panel.getByRole('searchbox');
  const target = rowForKey(panel, JSON.stringify(['sketch-feature', 'side', targetId]));
  await expect(target).not.toBeInViewport();
  await panel.getByRole('button', { name: '側面の作図', exact: true }).click(); await expect(target).toHaveCount(0);
  const token = await beginRecompute(page);
  await search.fill('共有点'); await expect(panel.locator('.pcad-name-search li button')).toHaveCount(2);
  await search.press('Escape'); await expect(search).toHaveValue('');
  await choose(panel, '側面 共有点', async () => {
    expect((await readRecomputeStats(page)).requestedGeneration).toBe(token.requestedGeneration);
  });
  // 別スケッチの選択は既存のsetActiveSketchを通し、作図面とresolvedSketchを更新する。
  // 検索・取消では0回、所属を確定した時だけ1回の正常終了を要求する。
  await waitForRecompute(page, token);
  await expect(target).toBeInViewport(); await expect(target.locator('.pcad-tree__select')).toHaveAttribute('aria-pressed', 'true');
  const other = rowForKey(panel, JSON.stringify(['sketch-feature', first.id, targetId]));
  await expect(other.locator('.pcad-tree__select')).toHaveAttribute('aria-pressed', 'false');
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(token.requestedGeneration + 1);
  const saved = await savePart(page, info, 'search-selected.pcad', app);
  expect(saved.sketches).toEqual(document.sketches); expect(saved.featureFolders).toEqual(document.featureFolders);
  expect(saved.activeSketchId).toBe('side');
}

export async function assemblyNameSearchFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const emptyPart = createEmptyPartDocument(), part = { ...emptyPart, solids: [createPrimitiveFeature(emptyPart, 'box')] };
  const source = { kind: 'part' as const, partRef: 'part-1' };
  let nested = createAssemblyDocument('奥の組立');
  nested = addComponent(nested, { ...createComponentFor(nested, source, { name: '同名部品' }), visible: false });
  nested = addComponent(nested, { ...createComponentFor(nested, source, { name: '別の部品' }), fixed: true });
  let assembly = createAssemblyDocument('検索する組立');
  for (let index = 0; index < 48; index += 1) assembly = addComponent(assembly,
    { ...createComponentFor(assembly, source, { name: index === 0 ? '同名部品' : `通常部品${index}` }), fixed: true });
  const parent = createComponentFor(assembly, { kind: 'subAssembly', assemblyRef: 'nested-1' }, { name: '奥の組立' });
  assembly = addComponent(assembly, { ...parent, fixed: true });
  const bundle = createAssemblyDocumentBundle(assembly, { partFiles: [], parts: new Map([['part-1', part]]),
    attachments: new Map([['part-1', emptyEmbeddedPartAttachments()]]), assemblies: new Map([['nested-1', nested]]) });
  await writeFile(info.outputPath('search-50.pcada'), await writeDocumentBundle(bundle), { flag: 'wx' });
  await reopenPart(page, info, 'search-50.pcada', app);
  const panel = page.locator('.pcad-panel--left'), search = panel.getByRole('searchbox');
  const targetKey = `component:${parent.id}/${nested.components[0].id}`, target = rowForKey(panel, targetKey);
  await expect(target).not.toBeInViewport();
  const parentRow = rowForKey(panel, `component:${parent.id}`);
  await parentRow.locator('.pcad-tree__branch-toggle').click(); await expect(target).toHaveCount(0);
  await panel.locator('.pcad-tree__sections > li').filter({ has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }) })
    .locator('.pcad-tree__row--section').click();
  const before = await readAssemblyStats(page);
  await search.fill('同名部品'); await expect(panel.locator('.pcad-name-search li button')).toHaveCount(2);
  await search.press('Escape'); await expect(search).toHaveValue('');
  await choose(panel, '奥の組立 同名部品');
  await expect(target).toBeInViewport(); await expect(target.locator('.pcad-tree__select')).toHaveAttribute('aria-pressed', 'true');
  await expect(rowForKey(panel, `component:${assembly.components[0].id}`).locator('.pcad-tree__select')).toHaveAttribute('aria-pressed', 'false');
  await expect(target).toContainText('非表示');
  expect(await readAssemblyStats(page)).toEqual(before);
}
