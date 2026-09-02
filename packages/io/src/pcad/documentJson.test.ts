import {
  createEmptyPartDocument,
  PART_SCHEMA_VERSION,
  type PartDocument,
  type SketchDocument,
  type SolidFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  parseDocument,
  serializeDocument,
  type ParseDocumentResult,
  type ParseError,
} from './documentJson.js';
import type { ExpressionValueJson } from './guards.js';
import { PCAD_APP_NAME, PCAD_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './schema.js';

/** 検査で時刻を固定する(保存時刻が違っても文字列が同じであることを確かめるため)。 */
const SAVED_AT = '2026-09-03T01:23:45.678Z';

/** 式文字列と評価値の組(FR-202)。 */
function ev(source: string, value: number): ExpressionValueJson {
  return { source, value, display: String(value) };
}

/** 5 種類のスケッチフィーチャーと 3 種類の座標指定、4 種類の基準を全部入れたスケッチ。 */
function richSketch(): SketchDocument {
  return {
    id: 'sketch-1',
    name: 'スケッチ1',
    features: [
      {
        id: 'point-1',
        kind: 'point',
        name: '点1',
        planeId: 'xy',
        at: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      },
      {
        id: 'line-1',
        kind: 'line',
        name: '線分1',
        planeId: 'xy',
        from: {
          mode: 'relative',
          base: { kind: 'previous' },
          dx: ev('40', 40),
          dy: ev('0', 0),
          dz: ev('0', 0),
        },
        to: {
          mode: 'polar',
          base: { kind: 'point', pointId: 'point-1' },
          distance: ev('30', 30),
          azimuth: ev('90', 90),
          elevation: ev('0', 0),
        },
      },
      {
        id: 'arc-1',
        kind: 'arc',
        name: '円弧1',
        planeId: 'xz',
        center: {
          mode: 'relative',
          base: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
          dx: ev('1', 1),
          dy: ev('2', 2),
          dz: ev('3', 3),
        },
        radius: ev('5*2', 10),
        startAngle: ev('0', 0),
        endAngle: ev('360', 360),
      },
      {
        id: 'pointArray-1',
        kind: 'pointArray',
        name: '点列1',
        planeId: 'yz',
        base: {
          mode: 'relative',
          base: { kind: 'origin' },
          dx: ev('0', 0),
          dy: ev('0', 0),
          dz: ev('0', 0),
        },
        azimuth: ev('45', 45),
        spacing: ev('10', 10),
        count: ev('4', 4),
      },
      {
        id: 'face-1',
        kind: 'face',
        name: '面1',
        planeId: 'xy',
        boundary: [{ featureId: 'line-1' }, { featureId: 'pointArray-1', index: 2 }],
        color: '#7aa2f7',
      },
    ],
  };
}

/** 4 種類のソリッドフィーチャーと 2 種類の回転軸。 */
function richSolids(): readonly SolidFeature[] {
  return [
    {
      id: 'extrude-1',
      kind: 'extrude',
      name: '押し出し1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: ev('5*2', 10),
      reversed: false,
      symmetric: true,
    },
    {
      id: 'revolve-1',
      kind: 'revolve',
      name: '回転1',
      suppressed: true,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      axis: { kind: 'world', axis: 'z' },
      angle: ev('360', 360),
      reversed: false,
    },
    {
      id: 'revolve-2',
      kind: 'revolve',
      name: '回転2',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
      angle: ev('90', 90),
      reversed: true,
    },
    {
      id: 'sew-1',
      kind: 'sew',
      name: '縫合1',
      suppressed: false,
      faces: [
        { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
        { sketchId: 'sketch-1', faceFeatureId: 'face-2' },
      ],
      tolerance: ev('0.01', 0.01),
    },
    {
      id: 'union-1',
      kind: 'boolean',
      name: '和1',
      suppressed: false,
      operation: 'union',
      targetFeatureId: 'extrude-1',
      toolFeatureId: 'sew-1',
    },
  ];
}

function richDocument(): PartDocument {
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PART_SCHEMA_VERSION,
    sketches: [richSketch()],
    activeSketchId: 'sketch-1',
    solids: richSolids(),
  };
}

/** 型を通さない生の部品文書。欄の欠落や型違いを自由に作れる。 */
function rawDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PCAD_SCHEMA_VERSION,
    sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: [] }],
    activeSketchId: 'sketch-1',
    solids: [],
    ...overrides,
  };
}

/** 型を通さない生のファイル。 */
function rawFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: PCAD_SCHEMA_VERSION,
    app: PCAD_APP_NAME,
    savedAt: SAVED_AT,
    document: rawDocument(),
    ...overrides,
  });
}

function expectOk(result: ParseDocumentResult): PartDocument {
  if (!result.ok) {
    throw new Error(`読み込みに失敗しました: ${result.error.code} / ${result.error.message}`);
  }
  return result.document;
}

function expectError(result: ParseDocumentResult): ParseError {
  if (result.ok) {
    throw new Error('断るはずの入力を読み込んでしまいました');
  }
  return result.error;
}

/** 保存 → 読み込みの往復。 */
function roundTrip(document: PartDocument): PartDocument {
  return expectOk(parseDocument(serializeDocument(document, { savedAt: SAVED_AT })));
}

describe('.pcad の版(§0.a-0.3、統括の決定④)', () => {
  it('封筒の版は 2 で、部品文書の版と同じ値である', () => {
    expect(PCAD_SCHEMA_VERSION).toBe(2);
    expect(PCAD_SCHEMA_VERSION).toBe(PART_SCHEMA_VERSION);
  });

  it('版を上げる変換表は P2 では空である(版 2 が最新のため)', () => {
    expect(Object.keys(SCHEMA_MIGRATIONS)).toEqual([]);
  });
});

describe('部品文書の書き出し(serializeDocument)', () => {
  it('封筒に版・アプリ名・保存時刻・文書を書く', () => {
    const text = serializeDocument(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(text).toContain(`"app": "${PCAD_APP_NAME}"`);
    expect(text).toContain(`"savedAt": "${SAVED_AT}"`);
  });

  it('インデントは 2 で、末尾に改行が 1 つだけ付く', () => {
    const text = serializeDocument(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text).toContain('\n  "schema"');
  });

  it('保存時刻を渡さなければ今の時刻を ISO 8601 で書く', () => {
    const before = Date.now();
    const text = serializeDocument(createEmptyPartDocument());
    const after = Date.now();
    const savedAt = expectOk(parseDocument(text));
    expect(savedAt.id).toBe('part-1');
    const stamp = /"savedAt": "([^"]+)"/.exec(text);
    expect(stamp).not.toBeNull();
    const at = Date.parse(stamp === null ? '' : stamp[1]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it('封筒と文書の並びが計画書 §2.8 の例のとおりになる', () => {
    const document: PartDocument = {
      id: 'part-1',
      name: '部品1',
      schemaVersion: PART_SCHEMA_VERSION,
      sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: [] }],
      activeSketchId: 'sketch-1',
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: ev('5*2', 10),
          reversed: false,
          symmetric: false,
        },
      ],
    };
    expect(serializeDocument(document, { savedAt: SAVED_AT })).toBe(
      `{
  "schema": 2,
  "app": "PointerCAD",
  "savedAt": "2026-09-03T01:23:45.678Z",
  "document": {
    "id": "part-1",
    "name": "部品1",
    "schemaVersion": 2,
    "sketches": [
      {
        "id": "sketch-1",
        "name": "スケッチ1",
        "features": []
      }
    ],
    "activeSketchId": "sketch-1",
    "solids": [
      {
        "id": "extrude-1",
        "kind": "extrude",
        "name": "押し出し1",
        "suppressed": false,
        "profile": {
          "sketchId": "sketch-1",
          "faceFeatureId": "face-1"
        },
        "distance": {
          "source": "5*2",
          "value": 10,
          "display": "10"
        },
        "reversed": false,
        "symmetric": false
      }
    ]
  }
}
`,
    );
  });

  it('同じ文書からは同じ文字列ができる(決定的)', () => {
    const document = richDocument();
    const first = serializeDocument(document, { savedAt: SAVED_AT });
    const second = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    expect(second).toBe(first);
  });

  it('欄を書いた順が違っても同じ文字列ができる(決定的)', () => {
    const document = richDocument();
    const shuffled: PartDocument = {
      solids: document.solids,
      activeSketchId: document.activeSketchId,
      sketches: document.sketches,
      schemaVersion: document.schemaVersion,
      name: document.name,
      id: document.id,
    };
    expect(serializeDocument(shuffled, { savedAt: SAVED_AT })).toBe(
      serializeDocument(document, { savedAt: SAVED_AT }),
    );
  });

  it('知らない欄は書き出さない(保存し直したときに壊れた組み合わせを書かないため)', () => {
    const document = Object.assign({}, createEmptyPartDocument(), {
      resolvedPoints: [{ x: 1 }],
      cacheKey: 'abcdef',
    });
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    expect(text).not.toContain('resolvedPoints');
    expect(text).not.toContain('cacheKey');
    expect(roundTrip(document)).toEqual(createEmptyPartDocument());
  });
});

describe('往復(serializeDocument → parseDocument)', () => {
  it('空の部品文書が往復で一致する', () => {
    const document = createEmptyPartDocument();
    expect(roundTrip(document)).toEqual(document);
  });

  it('スケッチ 5 種と押し出し・回転・縫合・ブーリアンを含む文書が往復で一致する', () => {
    const document = richDocument();
    expect(roundTrip(document)).toEqual(document);
  });

  it('式は評価値ではなく式文字列のまま往復する(FR-202)', () => {
    const document = roundTrip(richDocument());
    const feature = document.solids[0];
    if (feature.kind !== 'extrude') {
      throw new Error('最初のソリッドは押し出しのはず');
    }
    expect(feature.distance).toEqual({ source: '5*2', value: 10, display: '10' });
  });

  it('面の境界の index は、あるときだけ往復する', () => {
    const document = roundTrip(richDocument());
    const face = document.sketches[0].features[4];
    if (face.kind !== 'face') {
      throw new Error('5 番目の要素は面のはず');
    }
    expect(face.boundary).toEqual([{ featureId: 'line-1' }, { featureId: 'pointArray-1', index: 2 }]);
  });

  it('読み込みは保存時刻も返す(自動保存の案内に使う)', () => {
    const result = parseDocument(serializeDocument(createEmptyPartDocument(), { savedAt: SAVED_AT }));
    if (!result.ok) {
      throw new Error('読み込みに失敗しました');
    }
    expect(result.savedAt).toBe(SAVED_AT);
  });

  it('往復した文書をもう一度書き出すと同じ文字列になる', () => {
    const text = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    const again = serializeDocument(expectOk(parseDocument(text)), { savedAt: SAVED_AT });
    expect(again).toBe(text);
  });
});

describe('読み込みの断り方(FR-504、NFR-UX-5)', () => {
  it('JSON として読めないものは例外にせず理由を返す', () => {
    const error = expectError(parseDocument('{'));
    expect(error.code).toBe('invalidJson');
    expect(error.message).toContain('読み取れませんでした');
  });

  it('空文字列も理由を返す', () => {
    expect(expectError(parseDocument('')).code).toBe('invalidJson');
  });

  it('JSON がオブジェクトでなければ PointerCAD のファイルではないと断る', () => {
    const error = expectError(parseDocument('[1,2,3]'));
    expect(error.code).toBe('notPcad');
    expect(error.message).toContain('PointerCAD の部品ファイルではないようです');
  });

  it('封筒の版が数値でなければ PointerCAD のファイルではないと断る', () => {
    const error = expectError(parseDocument(rawFile({ schema: 'two' })));
    expect(error.code).toBe('notPcad');
  });

  it('アプリ名が違えば PointerCAD のファイルではないと断る', () => {
    const error = expectError(parseDocument(rawFile({ app: 'OtherCAD' })));
    expect(error.code).toBe('notPcad');
    expect(error.message).toContain('PointerCAD の部品ファイルではないようです');
  });

  it('版 3 は「新しい版で保存されています」と断る', () => {
    const error = expectError(parseDocument(rawFile({ schema: 3 })));
    expect(error.code).toBe('unsupportedNewVersion');
    expect(error.message).toContain('新しい版の PointerCAD で保存されています');
    expect(error.message).toContain('3');
  });

  it('版 1 は「対応していない古い版です」と断る', () => {
    const error = expectError(parseDocument(rawFile({ schema: 1 })));
    expect(error.code).toBe('unsupportedOldVersion');
    expect(error.message).toContain('対応していない古い版です');
    expect(error.message).toContain('1');
  });

  it('封筒の版と文書の版が食い違えば断る(封筒の版を先に検査する)', () => {
    const error = expectError(
      parseDocument(rawFile({ document: rawDocument({ schemaVersion: 1 }) })),
    );
    expect(error.code).toBe('versionMismatch');
    expect(error.message).toContain('食い違って');
  });

  it('欄が無ければ、どこが無いかを添えて断る', () => {
    const document = rawDocument();
    delete document['name'];
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.name');
  });

  it('欄の型が違えば、どこが違うかを添えて断る', () => {
    const error = expectError(parseDocument(rawFile({ document: rawDocument({ sketches: {} }) })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.sketches');
  });

  it('深いところの欄の型違いも、その場所を添えて断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: { source: 10, value: 10, display: '10' },
          reversed: false,
          symmetric: false,
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].distance.source');
  });

  it('知らない種類のフィーチャーは断る', () => {
    const document = rawDocument({
      solids: [{ id: 'loft-1', kind: 'loft', name: 'ロフト1', suppressed: false }],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].kind');
  });

  it('保存時刻が文字列でなければ断る', () => {
    const error = expectError(parseDocument(rawFile({ savedAt: 20260903 })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('savedAt');
  });

  it('文書の欄そのものが無ければ断る', () => {
    const file = JSON.stringify({ schema: PCAD_SCHEMA_VERSION, app: PCAD_APP_NAME, savedAt: SAVED_AT });
    const error = expectError(parseDocument(file));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document');
  });
});

describe('読み方の規則(計画書 タスク14)', () => {
  it('知らない欄は捨てて読み込む', () => {
    const document = rawDocument({ foo: 1 });
    const parsed = expectOk(parseDocument(rawFile({ document })));
    expect(serializeDocument(parsed, { savedAt: SAVED_AT })).not.toContain('foo');
    expect(Object.keys(parsed).sort()).toEqual([
      'activeSketchId',
      'id',
      'name',
      'schemaVersion',
      'sketches',
      'solids',
    ]);
  });

  it('式の評価値が数値でなければ NaN として読み、ファイルは開ける(FR-504)', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: { source: '5*2', value: '十', display: '10' },
          reversed: false,
          symmetric: false,
        },
      ],
    });
    const parsed = expectOk(parseDocument(rawFile({ document })));
    const feature = parsed.solids[0];
    if (feature.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(feature.distance.source).toBe('5*2');
    expect(Number.isNaN(feature.distance.value)).toBe(true);
  });

  it('式の評価値の欄そのものが無ければ断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: { source: '5*2', display: '10' },
          reversed: false,
          symmetric: false,
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].distance.value');
  });

  it('読めないフィーチャーが 1 つでもあればファイル全体を断る(半端に開かない)', () => {
    const document = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'point-1',
              kind: 'point',
              name: '点1',
              planeId: 'xy',
              at: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
            },
            { id: 'point-2', kind: 'point', name: '点2', planeId: 'zz' },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.message).toContain('document.sketches[0].features[1]');
  });
});
