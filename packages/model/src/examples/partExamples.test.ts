import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { describe, expect, it } from 'vitest';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { analyzeParameters } from '../parameters/parameterTable.js';
import { createDefaultConfigurations } from '../part/configurationDefaults.js';
import { createEmptyPartDocument, liveBodyIds } from '../part/createPartDocument.js';
import { recomputePart } from '../part/recomputePart.js';
import { reevaluatePartDocument } from '../part/reevaluatePart.js';
import type { PartExampleId } from './partExample.js';
import { PART_EXAMPLES } from './partExamples.js';

const HISTORY: Readonly<Record<PartExampleId, readonly string[]>> = {
  plateWithHole: ['extrude', 'hole'],
  flange: ['revolve', 'chamfer', 'hole', 'hole', 'pattern'],
  spring: ['spring'],
  parameterBox: ['extrude', 'hole'],
  saddleSurface: ['functionSurface'],
  shelledBox: ['extrude', 'fillet', 'shell'],
};

describe('作例の集まり(J-06b)', () => {
  it('設計の 6 本を、一覧に出す順で持つ', () => {
    expect(PART_EXAMPLES.map(example => example.id)).toEqual(
      ['plateWithHole', 'flange', 'spring', 'parameterBox', 'saddleSurface', 'shelledBox']);
  });

  it.each(PART_EXAMPLES.map(example => [example.id, example] as const))(
    '%s は呼ぶたびに同じ中身の新しい文書を作り、空の部品と同じ素性と欄を持つ', (id, example) => {
      const part = example.create();
      const fresh = example.create();
      const empty = createEmptyPartDocument();
      expect(fresh).not.toBe(part);
      expect(fresh).toStrictEqual(part);
      expect(part.id).toBe(empty.id);
      expect(part.name).toBe(empty.name);
      expect(part.schemaVersion).toBe(empty.schemaVersion);
      expect(Object.keys(part).sort()).toEqual(Object.keys(empty).sort());
      expect(part.solids.map(feature => feature.kind)).toEqual(HISTORY[id]);
      expect(liveBodyIds(part)).toHaveLength(1);
      const parsed: unknown = JSON.parse(JSON.stringify(part));
      expect(parsed).toStrictEqual(part);
    });

  it.each(PART_EXAMPLES.map(example => [example.id, example] as const))(
    '%s の保存した値は、係数の表と式から計算し直した値と同じ', (_id, example) => {
      const part = example.create();
      // The default configuration carries every parameter's source (the file reader refuses a mismatch).
      expect(part.configurations).toEqual(createDefaultConfigurations(part.parameters));
      const analysis = analyzeParameters(part.parameters, []);
      expect(analysis.failures).toEqual([]);
      const evaluation = reevaluatePartDocument(part, analysis.variables, analysis);
      expect(evaluation.failures).toEqual([]);
      // Nothing to replace: every stored value already equals its formula's value.
      expect(evaluation.document).toBe(part);
    });

  it('係数で動く箱は、幅・奥行・高さ・穴径の 4 つの係数を式でつなぐ', () => {
    const part = PART_EXAMPLES.find(example => example.id === 'parameterBox')?.create();
    expect(part?.parameters.map(parameter => [parameter.name, parameter.value.source, parameter.value.value])).toEqual([
      ['幅', '80', 80], ['奥行', '幅 / 2', 40], ['高さ', '20', 20], ['穴径', '奥行 / 4', 10],
    ]);
  });
});

/** Closed-form references. Each B-rep is compared with the relative bound named in its case. */
const SOLID_CASES = [
  {
    id: 'plateWithHole', volumeMm3: 8 * (60 * 40 - Math.PI * 5 ** 2), relative: 1e-9,
    cylinders: [[0, 0, 5]],
  },
  {
    id: 'flange',
    // The bottom millimetre is a frustum (radii 39 and 40). The other 19 mm are cylindrical.
    volumeMm3: Math.PI * (19 * 40 ** 2 + (39 ** 2 + 39 * 40 + 40 ** 2) / 3 - 20 * (12 ** 2 + 4 * 4 ** 2)), relative: 1e-9,
    cylinders: [[0, 0, 40], [0, 0, 12], [28, 0, 4], [0, 28, 4], [-28, 0, 4], [0, -28, 4]],
  },
  {
    // V = π(d/2)² · n · √((πD)² + p²). The kernel's own spring check allows 0.5 % for the swept B-spline.
    id: 'spring', volumeMm3: Math.PI * 1 ** 2 * 4 * Math.hypot(Math.PI * 20, 5), relative: 0.005,
    cylinders: [],
  },
  {
    id: 'parameterBox', volumeMm3: 20 * (80 * 40 - Math.PI * 5 ** 2), relative: 1e-9,
    cylinders: [[0, 0, 5]],
  },
  {
    // Outer section 60 x 40 with R5 corners; the cavity is offset 2 mm inwards (R3 corners) and 28 mm deep.
    id: 'shelledBox', volumeMm3: 30 * (60 * 40 - (4 - Math.PI) * 5 ** 2) - 28 * (56 * 36 - (4 - Math.PI) * 3 ** 2),
    relative: 1e-9,
    cylinders: [[25, 15, 5], [-25, 15, 5], [-25, -15, 5], [25, -15, 5], [25, 15, 3], [-25, 15, 3], [-25, -15, 3], [25, -15, 3]],
  },
] as const;

describe.each(SOLID_CASES)('作例 $id を実際の計算部で作り直す', ({ id, volumeMm3, relative, cylinders }) => {
  it('作り直しの失敗が無く、1 つの立体の体積と円筒の面が設計どおり', async () => {
    const example = PART_EXAMPLES.find(entry => entry.id === id);
    if (example === undefined) throw new Error(`作例 ${id} がありません`);
    const part = example.create();
    const api = createKernelApi(loadOcctForNode);
    const bridge = createDirectKernelBridge(api);
    try {
      const result = await recomputePart(part, bridge, { partId: id });
      try {
        expect(result.cancelled).toBe(false);
        expect(result.errors).toEqual([]);
        expect(result.bodies).toHaveLength(1);
        const [body] = result.bodies;
        expect(body.featureId).toBe(part.solids.at(-1)?.id);
        expect(body.isValid).toBe(true);
        expect(body.bodyKind).toBe('solid');
        expect(Math.abs(body.volume - volumeMm3)).toBeLessThanOrEqual(relative * volumeMm3);
        const axes = body.faces.filter(face => face.surfaceKind === 'cylinder')
          .map(face => [face.axisOrigin?.[0], face.axisOrigin?.[1], face.radius]);
        if (id !== 'spring') expect(axes).toHaveLength(cylinders.length);
        for (const [x, y, radius] of cylinders) {
          expect(axes).toContainEqual([expect.closeTo(x, 8), expect.closeTo(y, 8), expect.closeTo(radius, 8)]);
        }
        if (id === 'flange') {
          // Both ends of the lower C1 cone must be present. A bevel on the opposite end has the same volume.
          const rims = body.edges.filter(edge => edge.curveKind === 'circle').map(edge => [edge.radius, edge.midpoint[2]]);
          expect(rims).toContainEqual([expect.closeTo(39, 8), expect.closeTo(0, 8)]);
          expect(rims).toContainEqual([expect.closeTo(40, 8), expect.closeTo(1, 8)]);
        }
      } finally {
        await result.referenceMeshScope?.close();
      }
    } finally {
      await api.releasePart(id);
      bridge.dispose();
    }
  }, 180_000);
});
