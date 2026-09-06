import { describe, expect, it } from 'vitest';

import type { SolidBody, SolidBodyKind } from '../kernelBridge.js';

import {
  acceptsMeshBody,
  acceptsShellBody,
  canRoundTrip,
  carriesColor,
  checkExportBodyKind,
  exportDeviationMm,
  exportMeshQuality,
  selectExportBodies,
  usesTriangles,
} from './exportPart.js';
import {
  createExportRequest,
  DEFAULT_EXPORT_ASCII,
  DEFAULT_EXPORT_QUALITY,
  DEFAULT_EXPORT_SCOPE,
  DEFAULT_EXPORT_WITH_COLORS,
  EXPORT_DEVIATION_MM,
  EXPORT_FORMATS,
  EXPORT_MESH_QUALITY,
  EXPORT_QUALITIES,
  FILE_KINDS,
  IMPORT_FORMATS,
  type ExportFormat,
  type ExportQuality,
  type FileKind,
} from './types.js';

/**
 * 立体 1 つの見本。書き出す対象の選び分けが見るのは `featureId` と `bodyKind` だけなので、
 * 形の中身(三角形・面・辺)は最小限にしてある。
 *
 * **読み込んだ三角形の形(`'mesh'`)のボディは `importedMesh` フィーチャー(P6 タスク20)
 * でしか作れず、ここでは見本を作れない**ので、種類ごとの可否は `checkExportBodyKind`
 * の表(下の「形式 × 立体の種類」)で固定する。
 */
function makeBody(featureId: string, bodyKind: SolidBodyKind): SolidBody {
  return {
    featureId,
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      triangleCount: 1,
    },
    volume: 1000,
    isValid: true,
    bodyKind,
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

const THREE_SOLIDS: readonly SolidBody[] = [
  makeBody('f1', 'solid'),
  makeBody('f2', 'solid'),
  makeBody('f3', 'solid'),
];

describe('書き出す対象の決め方(FR-427、FR-803、計画書 P6 タスク2)', () => {
  it('ソリッド 3 つを「すべて」で STEP に出すと 3 つとも選ばれる', () => {
    const outcome = selectExportBodies(THREE_SOLIDS, createExportRequest('step'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.featureIds]).toEqual(['f1', 'f2', 'f3']);
  });

  it('「選んだ立体」で 1 つだけ選ぶと 1 つだけ選ばれる(FR-427)', () => {
    const outcome = selectExportBodies(
      THREE_SOLIDS,
      createExportRequest('step', { scope: 'selected', selectedFeatureIds: ['f2'] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.featureIds]).toEqual(['f2']);
  });

  it('「選んだ立体」で 1 つも当たらなければ書き出せる立体が無い(§2.8)', () => {
    const outcome = selectExportBodies(
      THREE_SOLIDS,
      createExportRequest('stl', { scope: 'selected', selectedFeatureIds: ['無い id'] }),
    );
    expect(outcome).toEqual({ ok: false, reason: 'nothingToExport' });
  });

  it('立体が 1 つも無ければ書き出せる立体が無い(§2.8)', () => {
    expect(selectExportBodies([], createExportRequest('stl'))).toEqual({
      ok: false,
      reason: 'nothingToExport',
    });
  });

  it('面だけの立体を含めて STL に出すと、その立体だけを弾いて警告する(§0.a-0.12)', () => {
    const bodies = [makeBody('f1', 'solid'), makeBody('f2', 'shell')];
    const outcome = selectExportBodies(bodies, createExportRequest('stl'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.featureIds]).toEqual(['f1']);
    // 弾いた立体の知らせが先、効かない指定(STL には色が無い)の知らせが後。
    expect([...outcome.selection.warnings]).toEqual(['shellNotSupported', 'colorNotSupported']);
  });

  it('面だけの立体しか無いまま STL に出そうとすると shellNotSupported で断る(§2.8)', () => {
    const outcome = selectExportBodies([makeBody('f1', 'shell')], createExportRequest('stl'));
    expect(outcome).toEqual({ ok: false, reason: 'shellNotSupported' });
  });

  it('同じ理由で 2 つ弾いても警告は 1 度だけ出す(画面は同じ行を 2 度出さない)', () => {
    const bodies = [makeBody('f1', 'solid'), makeBody('f2', 'shell'), makeBody('f3', 'shell')];
    const outcome = selectExportBodies(bodies, createExportRequest('stl', { withColors: false }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.warnings]).toEqual(['shellNotSupported']);
  });

  it('面だけの立体を含めて STEP に出しても弾かない(STEP はシェルを持てる)', () => {
    const bodies = [makeBody('f1', 'solid'), makeBody('f2', 'shell')];
    const outcome = selectExportBodies(bodies, createExportRequest('step'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.featureIds]).toEqual(['f1', 'f2']);
    // STEP は三角形を使わないので、なめらかさが効かないことだけを知らせる。
    expect([...outcome.selection.warnings]).toEqual(['qualityIgnored']);
  });

  it('面だけの立体を含めて 3MF に出すと弾く(3D プリント向けの形式は閉じた立体だけ)', () => {
    const bodies = [makeBody('f1', 'solid'), makeBody('f2', 'shell')];
    const outcome = selectExportBodies(bodies, createExportRequest('3mf'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.featureIds]).toEqual(['f1']);
    expect([...outcome.selection.warnings]).toEqual(['shellNotSupported']);
  });

  it('面だけの立体を含めて OBJ / glTF に出しても弾かない(見せるための三角形の集まり)', () => {
    const bodies = [makeBody('f1', 'solid'), makeBody('f2', 'shell')];
    const formats: readonly ExportFormat[] = ['obj', 'glb'];
    for (const format of formats) {
      const outcome = selectExportBodies(bodies, createExportRequest(format));
      expect(outcome.ok, format).toBe(true);
      if (!outcome.ok) {
        continue;
      }
      expect([...outcome.selection.featureIds], format).toEqual(['f1', 'f2']);
      expect([...outcome.selection.warnings], format).toEqual([]);
    }
  });

  it('STL で色を出す指定にすると、断らずに colorNotSupported の警告を返す(§0.a-0.15)', () => {
    const outcome = selectExportBodies(THREE_SOLIDS, createExportRequest('stl'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.featureIds]).toEqual(['f1', 'f2', 'f3']);
    expect([...outcome.selection.warnings]).toEqual(['colorNotSupported']);
  });

  it('STL で色を出さない指定なら警告は出ない', () => {
    const outcome = selectExportBodies(
      THREE_SOLIDS,
      createExportRequest('stl', { withColors: false }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect([...outcome.selection.warnings]).toEqual([]);
  });

  it('色を持てる形式(STEP / 3MF / OBJ / glTF)では色の警告を出さない(§0.a-0.22)', () => {
    const formats: readonly ExportFormat[] = ['step', '3mf', 'obj', 'glb'];
    for (const format of formats) {
      const outcome = selectExportBodies(THREE_SOLIDS, createExportRequest(format));
      expect(outcome.ok, format).toBe(true);
      if (!outcome.ok) {
        continue;
      }
      expect(outcome.selection.warnings.includes('colorNotSupported'), format).toBe(false);
    }
  });

  it('STEP では品質が無視され、逸脱は null になる(三角形を使わない)', () => {
    const outcome = selectExportBodies(THREE_SOLIDS, createExportRequest('step', { quality: 'fine' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.selection.deviationMm).toBeNull();
    expect([...outcome.selection.warnings]).toEqual(['qualityIgnored']);
  });

  it('三角形を使う形式では品質が逸脱(mm)になり、品質の警告は出ない', () => {
    const outcome = selectExportBodies(THREE_SOLIDS, createExportRequest('3mf', { quality: 'fine' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.selection.deviationMm).toBe(0.02);
    expect(outcome.selection.warnings.includes('qualityIgnored')).toBe(false);
  });
});

describe('形式 × 立体の種類の可否(§0.a-0.12、§0.a-0.23、§2.8)', () => {
  // 表のとおりに書く。`'mesh'` は `importedMesh` フィーチャー(P6 タスク20)が作る種類で、
  // 可否の判断はいまここで固定できる(立体の見本は作れないので、純関数の表として固定する)。
  const TABLE: readonly (readonly [ExportFormat, SolidBodyKind, boolean])[] = [
    ['step', 'solid', true], ['step', 'shell', true], ['step', 'mesh', false],
    ['stl', 'solid', true], ['stl', 'shell', false], ['stl', 'mesh', true],
    ['3mf', 'solid', true], ['3mf', 'shell', false], ['3mf', 'mesh', true],
    ['obj', 'solid', true], ['obj', 'shell', true], ['obj', 'mesh', true],
    ['glb', 'solid', true], ['glb', 'shell', true], ['glb', 'mesh', true],
  ];

  it('表のとおりに受け入れ、断るときは種類に対応するキーを返す', () => {
    for (const [format, kind, accepted] of TABLE) {
      const refusal = checkExportBodyKind(format, kind);
      expect(refusal === null, `${format} × ${kind}`).toBe(accepted);
      if (!accepted) {
        expect(refusal, `${format} × ${kind}`).toBe(
          kind === 'shell' ? 'shellNotSupported' : 'meshNotSupported',
        );
      }
    }
  });

  it('閉じた立体はどの形式にも書ける', () => {
    for (const format of EXPORT_FORMATS) {
      expect(checkExportBodyKind(format, 'solid'), format).toBeNull();
    }
  });

  it('面だけの立体を持てるのは STEP / OBJ / glTF だけ', () => {
    expect(EXPORT_FORMATS.filter((format) => acceptsShellBody(format))).toEqual([
      'step', 'obj', 'glb',
    ]);
  });

  it('読み込んだ三角形の形を持てないのは STEP だけ(§0.a-0.23)', () => {
    expect(EXPORT_FORMATS.filter((format) => !acceptsMeshBody(format))).toEqual(['step']);
  });

  it('色を持てないのは STL だけ(§0.a-0.15、§0.a-0.22)', () => {
    expect(EXPORT_FORMATS.filter((format) => !carriesColor(format))).toEqual(['stl']);
  });
});

describe('なめらかさと形式の一覧(§0.a-0.20、FR-802、FR-803)', () => {
  it('品質の 3 択は 0.5 / 0.1 / 0.02 mm(表は 1 か所だけ)', () => {
    expect(EXPORT_DEVIATION_MM).toEqual({ coarse: 0.5, normal: 0.1, fine: 0.02 });
    expect([...EXPORT_QUALITIES]).toEqual(['coarse', 'normal', 'fine']);
  });

  it('三角形を使う形式では品質がそのまま逸脱になる', () => {
    const kinds: readonly FileKind[] = ['stl', '3mf', 'obj', 'glb'];
    for (const kind of kinds) {
      for (const quality of EXPORT_QUALITIES) {
        expect(exportDeviationMm(kind, quality), `${kind}/${quality}`)
          .toBe(EXPORT_DEVIATION_MM[quality]);
      }
    }
  });

  it('STEP と DXF では品質が無視される(三角形を使わない)', () => {
    const quality: ExportQuality = 'fine';
    expect(usesTriangles('step')).toBe(false);
    expect(usesTriangles('dxf')).toBe(false);
    expect(exportDeviationMm('step', quality)).toBeNull();
    expect(exportDeviationMm('dxf', quality)).toBeNull();
  });

  it('三角形を使うのは STL / 3MF / OBJ / glTF だけ(文書そのものは使わない)', () => {
    const triangleKinds: readonly FileKind[] = FILE_KINDS.filter((kind) => usesTriangles(kind));
    expect([...triangleKinds]).toEqual(['stl', 'obj', 'glb', '3mf']);
  });

  it('ファイルの種類は 8 つで、書き出し・読み込みの形式はその部分集合である', () => {
    expect([...FILE_KINDS]).toEqual(['pcad', 'pcadt', 'step', 'stl', 'obj', 'glb', '3mf', 'dxf']);
    for (const format of EXPORT_FORMATS) {
      expect(FILE_KINDS.includes(format), format).toBe(true);
    }
    for (const format of IMPORT_FORMATS) {
      expect(FILE_KINDS.includes(format), format).toBe(true);
    }
  });

  it('書き出しは STEP / STL / 3MF / OBJ / glTF に対応する(FR-803)', () => {
    expect([...EXPORT_FORMATS]).toEqual(['step', 'stl', '3mf', 'obj', 'glb']);
  });

  it('読み込める形式(FR-802)はすべて書き出しもできる', () => {
    expect([...IMPORT_FORMATS]).toEqual(['step', 'stl', 'obj']);
    for (const format of IMPORT_FORMATS) {
      expect(canRoundTrip(format), format).toBe(true);
    }
  });
});

describe('書き出しの依頼の既定値(§0.a-0.12、§0.a-0.14、§0.a-0.22)', () => {
  it('色を出すかの既定は true', () => {
    expect(DEFAULT_EXPORT_WITH_COLORS).toBe(true);
    expect(createExportRequest('stl').withColors).toBe(true);
  });

  it('対象の既定はすべての立体、なめらかさの既定は標準、STL はバイナリ', () => {
    expect(DEFAULT_EXPORT_SCOPE).toBe('all');
    expect(DEFAULT_EXPORT_QUALITY).toBe('normal');
    expect(DEFAULT_EXPORT_ASCII).toBe(false);
    expect(createExportRequest('stl')).toEqual({
      format: 'stl',
      scope: 'all',
      selectedFeatureIds: [],
      quality: 'normal',
      withColors: true,
      ascii: false,
    });
  });

  it('渡した欄だけが既定を上書きする', () => {
    const request = createExportRequest('stl', { ascii: true, quality: 'coarse' });
    expect(request.ascii).toBe(true);
    expect(request.quality).toBe('coarse');
    expect(request.scope).toBe('all');
    expect(request.withColors).toBe(true);
  });
});

describe('三角形の細かさの対(§0.a-0.64、FR-803)', () => {
  it('3 択の裏は長さと角度の対で、粗い 0.5/0.5・標準 0.1/0.2・細かい 0.02/0.1', () => {
    expect(EXPORT_MESH_QUALITY).toEqual({
      coarse: { deviationMm: 0.5, angularDeflectionRad: 0.5 },
      normal: { deviationMm: 0.1, angularDeflectionRad: 0.2 },
      fine: { deviationMm: 0.02, angularDeflectionRad: 0.1 },
    });
  });

  it('長さだけの表は対の表から取り出したもので、数を写していない', () => {
    for (const quality of EXPORT_QUALITIES) {
      expect(EXPORT_DEVIATION_MM[quality], quality).toBe(EXPORT_MESH_QUALITY[quality].deviationMm);
    }
  });

  it('細かくするほど、長さも角度も小さくなる(順序が入れ替わらない)', () => {
    expect(EXPORT_MESH_QUALITY.coarse.deviationMm)
      .toBeGreaterThan(EXPORT_MESH_QUALITY.normal.deviationMm);
    expect(EXPORT_MESH_QUALITY.normal.deviationMm)
      .toBeGreaterThan(EXPORT_MESH_QUALITY.fine.deviationMm);
    expect(EXPORT_MESH_QUALITY.coarse.angularDeflectionRad)
      .toBeGreaterThan(EXPORT_MESH_QUALITY.normal.angularDeflectionRad);
    expect(EXPORT_MESH_QUALITY.normal.angularDeflectionRad)
      .toBeGreaterThan(EXPORT_MESH_QUALITY.fine.angularDeflectionRad);
  });

  it('三角形を使う形式では対がそのまま返り、使わない形式では null', () => {
    const triangleKinds: readonly FileKind[] = ['stl', '3mf', 'obj', 'glb'];
    for (const kind of triangleKinds) {
      for (const quality of EXPORT_QUALITIES) {
        expect(exportMeshQuality(kind, quality), `${kind}/${quality}`)
          .toEqual(EXPORT_MESH_QUALITY[quality]);
      }
    }
    expect(exportMeshQuality('step', 'fine')).toBeNull();
    expect(exportMeshQuality('dxf', 'fine')).toBeNull();
  });

  it('書き出す立体を選んだ結果にも対が入り、長さの欄と食い違わない', () => {
    const outcome = selectExportBodies([makeBody('f1', 'solid')], createExportRequest('stl'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.selection.meshQuality)
      .toEqual(EXPORT_MESH_QUALITY[DEFAULT_EXPORT_QUALITY]);
    expect(outcome.selection.meshQuality?.deviationMm).toBe(outcome.selection.deviationMm);
  });

  it('STEP を選んだ結果は対も長さも null(品質は効かない)', () => {
    const outcome = selectExportBodies([makeBody('f1', 'solid')], createExportRequest('step'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.selection.meshQuality).toBeNull();
    expect(outcome.selection.deviationMm).toBeNull();
  });
});
