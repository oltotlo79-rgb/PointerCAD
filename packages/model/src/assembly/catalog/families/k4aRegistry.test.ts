/**
 * 包み K4a の族(カムフォロア・巻きブシュ)が製品の登録口から読め、保存の形・組み立て・体積・拒否が製品の道
 * (`buildStandardPartFromSource`・`standardPartRejection`・`standardPartNominalVolume`・`resolveAssembly`)で働く事。
 */
import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from '../../assemblyEdit.js';
import { createAssemblyDocument } from '../../createAssemblyDocument.js';
import { resolveAssembly } from '../../resolveAssembly.js';
import {
  buildStandardPartFromSource, createStandardPartSource, standardPartNominalVolume, standardPartRejection,
} from '../../standard/buildStandardPart.js';
import { PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { K4A_CATALOG_FAMILIES } from '../registry/k4a.js';
import { createCatalogItemSource } from '../source.js';
import { CAM_FOLLOWER_FAMILY } from './camFollower.js';
import { WRAPPED_BUSH_FAMILY } from './wrappedBush.js';

const CAM_FOLLOWER_ROWS = CAM_FOLLOWER_FAMILY.rows;
const WRAPPED_BUSH_ROWS = WRAPPED_BUSH_FAMILY.rows;

const FAMILIES = [CAM_FOLLOWER_FAMILY, WRAPPED_BUSH_FAMILY];

describe('K4a の族の登録と製品の道', () => {
  it('K4a の一覧は 2 族で、製品の登録口に入り、読み込むまでは「読み込み中」の型付きの拒否になる', async () => {
    expect(K4A_CATALOG_FAMILIES.map((entry) => [entry.id, entry.group, entry.kindKey])).toEqual([
      ['cam-follower-stud-metric', 'mechanical', 'catalog.mechanical.kind.camFollower'],
      ['wrapped-bush', 'mechanical', 'catalog.mechanical.kind.wrappedBush'],
    ]);
    for (const entry of K4A_CATALOG_FAMILIES) expect(PRODUCT_CATALOG_REGISTRY.entry(entry.id)).toBe(entry);
    const saved = createCatalogItemSource(CAM_FOLLOWER_FAMILY, CAM_FOLLOWER_ROWS[0]);
    expect(standardPartRejection(saved)?.code).toBe('family-not-loaded');
    expect(buildStandardPartFromSource(saved)).toBeNull();
    await PRODUCT_CATALOG_REGISTRY.ensure(K4A_CATALOG_FAMILIES.map((entry) => entry.id));
    expect(PRODUCT_CATALOG_REGISTRY.loaded('cam-follower-stud-metric')).toBe(CAM_FOLLOWER_FAMILY);
    expect(PRODUCT_CATALOG_REGISTRY.loaded('wrapped-bush')).toBe(WRAPPED_BUSH_FAMILY);
    expect(standardPartRejection(saved)).toBeNull();
  });

  it('保存の形は族・行の鍵と版だけで、寸法・出どころを持たない', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(FAMILIES.map((family) => family.id));
    const cam = createCatalogItemSource(CAM_FOLLOWER_FAMILY, CAM_FOLLOWER_ROWS[2]);
    expect(JSON.stringify(cam)).toBe('{"kind":"standardPart","catalog":"catalogItem","size":"D16","options":'
      + '{"family":"cam-follower-stud-metric","item":"D16"},"catalogRevision":"cam-follower-2026-11-r1",'
      + '"generatorRevision":"cam-follower-1"}');
    const bushRow = WRAPPED_BUSH_ROWS.find((row) => row.key === 'd15-L8');
    if (bushRow === undefined) throw new Error('d15-L8 row');
    const bush = createCatalogItemSource(WRAPPED_BUSH_FAMILY, bushRow);
    expect(JSON.stringify(bush)).toBe('{"kind":"standardPart","catalog":"catalogItem","size":"15×17×8","options":'
      + '{"family":"wrapped-bush","item":"d15-L8"},"catalogRevision":"wrapped-bush-2026-11-r1","generatorRevision":"bush-1"}');
    for (const text of [JSON.stringify(cam), JSON.stringify(bush)]) {
      expect(text).not.toMatch(/sha256|https?:|steel|資料/u);
    }
    // 呼びと options だけの生成口(既存の createStandardPartSource)も同じ形を返す。
    expect(createStandardPartSource('catalogItem', 'D16', cam.options)).toEqual(cam);
  });

  it('全ての行が製品の道で組め、体積は族の台本の値で、アセンブリに置くと部品になる', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(FAMILIES.map((family) => family.id));
    let assembly = createAssemblyDocument('機械要素');
    for (const family of FAMILIES) {
      for (const row of family.rows) {
        const source = createCatalogItemSource(family, row);
        expect(buildStandardPartFromSource(source)?.name).toBe(family.partName(row, {}));
        expect(standardPartNominalVolume('catalogItem', row.size, source.options)).toBe(family.nominalVolume(row, {}));
      }
      assembly = addComponent(assembly, createComponentFor(assembly, createCatalogItemSource(family, family.rows[0]),
        { partName: family.partName(family.rows[0], {}) }));
    }
    const resolved = resolveAssembly(assembly, { standardPart: buildStandardPartFromSource });
    expect(resolved.errors).toEqual([]);
    expect(resolved.parts.size).toBe(2);
  });

  it('呼びの食い違い・知らない行・版の違い・余計な指定は、黙って別の部品にせず型付きの拒否になる', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(FAMILIES.map((family) => family.id));
    const saved = createCatalogItemSource(WRAPPED_BUSH_FAMILY, WRAPPED_BUSH_ROWS[0]);
    expect(standardPartRejection({ ...saved, size: '3×5×4' })?.code).toBe('saved-fields-mismatch');
    expect(standardPartRejection({ ...saved, options: { ...saved.options, item: 'd3-L7' } })?.code).toBe('unknown-item');
    expect(standardPartRejection({ ...saved, catalogRevision: 'wrapped-bush-2026-12-r2' })?.code)
      .toBe('unsupported-catalog-revision');
    expect(standardPartRejection({ ...saved, options: { ...saved.options, length: '8' } })?.code)
      .toBe('saved-fields-mismatch');
    expect(buildStandardPartFromSource({ ...saved, size: '3×5×4' })).toBeNull();
  });
});
