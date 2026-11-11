import { describe, expect, it } from 'vitest';
import type { SolidFeature } from '@pointercad/model';
import { readHoleFeature, readThreadHoleFeature, serializeHoleFeature, serializeThreadHoleFeature } from './solidHoles.js';

type HoleFeature = Extract<SolidFeature, { readonly kind: 'hole' }>;
type ThreadHoleFeature = Extract<SolidFeature, { readonly kind: 'threadHole' }>;

const base = { id: 'hole-1', name: '穴 1', suppressed: false };
const expression = (source: string, value: number) => ({ source, value, display: source });

/** 円筒の側面(半径 10)を指す保存済みの参照。 */
const sideFace = {
  bodyFeatureId: 'cylinder-1',
  index: 0,
  fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 2513.2741228718346, position: [0, 0, 20], axis: [0, 0, 1], radius: 10 },
} satisfies HoleFeature['face'];

const planar: HoleFeature = {
  ...base,
  kind: 'hole',
  targetFeatureId: 'cylinder-1',
  face: sideFace,
  centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
  diameter: expression('6', 6),
  depth: { kind: 'through' },
  tiltAngle: expression('0', 0),
  tiltAzimuth: expression('0', 0),
};

const cylindrical: HoleFeature = {
  ...planar,
  centers: [],
  depth: { kind: 'blind', depth: expression('3', 3) },
  cylindrical: {
    kind: 'cylinder-face',
    locations: [
      { height: expression('h', 12), angle: expression('0', 0) },
      { height: expression('h + 16', 28), angle: expression('90', 90) },
    ],
  },
};

/** 保存して JSON の文字列へ書き、欄の集まりとして読み戻す(実際の保存と開き直しと同じ道のり)。 */
function savedRecord(feature: HoleFeature): Record<string, unknown> {
  const record: unknown = JSON.parse(JSON.stringify(serializeHoleFeature(feature)));
  if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('保存の形が欄の集まりではありません');
  return Object.fromEntries(Object.entries(record));
}

function reopen(feature: HoleFeature): ReturnType<typeof readHoleFeature> {
  return readHoleFeature(savedRecord(feature), 'solids.0', base);
}

describe('穴の保存(EX05 の円筒の側面)', () => {
  it('円筒の側面の位置(高さ・角度の式)を、並びと式のまま保存して開き直せる', () => {
    const reopened = reopen(cylindrical);
    expect(reopened).toEqual({ ok: true, value: cylindrical });
  });

  it('円筒座ぐりの径・深さと高さ・角度の式を同時に保存し、開き直しても全欄を保つ', () => {
    const feature: HoleFeature = { ...cylindrical,
      entry: { kind: 'counterbore', diameter: expression('d + 2', 8), depth: expression('h / 12', 1) } };
    expect(reopen(feature)).toEqual({ ok: true, value: feature });
    const saved = savedRecord(feature);
    expect(readHoleFeature({ ...saved, entry: { kind: 'counterbore', diameter: expression('8', 8) } }, 'solids.0', base).ok).toBe(false);
  });

  it('平面の穴は欄を持たずに保存され、開き直しても欄が増えない(古いファイルと同じ形)', () => {
    const saved = serializeHoleFeature(planar);
    expect('cylindrical' in saved).toBe(false);
    const reopened = reopen(planar);
    expect(reopened).toEqual({ ok: true, value: planar });
    if (!reopened.ok) throw new Error('読めませんでした');
    expect('cylindrical' in reopened.value).toBe(false);
  });

  it('知らない置き方・式でない高さ・欄の集まりでない位置は読まずに断る', () => {
    const saved = savedRecord(cylindrical);
    const broken: readonly Record<string, unknown>[] = [
      { ...saved, cylindrical: { kind: 'cone-face', locations: [] } },
      { ...saved, cylindrical: { kind: 'cylinder-face', locations: [{ height: 12, angle: expression('0', 0) }] } },
      { ...saved, cylindrical: { kind: 'cylinder-face', locations: [{ height: expression('12', 12) }] } },
      { ...saved, cylindrical: { kind: 'cylinder-face', locations: ['12, 0'] } },
      { ...saved, cylindrical: { kind: 'cylinder-face' } },
      { ...saved, cylindrical: 'cylinder-face' },
    ];
    for (const record of broken) {
      expect(readHoleFeature(record, 'solids.0', base).ok).toBe(false);
    }
  });
});

describe('ねじ穴の保存(EX05 の円筒の側面)', () => {
  const tapBase = { id: 'threadHole-1', name: 'ねじ穴 1', suppressed: false };

  /** M6 のめねじを、円筒の側面の 2 か所へ深さ 8 の止まり穴で切る(実らせん、ねじ部 6)。 */
  const radialTap: ThreadHoleFeature = {
    ...tapBase,
    kind: 'threadHole',
    targetFeatureId: 'cylinder-1',
    face: sideFace,
    centers: [],
    designation: 'M6',
    series: 'coarse',
    pitch: expression('1', 1),
    drillDiameter: expression('4.917', 4.917),
    depth: { kind: 'blind', depth: expression('8', 8) },
    threadLength: expression('6', 6),
    representation: 'modeled',
    tiltAngle: expression('0', 0),
    tiltAzimuth: expression('0', 0),
    cylindrical: {
      kind: 'cylinder-face',
      locations: [
        { height: expression('h', 12), angle: expression('0', 0) },
        { height: expression('h + 16', 28), angle: expression('90', 90) },
      ],
    },
  };

  /** 保存して JSON の文字列へ書き、欄の集まりとして読み戻す(穴の `savedRecord` と同じ道のり)。 */
  function savedTap(feature: ThreadHoleFeature): Record<string, unknown> {
    const record: unknown = JSON.parse(JSON.stringify(serializeThreadHoleFeature(feature)));
    if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('保存の形が欄の集まりではありません');
    return Object.fromEntries(Object.entries(record));
  }

  it('円筒の側面のねじ穴の位置(高さ・角度の式)を、呼び・深さ・ねじ部と一緒に並びと式のまま保存して開き直せる', () => {
    const saved = savedTap(radialTap);
    expect(saved['cylindrical']).toEqual({ kind: 'cylinder-face', locations: [
      { height: expression('h', 12), angle: expression('0', 0) },
      { height: expression('h + 16', 28), angle: expression('90', 90) },
    ] });
    expect(readThreadHoleFeature(saved, 'solids.0', tapBase)).toEqual({ ok: true, value: radialTap });
  });

  it('平面のねじ穴は欄を持たずに保存され、開き直しても欄が増えない(古いファイルと同じ形)', () => {
    const planarTap: ThreadHoleFeature = { ...radialTap, centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }] };
    const { cylindrical: _dropped, ...withoutPlacement } = planarTap;
    expect(_dropped).toBeDefined();
    const saved = savedTap(withoutPlacement);
    expect('cylindrical' in saved).toBe(false);
    const reopened = readThreadHoleFeature(saved, 'solids.0', tapBase);
    expect(reopened).toEqual({ ok: true, value: withoutPlacement });
    if (!reopened.ok) throw new Error('読めませんでした');
    expect('cylindrical' in reopened.value).toBe(false);
  });

  it('知らない置き方・式でない高さ・欄の集まりでない位置は、穴と同じく読まずに断る', () => {
    const saved = savedTap(radialTap);
    const broken: readonly Record<string, unknown>[] = [
      { ...saved, cylindrical: { kind: 'cone-face', locations: [] } },
      { ...saved, cylindrical: { kind: 'cylinder-face', locations: [{ height: 12, angle: expression('0', 0) }] } },
      { ...saved, cylindrical: { kind: 'cylinder-face', locations: [{ height: expression('12', 12) }] } },
      { ...saved, cylindrical: { kind: 'cylinder-face' } },
      { ...saved, cylindrical: 'cylinder-face' },
    ];
    for (const record of broken) {
      expect(readThreadHoleFeature(record, 'solids.0', tapBase).ok).toBe(false);
    }
  });
});

import { appendSolid, createEmptyPartDocument } from '@pointercad/model';
import { reopenBoth } from '../cylindricalMachiningRoundtrip.testSupport.js';

describe('EX-05.PERSIST: exact machining codec roundtrips', () => {
  const locations = [
    { height: expression('13', 13), angle: expression('-413', -413) },
    { height: expression('27', 27), angle: expression('397', 397) },
    { height: expression('13 + 7', 20), angle: expression('720 + 37', 757) },
  ];
  const counterbore = { kind: 'counterbore', diameter: expression('6 + 2', 8), depth: expression('4 / 2', 2) } as const;
  for (const representation of ['simplified', 'modeled'] as const) {
    for (const depth of [{ kind: 'blind', depth: expression('4 + 4', 8) }, { kind: 'through' }] as const) {
      for (const placement of ['planar', 'cylindrical'] as const) {
        it(`${representation}/${depth.kind}/${placement}: preserves counterbore, expressions, order, IDs and references`, () => {
          const feature: ThreadHoleFeature = {
            ...base, kind: 'threadHole', targetFeatureId: 'cylinder-1', face: sideFace,
            centers: placement === 'planar' ? [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }] : [],
            designation: 'M6', series: 'coarse', pitch: expression('1', 1), drillDiameter: expression('4.917', 4.917),
            depth, threadLength: expression('2 * 3', 6), representation, entry: counterbore,
            tiltAngle: expression('0', 0), tiltAzimuth: expression('0', 0),
            ...(placement === 'cylindrical' ? { cylindrical: { kind: 'cylinder-face', locations } as const } : {}),
          };
          const saved = JSON.stringify(serializeThreadHoleFeature(feature));
          const record: unknown = JSON.parse(saved);
          if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('Missing saved object');
          const reopened = readThreadHoleFeature(Object.fromEntries(Object.entries(record)), 'solids.0', base);
          expect(reopened).toEqual({ ok: true, value: feature });
          if (!reopened.ok || reopened.value.kind !== 'threadHole') throw new Error('Thread codec rejected valid feature');
          expect(JSON.stringify(serializeThreadHoleFeature(reopened.value))).toBe(saved);
          reopenBoth(appendSolid(createEmptyPartDocument(), feature));
        });
      }
    }
  }
  for (const placement of ['planar', 'cylindrical'] as const) {
    it(`plain/${placement}: counterbore and unnormalised expressions survive both document codecs`, () => {
      const { cylindrical: dropped, ...legacy } = cylindrical;
      expect(dropped).toBeDefined();
      const feature: HoleFeature = { ...(placement === 'planar' ? { ...legacy, centers: planar.centers } : { ...cylindrical, cylindrical: { kind: 'cylinder-face', locations } }), entry: counterbore };
      const saved = JSON.stringify(serializeHoleFeature(feature));
      const reopened = reopen(feature);
      expect(reopened).toEqual({ ok: true, value: feature });
      if (!reopened.ok || reopened.value.kind !== 'hole') throw new Error('Hole codec rejected valid feature');
      expect(JSON.stringify(serializeHoleFeature(reopened.value))).toBe(saved);
      reopenBoth(appendSolid(createEmptyPartDocument(), feature));
    });
  }
  it('keeps an explicitly empty cylindrical location list for model validation', () => {
    const feature: HoleFeature = { ...cylindrical, cylindrical: { kind: 'cylinder-face', locations: [] } };
    expect(reopen(feature)).toEqual({ ok: true, value: feature });
    reopenBoth(appendSolid(createEmptyPartDocument(), feature));
  });
});

it('EX-05.PERSIST: thread codec keeps an empty location list for model rejection', () => {
  const feature: ThreadHoleFeature = { ...base, kind: 'threadHole', targetFeatureId: 'cylinder-1', face: sideFace,
    centers: [], designation: 'M6', series: 'coarse', pitch: expression('1', 1), drillDiameter: expression('4.917', 4.917),
    depth: { kind: 'blind', depth: expression('8', 8) }, threadLength: expression('6', 6), representation: 'simplified',
    tiltAngle: expression('0', 0), tiltAzimuth: expression('0', 0), cylindrical: { kind: 'cylinder-face', locations: [] } };
  const record = Object.fromEntries(Object.entries(serializeThreadHoleFeature(feature)));
  expect(readThreadHoleFeature(record, 'solids.0', base)).toEqual({ ok: true, value: feature });
  reopenBoth(appendSolid(createEmptyPartDocument(), feature));
});


describe('native planar XY persistence candidate', () => {
  const feature: HoleFeature = { ...planar, centers: [],
    face: { ...sideFace, fingerprint: { ...sideFace.fingerprint, surfaceKind: 'plane', radius: null } },
    planar: { kind: 'plane-face', locations: [
      { x: expression('a * 2', 6), y: expression('-a - 1', -4) },
      { x: expression('-3', -3), y: expression('5', 5) },
    ] } };
  it('roundtrips original expressions, order and face reference; never synthesizes a world point', () => {
    expect(reopen(feature)).toEqual({ ok: true, value: feature });
    expect(savedRecord(feature).centers).toEqual([]);
    expect('planar' in savedRecord(planar)).toBe(false);
    expect(reopen(planar)).toEqual({ ok: true, value: planar });
  });
  it('rejects malformed placement, conflicts, nonfinite values and nonplane references', () => {
    const saved = savedRecord(feature);
    const invalid: Record<string, unknown>[] = [
      { ...saved, centers: planar.centers }, { ...saved, cylindrical: cylindrical.cylindrical },
      { ...saved, planar: null }, { ...saved, planar: { kind: 'world', locations: [] } },
      { ...saved, planar: { kind: 'plane-face', locations: [] } },
      { ...saved, planar: { kind: 'plane-face', locations: [{ x: expression('0', 0) }] } },
      { ...saved, planar: { kind: 'plane-face', locations: [{ x: expression('0', Infinity), y: expression('0', 0) }] } },
      { ...saved, planar: { kind: 'plane-face', locations: [{ x: expression('0', 0), y: expression('0', 0), z: 0 }] } },
      { ...saved, face: sideFace },
    ];
    for (const record of invalid) expect(readHoleFeature(record, 'solids.0', base).ok).toBe(false);
    expect(() => serializeHoleFeature({ ...feature, centers: planar.centers })).toThrow();
  });
});

it('planar thread original XY expressions persist through both document containers', () => {
  const feature: ThreadHoleFeature = { ...base, kind: 'threadHole', targetFeatureId: 'cylinder-1',
    face: { ...sideFace, fingerprint: { ...sideFace.fingerprint, surfaceKind: 'plane', radius: null } },
    centers: [], designation: 'M6', series: 'coarse', pitch: expression('1', 1), drillDiameter: expression('4.917', 4.917),
    depth: { kind: 'blind', depth: expression('8', 8) }, threadLength: expression('6', 6), representation: 'simplified',
    tiltAngle: expression('0', 0), tiltAzimuth: expression('0', 0),
    planar: { kind: 'plane-face', locations: [{ x: expression('a + 1', 6), y: expression('-4', -4) }] } };
  const record = Object.fromEntries(Object.entries(serializeThreadHoleFeature(feature)));
  expect(readThreadHoleFeature(record, 'solids.0', base)).toEqual({ ok: true, value: feature });
  reopenBoth(appendSolid(createEmptyPartDocument(), feature));
});
