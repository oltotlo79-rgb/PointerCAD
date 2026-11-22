import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { describe, expect, it } from 'vitest';
import { partLibraryOfBundle } from '../assembly/documentBundle.js';
import { applyPlacementToDirection } from '../assembly/placementMath.js';
import { partKeyOf, resolveAssembly } from '../assembly/resolveAssembly.js';
import { buildStandardPartFromSource } from '../assembly/standard/buildStandardPart.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import { withinMagnitude } from '../numericTolerance.js';
import { recomputePart } from '../part/recomputePart.js';
import type { PartDocument } from '../part/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { AssemblyExample } from './assemblyExample.js';
import { ASSEMBLY_EXAMPLES } from './assemblyExamples.js';

const relativeTolerance = 1e-9;
const plate = 8 * (60 * 40 - Math.PI * 5 ** 2);
const hexagon = Math.sqrt(3) * 13 ** 2 / 2;
const bolt = hexagon * 5.3 + Math.PI * 4 ** 2 * 30;
const washer = Math.PI * (8 ** 2 - 4.2 ** 2) * 1.6;
const nutBore = 8 - 5 * Math.sqrt(3) * 1.25 / 8;
const nut = (hexagon - Math.PI * (nutBore / 2) ** 2) * 7.5;

// Each T slot removes a 6 x 2 mouth and a trapezoid of depth 4 and widths 12 and 4.
const section = 20 ** 2 - (4 - Math.PI) - 4 * (6 * 2 + 4 * (12 + 4) / 2) - Math.PI * 2.1 ** 2;
const cap = 20 ** 2 * 3;
const Z: Vec3 = [0, 0, 1], X: Vec3 = [1, 0, 0];
interface Occurrence { readonly volume: number; readonly position: Vec3; readonly axis: Vec3 }
const expected: Readonly<Record<AssemblyExample['id'], readonly Occurrence[]>> = {
  boltedPlates: [
    { volume: plate, position: [0, 0, 0], axis: Z }, { volume: plate, position: [0, 0, 8], axis: Z },
    { volume: bolt, position: [0, 0, -1.6], axis: Z }, { volume: washer, position: [0, 0, -1.6], axis: Z },
    { volume: washer, position: [0, 0, 16], axis: Z }, { volume: nut, position: [0, 0, 17.6], axis: Z },
  ],
  aluminumFrame: [
    { volume: section * 200, position: [-100, 0, 0], axis: X },
    { volume: cap, position: [-103, 0, 0], axis: X }, { volume: cap, position: [100, 0, 0], axis: X },
    { volume: section * 200, position: [-100, 0, 120], axis: X },
    { volume: cap, position: [-103, 0, 120], axis: X }, { volume: cap, position: [100, 0, 120], axis: X },
    { volume: section * 100, position: [-90, 0, 10], axis: Z }, { volume: section * 100, position: [90, 0, 10], axis: Z },
  ],
};

async function recomputedVolume(part: PartDocument, bridge: AssemblyKernelBridge, partId: string): Promise<number> {
  try {
    const result = await recomputePart(part, bridge, { partId });
    try {
      expect(result.cancelled).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const [body] = result.bodies;
      expect(body).toMatchObject({ bodyKind: 'solid', isValid: true });
      return body.volume;
    } finally {
      await result.referenceMeshScope?.close();
    }
  } finally {
    await bridge.releasePart(partId);
  }
}

describe('組立の作例', () => {
  it('締結、枠の順に開ける', () => {
    expect(ASSEMBLY_EXAMPLES.map(example => example.id)).toEqual(['boltedPlates', 'aluminumFrame']);
  });

  it.each(ASSEMBLY_EXAMPLES)('$id の各配置で立体を作り直し、位置・向き・体積が手計算と合う', async example => {
    const bundle = await example.create();
    const fresh = await example.create();
    expect(fresh.document).not.toBe(bundle.document);
    expect(fresh.document).toEqual(bundle.document);
    expect(fresh.embeddedDocuments).not.toBe(bundle.embeddedDocuments);
    const library = partLibraryOfBundle(bundle);
    expect(library.parts.size).toBe(example.id === 'boltedPlates' ? 1 : 0);
    const resolved = resolveAssembly(bundle.document, { library, standardPart: buildStandardPartFromSource });
    expect(resolved.errors).toEqual([]);
    const cases = expected[example.id];
    expect(bundle.document.components).toHaveLength(cases.length);
    expect(resolved.partKeys.size).toBe(cases.length);

    const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
    const volumes = new Map<string, number>();
    let total = 0;
    try {
      for (const [index, component] of bundle.document.components.entries()) {
        const key = partKeyOf(component.source);
        const placement = resolved.placements.get(component.id);
        if (placement === undefined) throw new Error(component.id);
        const target = cases[index];
        const axis = applyPlacementToDirection(placement, Z);
        target.position.forEach((value, i) => expect(placement.position[i]).toBeCloseTo(value, 9));
        target.axis.forEach((value, i) => expect(axis[i]).toBeCloseTo(value, 9));
        let volume = volumes.get(key);
        if (volume === undefined) {
          const source = component.source;
          const part = source.kind === 'part' ? library.parts.get(source.partRef)
            : source.kind === 'standardPart' ? buildStandardPartFromSource(source) : undefined;
          if (part == null) throw new Error(key);
          volume = await recomputedVolume(part, bridge, component.id);
          volumes.set(key, volume);
        }
        expect(withinMagnitude(volume - target.volume, relativeTolerance * target.volume), key).toBe(true);
        total += volume;
      }
      const reference = cases.reduce((sum, item) => sum + item.volume, 0);
      expect(withinMagnitude(total - reference, relativeTolerance * reference)).toBe(true);
    } finally {
      bridge.dispose();
    }
  }, 180_000);
});
