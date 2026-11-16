/**
 * 解析から外した部品の質量(standardBeamAdapter の excludedParts): 族が 1 個の質量を持つ部品(製造元の寸法に合わせたフレームの系列の
 * 単位質量 × 長さ)は、その質量で数える。持たない部品(規格部品のボルトなど)は今の体積 × 密度のまま。ボディが無い部品は今と同じく分からない(null)。
 */
import { describe, expect, it } from 'vitest';

import { PRODUCT_CATALOG_REGISTRY } from '../assembly/catalog/registry.js';
import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import type { AssemblyComponent } from '../assembly/types.js';
import { weldTestBody } from '../assembly/welding/filletWeld.testSupport.js';
import { beamCadFixture, testComponent } from './beamInputs.testSupport.js';
import { standardMembersToBeamAnalysis } from './standardBeamAdapter.js';

describe('解析から外した部品の質量と、族が持つ 1 個の質量', () => {
  it('フレームの系列の部品は単位質量 × 長さで数え、ボルトは体積 × 密度のまま、ボディの無い部品は分からないまま', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-series']);
    const fixture = beamCadFixture();
    const frame: AssemblyComponent = { ...testComponent('frame'), source: createStandardPartSource('catalogItem', '溝幅 6 20×20',
      { family: 't-slot-frame-series', item: 's6-20x20', length: '750' }) };
    const bolt: AssemblyComponent = { ...testComponent('bolt'), source: createStandardPartSource('hexBolt', 'M6', { length: '20' }) };
    const document = { ...fixture.document, components: [...fixture.document.components, frame, bolt] };
    const bodies = new Map([
      [partKeyOf(frame.source), [{ ...weldTestBody([], []), volume: 160000 }]],
      [partKeyOf(bolt.source), [{ ...weldTestBody([], []), volume: 1000 }]],
    ]);
    const result = standardMembersToBeamAnalysis(document, fixture.definition, { currentSource: fixture.stamp, bodies, assemblyOptions: {} });
    if (!result.ok) throw new Error(result.issue.message);
    const byKind = new Map(result.excludedParts.map((part) => [part.kind, part]));
    expect(byKind.get('catalogItem')?.count).toBe(1);
    expect(byKind.get('catalogItem')?.massKg).toBeCloseTo(0.49 * 750 / 1000, 12);
    // ボルトは今の検査と同じ値(体積 1000 mm³ × 鋼 7.85 g/cm³ = 7.85 g)。
    expect(byKind.get('hexBolt')?.massKg).toBeCloseTo(0.00785, 12);
    const withoutBodies = standardMembersToBeamAnalysis(document, fixture.definition, { currentSource: fixture.stamp,
      bodies: new Map([[partKeyOf(bolt.source), [{ ...weldTestBody([], []), volume: 1000 }]]]), assemblyOptions: {} });
    if (!withoutBodies.ok) throw new Error(withoutBodies.issue.message);
    expect(withoutBodies.excludedParts.find((part) => part.kind === 'catalogItem')?.massKg).toBeNull();
  });
});
