import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { writePcadFile, type PcadAttachments } from '../../packages/io/src/index.js';
import { createEmptyPartDocument, type PartDocument } from '../../packages/model/src/index.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import { writeBrepBytes } from '../../packages/kernel/src/occt/brepBytes.js';
import { readRecomputeStats } from './recompute.js';
import { readPart } from './canvasAssetLifetimeFlow.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

/** 同じrefのA/Bを実OCCTから作る。任意bytesを形状として通さない。 */
async function fixture(name: string, size: number) {
  const oc = await loadOcctForNode(), maker = new oc.BRepPrimAPI_MakeBox_2(size, size, size);
  const shape = maker.Shape();
  let bytes: Uint8Array;
  try { bytes = writeBrepBytes(oc, shape); } finally { shape.delete(); maker.delete(); }
  const mesh = { positions: Float32Array.of(0, 0, size + 1, size, 0, size + 1, 0, size, size + 1),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) };
  const document: PartDocument = { ...createEmptyPartDocument(), name, solids: [
    { kind: 'importedSolid', id: 'solid-1', name: `${name} BRep`, shapeRef: 'shared', suppressed: false, bodyKind: 'solid',
      source: { format: 'step', fileName: `${name}.step`, unit: 'mm', byteLength: bytes.byteLength } },
    { kind: 'importedMesh', id: 'mesh-1', name: `${name} mesh`, meshRef: 'shared', suppressed: false, triangleCount: 1,
      source: { format: 'stl', fileName: `${name}.stl`, unit: 'mm', byteLength: 84 } },
  ] };
  const attachments: PcadAttachments = { shapes: new Map([['shared', bytes]]), meshes: new Map([['shared', mesh]]), canvases: new Map() };
  return { document, attachments, bytes: writePcadFile(document, { attachments }), volume: size ** 3 };
}

async function expectVolume(page: Page, name: string, volume: number): Promise<void> {
  const section = page.locator('.pcad-panel--left .pcad-tree__sections > li').filter({ hasText: 'ソリッド' });
  const header = section.locator('.pcad-tree__row--section').first();
  if (await header.getAttribute('aria-expanded') === 'false') await header.click();
  await section.locator('.pcad-tree__row--child').filter({ hasText: `${name} BRep` }).click();
  const value = page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]');
  await expect(value).toHaveText(`${volume} mm³`);
}

/**
 * 実open→Undo/Redo→save/reopenのbytesと実形状をChromium/Firefox/Electron共通で照合。
 * 開いた文書は新しい履歴から始まる(2026-10-05)ので、Undo/Redo で前に開いた部品へ戻らず、
 * 計算も起きない。保存は開いた部品の BRep/mesh だけを持つ。
 */
export async function partAssetLifetimeFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await waitForStartupHealth(page, info);
  const a = await fixture('A', 20), b = await fixture('B', 40);
  const aPath = info.outputPath('A.pcad'), bPath = info.outputPath('B.pcad');
  await writeFile(aPath, a.bytes); await writeFile(bPath, b.bytes);
  async function saved(expected: typeof a, stage: string): Promise<string> {
    const path = info.outputPath(`${stage}.pcad`), read = readPart(await saveFlowFile(page, path, app));
    expect(read.document.name).toBe(expected.document.name);
    expect(read.attachments.shapes.size).toBe(1); expect(read.attachments.meshes.size).toBe(1);
    expect(read.document.solids.map(feature => feature.id)).toEqual(['solid-1', 'mesh-1']);
    for (const feature of read.document.solids) {
      if (feature.kind === 'importedSolid') expect(read.attachments.shapes.get(feature.shapeRef)).toEqual(expected.attachments.shapes.get('shared'));
      else if (feature.kind === 'importedMesh') expect(read.attachments.meshes.get(feature.meshRef)).toEqual(expected.attachments.meshes.get('shared'));
      else throw new Error('Unexpected saved feature');
    }
    return path;
  }
  await openSaveFlowFile(page, aPath, app); await expectVolume(page, 'A', a.volume);
  await openSaveFlowFile(page, bPath, app); await expectVolume(page, 'B', b.volume);
  await saved(b, 'opened-B');
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  await expect(undo).toBeDisabled();
  let stats = await readRecomputeStats(page);
  await page.keyboard.press('Control+z'); await expectVolume(page, 'B', b.volume);
  await saved(b, 'undo-stays-B');
  await page.keyboard.press('Control+y'); await expectVolume(page, 'B', b.volume);
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(stats.requestedGeneration);
  const savedB = await saved(b, 'redo-stays-B');
  await openSaveFlowFile(page, savedB, app); await expectVolume(page, 'B', b.volume); await saved(b, 'reopened-B');
  await expect(undo).toBeDisabled();
  stats = await readRecomputeStats(page);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await expectVolume(page, 'B', b.volume);
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(stats.requestedGeneration);
  await saved(b, 'reopened-undo-stays-B');
  await page.screenshot({ path: info.outputPath('part-assets-reopened-B.png') });
}
