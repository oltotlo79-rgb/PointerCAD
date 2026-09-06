import { dxfFlattenedCurveMessage, DXF_WRITE_ACAD_VERSION } from '@pointercad/io';
import {
  createEmptyPartDocument,
  createEmptySketchDocument,
  createExportRequest,
  dxfToSketch,
  DXF_NOT_PLANAR_MESSAGE,
  resolveSketch,
  WORK_PLANES,
  type ExportFormat,
  type PartDocument,
  type SketchDocument,
  type SketchDxfEntity,
  type SketchToDxfInput,
  type SolidBody,
  type SolidBodyKind,
  type WorkPlane,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { PickedFile, PickedTypedFile, FileGateway } from './fileGateway.js';
import {
  appendImportedBodies,
  DEFAULT_EXPORT_BASE_NAME,
  DXF_IS_NOT_A_BODY_MESSAGE,
  droppedTriangleNotice,
  dxfExportRefusal,
  exportBaseNameOf,
  exportNoticeMessageKey,
  exportPanelShape,
  exportRefusalKey,
  exportWarningKeys,
  EXPORT_FORMAT_ORDER,
  EXPORT_PANEL_FORMAT_ORDER,
  IMPORT_FILE_KINDS,
  importedSourceFormatOf,
  kernelExportFormatOf,
  NO_SHAPE_MESSAGE,
  runExport,
  runExportDxf,
  runImport,
  runImportBody,
  runImportDxf,
  unitNoticeKeyOf,
  visibleExportWarnings,
  type ExchangeDeps,
  type ExchangeExportOutcome,
  type ExchangeExportRequest,
  type ExchangeImportedBody,
  type ExchangeImportOutcome,
  type ExchangeKernel,
} from './exchangeFile.js';

// ---------------------------------------------------------------------------
// 見本
// ---------------------------------------------------------------------------

/** 立体 1 つの見本。書き出しの選び分けが見るのは `featureId` と `bodyKind` だけ。 */
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

const ONE_SOLID: readonly SolidBody[] = [makeBody('solid-1', 'solid')];

/** 保存された 1 件(名前を変えていないことを確かめるために名前も持つ)。 */
interface SavedFile {
  readonly fileName: string;
  readonly kind: string;
  readonly bytes: Uint8Array;
}

interface FakeGateway {
  readonly gateway: FileGateway;
  readonly saved: SavedFile[];
  readonly openedKinds: (readonly string[])[];
}

interface FakeGatewayOptions {
  /** 「開く」で返すファイル。null なら取り消し。 */
  readonly picked?: PickedTypedFile | null;
  /** 「書き出す」を取り消すか。 */
  readonly saveCancels?: boolean;
  /** 「書き出す」で例外を投げるか。 */
  readonly saveThrows?: boolean;
}

function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const saved: SavedFile[] = [];
  const openedKinds: (readonly string[])[] = [];
  const gateway: FileGateway = {
    openPcad(): Promise<PickedFile | null> {
      return Promise.resolve(null);
    },
    savePcad(): Promise<string | null> {
      return Promise.resolve(null);
    },
    hasSaveTarget(): boolean {
      return false;
    },
    openFile(kinds): Promise<PickedTypedFile | null> {
      openedKinds.push(kinds);
      return Promise.resolve(options.picked ?? null);
    },
    saveFileAs(fileName, kind, bytes): Promise<boolean> {
      if (options.saveThrows === true) {
        return Promise.reject(new Error('保存できませんでした'));
      }
      if (options.saveCancels === true) {
        return Promise.resolve(false);
      }
      saved.push({ fileName, kind, bytes });
      return Promise.resolve(true);
    },
  };
  return { gateway, saved, openedKinds };
}

/** カーネルの偽物。頼まれた依頼を覚え、あらかじめ決めた結果を返す。 */
interface FakeKernel {
  readonly kernel: ExchangeKernel;
  readonly exportRequests: ExchangeExportRequest[];
}

function createFakeKernel(
  exportOutcome: ExchangeExportOutcome | Error,
  importOutcome?: ExchangeImportOutcome | Error,
): FakeKernel {
  const exportRequests: ExchangeExportRequest[] = [];
  const kernel: ExchangeKernel = {
    exportShapes(request): Promise<ExchangeExportOutcome> {
      exportRequests.push(request);
      return exportOutcome instanceof Error
        ? Promise.reject(exportOutcome)
        : Promise.resolve(exportOutcome);
    },
    importShape(): Promise<ExchangeImportOutcome> {
      if (importOutcome === undefined) {
        return Promise.reject(new Error('読み込みは頼まれていません'));
      }
      return importOutcome instanceof Error
        ? Promise.reject(importOutcome)
        : Promise.resolve(importOutcome);
    },
  };
  return { kernel, exportRequests };
}

/** 断り・警告の文言。ja.json を通さず、キーをそのまま返して検査を読みやすくする。 */
function messageOf(key: string): string {
  return `[${key}]`;
}

function createDeps(
  fake: FakeGateway,
  kernel: ExchangeKernel,
  overrides: Partial<ExchangeDeps> = {},
): ExchangeDeps {
  return {
    gateway: fake.gateway,
    kernel,
    askImportUnit: () => Promise.resolve('mm'),
    droppedTriangleTemplate: '面積が 0 の三角形を {count} 枚除きました。',
    messageOf,
    now: () => '2026-09-06T00:00:00.000Z',
    ...overrides,
  };
}

function oneFileOutcome(fileName: string): ExchangeExportOutcome {
  return { files: [{ fileName, bytes: Uint8Array.from([1, 2]) }], droppedTriangleCount: 0 };
}

// ---------------------------------------------------------------------------
// 形式の対応表
// ---------------------------------------------------------------------------

describe('形式の一覧と対応(FR-802、FR-803)', () => {
  it('書き出しは 5 形式(STEP / STL / 3MF / OBJ / glTF)', () => {
    expect([...EXPORT_FORMAT_ORDER]).toEqual(['step', 'stl', '3mf', 'obj', 'glb']);
  });

  it('読み込みは 6 形式(書き出しの 5 つに DXF が加わる)', () => {
    expect([...IMPORT_FILE_KINDS]).toEqual(['step', 'stl', 'obj', '3mf', 'glb', 'dxf']);
  });

  it('カーネルの言葉では glTF が gltf、3MF が mesh になる(§0.a-0.19)', () => {
    expect(kernelExportFormatOf('step')).toBe('step');
    expect(kernelExportFormatOf('stl')).toBe('stl');
    expect(kernelExportFormatOf('obj')).toBe('obj');
    expect(kernelExportFormatOf('glb')).toBe('gltf');
    expect(kernelExportFormatOf('3mf')).toBe('mesh');
  });

  it('文書に残す形式は 5 つで、`.pcad` / ひな形 / DXF は形にならない', () => {
    expect(importedSourceFormatOf('step')).toBe('step');
    expect(importedSourceFormatOf('glb')).toBe('gltf');
    expect(importedSourceFormatOf('3mf')).toBe('3mf');
    expect(importedSourceFormatOf('pcad')).toBeNull();
    expect(importedSourceFormatOf('pcadt')).toBeNull();
    expect(importedSourceFormatOf('dxf')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// パネルの見せ方(§0.a-0.20)
// ---------------------------------------------------------------------------

describe('書き出しのパネルの見せ方(§0.a-0.20)', () => {
  it('なめらかさの 3 択は STL / 3MF / OBJ / glTF のときだけ出る', () => {
    const withQuality = EXPORT_FORMAT_ORDER.filter((f) => exportPanelShape(f).showsQuality);
    expect([...withQuality]).toEqual(['stl', '3mf', 'obj', 'glb']);
  });

  it('文字で書く(ASCII)の切替は STL のときだけ出る', () => {
    const withAscii = EXPORT_FORMAT_ORDER.filter((f) => exportPanelShape(f).showsAscii);
    expect([...withAscii]).toEqual(['stl']);
  });

  it('色を書き出すの切替は STEP / 3MF / OBJ / glTF のときだけ出る(§0.a-0.22)', () => {
    const withColor = EXPORT_FORMAT_ORDER.filter((f) => exportPanelShape(f).showsColor);
    expect([...withColor]).toEqual(['step', '3mf', 'obj', 'glb']);
  });

  it('「STL には色が付きません」は STL のときだけ出る(§0.a-0.15)', () => {
    const withNotice = EXPORT_FORMAT_ORDER.filter((f) => exportPanelShape(f).showsNoColorNotice);
    expect([...withNotice]).toEqual(['stl']);
  });

  it('単位の案内はミリメートル。glTF だけメートル(§0.a-0.7)', () => {
    for (const format of EXPORT_FORMAT_ORDER) {
      const expected =
        format === 'glb' ? 'exchange.unitNoticeMeter' : 'exchange.unitNoticeMillimeter';
      expect(unitNoticeKeyOf(format), format).toBe(expected);
      expect(exportPanelShape(format).unitNoticeKey, format).toBe(expected);
    }
  });

  it('色の切替と「色が付きません」の 1 行は、いつも入れ替わりに出る', () => {
    for (const format of EXPORT_FORMAT_ORDER) {
      const shape = exportPanelShape(format);
      expect(shape.showsColor === shape.showsNoColorNotice, format).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 押す前の断り(NFR-UX-5)
// ---------------------------------------------------------------------------

describe('押す前の断り(NFR-UX-5)', () => {
  it('面だけの立体だけを STL に出そうとすると、押す前に断る', () => {
    const bodies = [makeBody('surface-1', 'shell')];
    expect(exportRefusalKey(bodies, createExportRequest('stl')))
      .toBe('exchangeError.shellNotSupported');
  });

  it('同じ立体でも STEP なら断らない(面だけの形を持てる)', () => {
    const bodies = [makeBody('surface-1', 'shell')];
    expect(exportRefusalKey(bodies, createExportRequest('step'))).toBeNull();
  });

  it('書き出せる立体が 0 個なら、押す前に断る', () => {
    expect(exportRefusalKey([], createExportRequest('stl')))
      .toBe('exchangeError.nothingToExport');
  });

  it('「選んだ立体」で 1 つも当たらなくても、押す前に断る(FR-427)', () => {
    const request = createExportRequest('stl', {
      scope: 'selected',
      selectedFeatureIds: ['無い id'],
    });
    expect(exportRefusalKey(ONE_SOLID, request)).toBe('exchangeError.nothingToExport');
  });

  it('閉じた立体を STL に出すのは断らない', () => {
    expect(exportRefusalKey(ONE_SOLID, createExportRequest('stl'))).toBeNull();
  });

  it('3 つのうち 1 つが面だけなら、断らずに警告を添える(全部を止めない)', () => {
    const bodies = [
      makeBody('solid-1', 'solid'),
      makeBody('surface-1', 'shell'),
      makeBody('solid-2', 'solid'),
    ];
    const request = createExportRequest('stl', { withColors: false });
    expect(exportRefusalKey(bodies, request)).toBeNull();
    expect([...exportWarningKeys(bodies, request)])
      .toEqual(['exchangeError.shellNotSupported']);
  });

  it('STEP でなめらかさを指定しても、断らずに「効きません」の警告だけ出る', () => {
    expect([...exportWarningKeys(ONE_SOLID, createExportRequest('step'))])
      .toEqual(['exchangeError.qualityIgnored']);
  });

  it('STL で色を指定すると「色が付きません」の警告になる(既定は色を出す)', () => {
    expect([...exportWarningKeys(ONE_SOLID, createExportRequest('stl'))])
      .toEqual(['exchangeError.colorNotSupported']);
  });

  it('断りのキーは model の理由と 1 対 1 に対応する', () => {
    expect(exportNoticeMessageKey('nothingToExport')).toBe('exchangeError.nothingToExport');
    expect(exportNoticeMessageKey('meshNotSupported')).toBe('exchangeError.meshNotSupported');
  });
});

// ---------------------------------------------------------------------------
// 小さな純関数
// ---------------------------------------------------------------------------

describe('落とした三角形の知らせとファイル名', () => {
  it('1 枚も落ちていなければ何も出さない', () => {
    expect(droppedTriangleNotice('{count} 枚', 0)).toBeNull();
  });

  it('落ちた枚数を文言へ埋める', () => {
    expect(droppedTriangleNotice('面積が 0 の三角形を {count} 枚除きました。', 3))
      .toBe('面積が 0 の三角形を 3 枚除きました。');
  });

  it('拡張子を落とした名前を書き出しの基にする', () => {
    expect(exportBaseNameOf('ブラケット.pcad')).toBe('ブラケット');
    expect(exportBaseNameOf('ブラケット')).toBe('ブラケット');
    expect(exportBaseNameOf('  空白つき.pcad  ')).toBe('空白つき');
  });

  it('名前がまだ無ければ既定の基を使う', () => {
    expect(exportBaseNameOf(null)).toBe('model');
    expect(exportBaseNameOf('   ')).toBe('model');
  });
});

// ---------------------------------------------------------------------------
// 書き出しの流れ(§2.4)
// ---------------------------------------------------------------------------

describe('書き出しの流れ(§2.4、FR-803)', () => {
  it('カーネルを呼ぶ前に断る(書き出せない組み合わせでは 1 度も呼ばない)', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('model.stl'));
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      [makeBody('surface-1', 'shell')],
      createExportRequest('stl'),
      '部品.pcad',
    );
    expect(result).toEqual({ ok: false, message: '[exchangeError.shellNotSupported]' });
    expect(kernel.exportRequests).toHaveLength(0);
    expect(fake.saved).toHaveLength(0);
  });

  it('依頼には選んだ立体・細かさの対・名前の基が入る(§0.a-0.64)', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('部品.stl'));
    await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      createExportRequest('stl', { quality: 'fine', ascii: true }),
      '部品.pcad',
    );
    expect(kernel.exportRequests).toHaveLength(1);
    const request = kernel.exportRequests[0];
    expect(request.format).toBe('stl');
    expect([...request.featureIds]).toEqual(['solid-1']);
    // 細かい = 長さ 0.02mm / 角度 0.1rad(§0.a-0.64 の表)。
    expect(request.meshQuality).toEqual({ deviationMm: 0.02, angularDeflectionRad: 0.1 });
    expect(request.ascii).toBe(true);
    expect(request.baseName).toBe('部品');
  });

  it('STEP の依頼では細かさが null になる(三角形を使わない)', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('部品.step'));
    await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      createExportRequest('step'),
      '部品.pcad',
    );
    expect(kernel.exportRequests[0].meshQuality).toBeNull();
  });

  it('返ってきたファイルは名前を変えずに全部保存する(OBJ は 2 つ)', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel({
      files: [
        { fileName: '部品.obj', bytes: Uint8Array.from([1]) },
        { fileName: '部品.mtl', bytes: Uint8Array.from([2]) },
      ],
      droppedTriangleCount: 0,
    });
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      createExportRequest('obj'),
      '部品.pcad',
    );
    expect(result.ok).toBe(true);
    expect(fake.saved.map((file) => file.fileName)).toEqual(['部品.obj', '部品.mtl']);
    expect(fake.saved.every((file) => file.kind === 'obj')).toBe(true);
  });

  it('1 つ目の保存を取り消したら、2 つ目は訊かない', async () => {
    const fake = createFakeGateway({ saveCancels: true });
    const kernel = createFakeKernel({
      files: [
        { fileName: '部品.obj', bytes: Uint8Array.from([1]) },
        { fileName: '部品.mtl', bytes: Uint8Array.from([2]) },
      ],
      droppedTriangleCount: 0,
    });
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      createExportRequest('obj'),
      '部品.pcad',
    );
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(fake.saved).toHaveLength(0);
  });

  it('落とした三角形があれば、案内を 1 行添える', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel({
      files: [{ fileName: '部品.stl', bytes: Uint8Array.from([1]) }],
      droppedTriangleCount: 4,
    });
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      createExportRequest('stl', { withColors: false }),
      '部品.pcad',
    );
    expect(result).toEqual({
      ok: true,
      notices: ['面積が 0 の三角形を 4 枚除きました。'],
    });
  });

  it('弾いた立体の警告も、書き出せたときの案内に並ぶ', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('部品.stl'));
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      [makeBody('solid-1', 'solid'), makeBody('surface-1', 'shell')],
      createExportRequest('stl', { withColors: false }),
      '部品.pcad',
    );
    expect(result).toEqual({ ok: true, notices: ['[exchangeError.shellNotSupported]'] });
  });

  it('カーネルが断ったら、その日本語の理由をそのまま返す(§2.8)', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(new Error('書き出す形が見つかりません。'));
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      createExportRequest('stl'),
      '部品.pcad',
    );
    expect(result).toEqual({ ok: false, message: '書き出す形が見つかりません。' });
    expect(fake.saved).toHaveLength(0);
  });

  it('3MF は三角形を受け取り、io が組んだ 1 ファイルを保存する(§0.a-0.19)', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel({ files: [], droppedTriangleCount: 0 });
    const deps = createDeps(fake, kernel.kernel, {
      buildThreeMf: () => ({ fileName: '部品.3mf', bytes: Uint8Array.from([80, 75]) }),
    });
    const result = await runExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad');
    expect(result.ok).toBe(true);
    expect(kernel.exportRequests[0].format).toBe('mesh');
    expect(fake.saved.map((file) => file.fileName)).toEqual(['部品.3mf']);
  });
});

// ---------------------------------------------------------------------------
// 読み込んだ形を履歴へ積む(§2.8)
// ---------------------------------------------------------------------------

const SOURCE = { format: 'step', fileName: 'bracket.step', byteLength: 100 } as const;

function meshBody(name: string | null): ExchangeImportedBody {
  return {
    bodyKind: 'mesh',
    name,
    volume: 8000,
    triangleCount: 1,
    mesh: {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2]),
    },
  };
}

function solidBody(name: string | null): ExchangeImportedBody {
  return {
    bodyKind: 'solid',
    name,
    volume: 12000,
    triangleCount: 12,
    brepBytes: Uint8Array.from([9, 8, 7]),
  };
}

describe('読み込んだ形を履歴へ積む(FR-802、§2.8)', () => {
  it('B-rep の形は importedSolid になり、参照とバイト列が対になる', () => {
    const result = appendImportedBodies(
      createEmptyPartDocument(),
      [solidBody('ブラケット')],
      SOURCE,
      'inch',
    );
    expect(result.document.solids).toHaveLength(1);
    const feature = result.document.solids[0];
    if (feature.kind !== 'importedSolid') {
      throw new Error('unreachable');
    }
    expect(feature.name).toBe('ブラケット');
    expect(feature.shapeRef).toBe(feature.id);
    expect(feature.bodyKind).toBe('solid');
    expect(feature.source.unit).toBe('inch');
    expect(feature.source.fileName).toBe('bracket.step');
    expect(result.shapes.get(feature.shapeRef)).toEqual(Uint8Array.from([9, 8, 7]));
    expect(result.meshes.size).toBe(0);
  });

  it('三角形の形は importedMesh になり、三角形の数と体積が入る', () => {
    const result = appendImportedBodies(
      createEmptyPartDocument(),
      [meshBody(null)],
      SOURCE,
      'mm',
    );
    const feature = result.document.solids[0];
    if (feature.kind !== 'importedMesh') {
      throw new Error('unreachable');
    }
    // 名前がファイルに無ければ、種類ごとの連番の名前が付く。
    expect(feature.name).toBe('読み込んだ三角形の形1');
    expect(feature.meshRef).toBe(feature.id);
    expect(feature.triangleCount).toBe(1);
    expect(feature.volume).toBe(8000);
    expect(result.meshes.get(feature.meshRef)?.indices).toEqual(Uint32Array.from([0, 1, 2]));
    expect(result.shapes.size).toBe(0);
  });

  it('複数の立体は id も参照も重ならない', () => {
    const result = appendImportedBodies(
      createEmptyPartDocument(),
      [solidBody(null), solidBody(null), meshBody(null)],
      SOURCE,
      'mm',
    );
    const ids = result.document.solids.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(3);
    expect(result.shapes.size).toBe(2);
    expect(result.meshes.size).toBe(1);
  });

  it('元の文書は書き換えない(不変)', () => {
    const document: PartDocument = createEmptyPartDocument();
    appendImportedBodies(document, [solidBody(null)], SOURCE, 'mm');
    expect(document.solids).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 読み込みの流れ(§2.8、§0.a-0.6)
// ---------------------------------------------------------------------------

function typedFile(fileName: string, kind: PickedTypedFile['kind']): PickedTypedFile {
  return { kind, fileName, bytes: Uint8Array.from([1, 2, 3]) };
}

describe('立体の読み込みの流れ(FR-802、FR-811)', () => {
  it('窓には 6 形式を頼む', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('x'));
    await runImportBody(createDeps(fake, kernel.kernel), createEmptyPartDocument());
    expect(fake.openedKinds[0]).toEqual(IMPORT_FILE_KINDS);
  });

  it('取り消したら何も起きない(断りも出さない)', async () => {
    const fake = createFakeGateway({ picked: null });
    const kernel = createFakeKernel(oneFileOutcome('x'));
    const result = await runImportBody(createDeps(fake, kernel.kernel), createEmptyPartDocument());
    expect(result).toEqual({ ok: false, cancelled: true });
  });

  it('STEP は単位を訊かずに取り込む(ファイルが単位を持つ)', async () => {
    const fake = createFakeGateway({ picked: typedFile('bracket.step', 'step') });
    const kernel = createFakeKernel(oneFileOutcome('x'), {
      bodies: [solidBody('ブラケット')],
      unit: 'inch',
    });
    let asked = 0;
    const deps = createDeps(fake, kernel.kernel, {
      askImportUnit: () => {
        asked += 1;
        return Promise.resolve('mm');
      },
    });
    const result = await runImportBody(deps, createEmptyPartDocument());
    expect(asked).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const feature = result.document.solids[0];
    if (feature.kind !== 'importedSolid') {
      throw new Error('unreachable');
    }
    expect(feature.source.unit).toBe('inch');
    expect(feature.source.importedAt).toBe('2026-09-06T00:00:00.000Z');
  });

  it('STL は単位が分からないので訊き、答えを素性に残す(§0.a-0.6)', async () => {
    const fake = createFakeGateway({ picked: typedFile('cover.stl', 'stl') });
    const kernel = createFakeKernel(oneFileOutcome('x'), {
      bodies: [meshBody(null)],
      unit: 'other',
    });
    let asked = 0;
    const deps = createDeps(fake, kernel.kernel, {
      askImportUnit: () => {
        asked += 1;
        return Promise.resolve('inch');
      },
    });
    const result = await runImportBody(deps, createEmptyPartDocument());
    expect(asked).toBe(1);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.document.solids[0].kind).toBe('importedMesh');
    const feature = result.document.solids[0];
    if (feature.kind !== 'importedMesh') {
      throw new Error('unreachable');
    }
    expect(feature.source.unit).toBe('inch');
  });

  it('単位を訊かれて取り消したら、文書は変わらない', async () => {
    const fake = createFakeGateway({ picked: typedFile('cover.stl', 'stl') });
    const kernel = createFakeKernel(oneFileOutcome('x'), {
      bodies: [meshBody(null)],
      unit: 'other',
    });
    const deps = createDeps(fake, kernel.kernel, { askImportUnit: () => Promise.resolve(null) });
    const result = await runImportBody(deps, createEmptyPartDocument());
    expect(result).toEqual({ ok: false, cancelled: true });
  });

  it('形が 1 つも入っていなければ断る(§2.8)', async () => {
    const fake = createFakeGateway({ picked: typedFile('empty.step', 'step') });
    const kernel = createFakeKernel(oneFileOutcome('x'), { bodies: [], unit: 'mm' });
    const result = await runImportBody(createDeps(fake, kernel.kernel), createEmptyPartDocument());
    expect(result).toEqual({ ok: false, message: NO_SHAPE_MESSAGE });
  });

  it('カーネルの断りは日本語の理由をそのまま返す(§2.8 の文言の正本の層)', async () => {
    const fake = createFakeGateway({ picked: typedFile('broken.step', 'step') });
    const kernel = createFakeKernel(
      oneFileOutcome('x'),
      new Error('このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。'),
    );
    const result = await runImportBody(createDeps(fake, kernel.kernel), createEmptyPartDocument());
    expect(result).toEqual({
      ok: false,
      message: 'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。',
    });
  });

  it('DXF を立体の経路へ流したら断る(取り違えを黙って通さない)', async () => {
    const fake = createFakeGateway({ picked: typedFile('図面.dxf', 'dxf') });
    const kernel = createFakeKernel(oneFileOutcome('x'));
    const result = await runImportBody(createDeps(fake, kernel.kernel), createEmptyPartDocument());
    expect(result).toEqual({ ok: false, message: DXF_IS_NOT_A_BODY_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// DXF の読み込み(FR-813)
// ---------------------------------------------------------------------------

/** 線分 1 本だけの最小の DXF(R12)。 */
const ONE_LINE_DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '10', '0.0', '20', '0.0', '30', '0.0', '11', '10.0', '21', '0.0', '31', '0.0',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\r\n');

const XY_PLANE: WorkPlane = WORK_PLANES.xy;

describe('DXF の読み込み(FR-813、§0.a-0.33)', () => {
  it('線分 1 本の DXF を、いま編集しているスケッチへ足す', async () => {
    const bytes = new TextEncoder().encode(ONE_LINE_DXF);
    const fake = createFakeGateway({ picked: { kind: 'dxf', fileName: '図面.dxf', bytes } });
    const kernel = createFakeKernel(oneFileOutcome('x'));
    const sketch = createEmptySketchDocument();
    const before = sketch.features.length;
    const result = await runImportDxf(createDeps(fake, kernel.kernel), sketch, XY_PLANE);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.sketch.features.length).toBe(before + 1);
    // もとのスケッチは書き換えない(不変)。
    expect(sketch.features.length).toBe(before);
  });

  it('窓には DXF だけを頼む', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('x'));
    await runImportDxf(
      createDeps(fake, kernel.kernel),
      createEmptySketchDocument(),
      XY_PLANE,
    );
    expect(fake.openedKinds[0]).toEqual(['dxf']);
  });

  it('取り消したら何も起きない', async () => {
    const fake = createFakeGateway({ picked: null });
    const kernel = createFakeKernel(oneFileOutcome('x'));
    const result = await runImportDxf(
      createDeps(fake, kernel.kernel),
      createEmptySketchDocument(),
      XY_PLANE,
    );
    expect(result).toEqual({ ok: false, cancelled: true });
  });
});

/** 形式の一覧が model の型と食い違っていないことを、型のうえでも確かめる。 */
const EVERY_EXPORT_FORMAT: readonly ExportFormat[] = EXPORT_FORMAT_ORDER;
describe('型の見張り', () => {
  it('書き出しの並びは 5 件そろっている', () => {
    expect(EVERY_EXPORT_FORMAT).toHaveLength(5);
  });
});

describe('「読み込む」の 1 つの入口(FR-802、FR-813)', () => {
  it('窓は 1 つで 6 形式を頼む', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('x'));
    await runImport(
      createDeps(fake, kernel.kernel),
      createEmptyPartDocument(),
      createEmptySketchDocument(),
      XY_PLANE,
    );
    expect(fake.openedKinds).toHaveLength(1);
    expect(fake.openedKinds[0]).toEqual(IMPORT_FILE_KINDS);
  });

  it('STEP を選ぶと立体になる(履歴へベースボディが積まれる)', async () => {
    const fake = createFakeGateway({ picked: typedFile('bracket.step', 'step') });
    const kernel = createFakeKernel(oneFileOutcome('x'), {
      bodies: [solidBody('ブラケット')],
      unit: 'mm',
    });
    const result = await runImport(
      createDeps(fake, kernel.kernel),
      createEmptyPartDocument(),
      createEmptySketchDocument(),
      XY_PLANE,
    );
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.kind).toBe('body');
    if (result.kind !== 'body') {
      return;
    }
    expect(result.document.solids).toHaveLength(1);
    expect(result.shapes.size).toBe(1);
  });

  it('DXF を選ぶとスケッチの図形になる(立体にはならない)', async () => {
    const bytes = new TextEncoder().encode(ONE_LINE_DXF);
    const fake = createFakeGateway({ picked: { kind: 'dxf', fileName: '図面.dxf', bytes } });
    const kernel = createFakeKernel(oneFileOutcome('x'));
    const sketch = createEmptySketchDocument();
    const result = await runImport(
      createDeps(fake, kernel.kernel),
      createEmptyPartDocument(),
      sketch,
      XY_PLANE,
    );
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.kind).toBe('sketch');
    if (result.kind !== 'sketch') {
      return;
    }
    expect(result.sketch.features.length).toBe(sketch.features.length + 1);
  });

  it('取り消したら何も起きない', async () => {
    const fake = createFakeGateway({ picked: null });
    const kernel = createFakeKernel(oneFileOutcome('x'));
    const result = await runImport(
      createDeps(fake, kernel.kernel),
      createEmptyPartDocument(),
      createEmptySketchDocument(),
      XY_PLANE,
    );
    expect(result).toEqual({ ok: false, cancelled: true });
  });
});

/**
 * 画面に出していない欄についての警告を落とす(タスク43b。タスク45 の担当の指摘)。
 *
 * 直す前は、STEP を既定のまま書き出すと「品質の指定は効きません」が、STL を既定のまま
 * 書き出すと「この環境では色を書き出せません」が必ず返っていた。どちらの欄も**その形式では
 * 画面に出していない**ので、利用者には直しようがなく、成功のたびに何かを間違えたように
 * 見えていた。model の判定(`selectExportBodies`)と `exportWarningKeys` の期待値は
 * そのままにして、**利用者へ出す側だけ**を絞る。
 */
describe('出していない欄の警告を落とす(§0.a-0.20、タスク43b)', () => {
  it('STEP では「品質の指定は効きません」を出さない(なめらかさの欄を出していない)', () => {
    expect([...visibleExportWarnings('step', ['qualityIgnored'])]).toEqual([]);
  });

  it('STL では「色を書き出せません」を出さない(色の欄を出していない)', () => {
    expect([...visibleExportWarnings('stl', ['colorNotSupported'])]).toEqual([]);
  });

  it('欄を出している形式では落とさない(3MF は色の欄がある)', () => {
    expect([...visibleExportWarnings('3mf', ['colorNotSupported'])]).toEqual([
      'colorNotSupported',
    ]);
  });

  it('弾いた立体の警告は落とさない(選び直せば直せる知らせだから)', () => {
    expect([...visibleExportWarnings('stl', ['shellNotSupported', 'colorNotSupported'])]).toEqual([
      'shellNotSupported',
    ]);
  });

  it('STEP を既定のまま書き出すと、案内は 1 件も出ない(成功が失敗に見えない)', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('部品.step'));
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      createExportRequest('step'),
      '部品.pcad',
    );
    expect(result).toEqual({ ok: true, notices: [] });
  });

  it('STL を既定のまま(色を渡さずに)書き出しても、案内は 1 件も出ない', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('部品.stl'));
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      ONE_SOLID,
      // パネルは色の欄を出していない形式へ `withColors: false` を渡す(`ExchangePanel`)。
      createExportRequest('stl', { withColors: false }),
      '部品.pcad',
    );
    expect(result).toEqual({ ok: true, notices: [] });
  });

  it('弾いた立体があるときは、案内としてちゃんと残る', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel(oneFileOutcome('部品.stl'));
    const result = await runExport(
      createDeps(fake, kernel.kernel),
      [makeBody('solid-1', 'solid'), makeBody('surface-1', 'shell')],
      createExportRequest('stl', { withColors: false }),
      '部品.pcad',
    );
    expect(result).toEqual({ ok: true, notices: ['[exchangeError.shellNotSupported]'] });
  });
});

// ---------------------------------------------------------------------------
// DXF の書き出し(FR-813、§0.a-0.34、タスク53)
// ---------------------------------------------------------------------------

/**
 * DXF の実体からスケッチを起こし、そのまま書き出しの入力にする。
 *
 * **わざわざ DXF から起こすのは、履歴の作り方をここへ書き写さないため。** スケッチの
 * フィーチャーは式の値を持つので手で組むと長くなるうえ、同じ組み立て方が model 側の
 * 検査(`sketchToDxf.test.ts`)と 2 か所に住む。読み込みの段(`dxfToSketch`)を通せば、
 * この検査が見たいもの(**ui が io へ橋渡しできているか**)だけが残る。
 */
function dxfInputOf(
  entities: readonly SketchDxfEntity[],
  plane: WorkPlane | null = WORK_PLANES.xy,
): SketchToDxfInput {
  const { features } = dxfToSketch(entities, WORK_PLANES.xy, { unit: 'mm' });
  const document: SketchDocument = { ...createEmptySketchDocument(), features };
  return { document, resolved: resolveSketch(document), plane };
}

const DXF_BASE = { layer: '0', color: null } as const;

/** (−10, 0) から (10, 0) への線分。 */
const DXF_LINE: SketchDxfEntity = {
  ...DXF_BASE,
  kind: 'line',
  start: { x: -10, y: 0 },
  end: { x: 10, y: 0 },
};

/** 中心 (0, 0)、半径 10、0 度 → 180 度の円弧(上の線分と合わせて半円が閉じる)。 */
const DXF_ARC: SketchDxfEntity = {
  ...DXF_BASE,
  kind: 'arc',
  center: { x: 0, y: 0 },
  radius: 10,
  startAngle: 0,
  endAngle: 180,
};

/** 全周の楕円。R12 に `ELLIPSE` が無いので、書き出すと折れ線へ落ちる。 */
const DXF_ELLIPSE: SketchDxfEntity = {
  ...DXF_BASE,
  kind: 'ellipse',
  center: { x: 0, y: 0 },
  majorRadius: 10,
  minorRadius: 5,
  rotation: 0,
  startAngle: 0,
  endAngle: 360,
};

/** DXF は幾何カーネルを通らないので、頼まれたら必ず落ちる偽物を渡して確かめる。 */
function createForbiddenKernel(): ExchangeKernel {
  return {
    exportShapes: () => Promise.reject(new Error('DXF でカーネルを呼んではいけません')),
    importShape: () => Promise.reject(new Error('DXF でカーネルを呼んではいけません')),
  };
}

describe('DXF の書き出しのパネルの見せ方(§0.a-0.34、タスク53)', () => {
  it('書き出しの一覧は 6 形式で、6 つ目が DXF', () => {
    expect([...EXPORT_PANEL_FORMAT_ORDER]).toEqual(['step', 'stl', '3mf', 'obj', 'glb', 'dxf']);
  });

  it('DXF ではなめらかさ・文字で書く・色の欄をどれも出さない', () => {
    const shape = exportPanelShape('dxf');
    expect([shape.showsQuality, shape.showsAscii, shape.showsColor]).toEqual([false, false, false]);
  });

  it('DXF では「STL には色が付きません」の 1 行も出さない(色の話をそもそもしない)', () => {
    expect(exportPanelShape('dxf').showsNoColorNotice).toBe(false);
  });

  it('DXF の単位の案内はミリメートル(§0.a-0.7)', () => {
    expect(unitNoticeKeyOf('dxf')).toBe('exchange.unitNoticeMillimeter');
    expect(exportPanelShape('dxf').unitNoticeKey).toBe('exchange.unitNoticeMillimeter');
  });

  it('「対象」は立体の 2 択とスケッチの 1 行が入れ替わりに出る(欄そのものは必ず 1 つ)', () => {
    for (const format of EXPORT_PANEL_FORMAT_ORDER) {
      const shape = exportPanelShape(format);
      expect(shape.showsBodyScope === shape.showsSketchTarget, format).toBe(false);
      expect(shape.showsSketchTarget, format).toBe(format === 'dxf');
    }
  });
});

describe('DXF を書き出す前の断り(NFR-UX-5)', () => {
  it('書き出す図形が 1 つも無いスケッチは、押す前に断る', () => {
    expect(dxfExportRefusal(dxfInputOf([]), messageOf)).toBe('[exchange.dxfNothingToExport]');
  });

  it('平らでないスケッチ(作図面が決まらない)は、model の断りをそのまま出す', () => {
    expect(dxfExportRefusal(dxfInputOf([DXF_LINE], null), messageOf)).toBe(DXF_NOT_PLANAR_MESSAGE);
  });

  it('線と円弧のあるスケッチは断らない', () => {
    expect(dxfExportRefusal(dxfInputOf([DXF_LINE, DXF_ARC]), messageOf)).toBeNull();
  });
});

describe('DXF を書き出す(FR-813、§2.7)', () => {
  it('`.dxf` の 1 ファイルだけを、部品の名前の基で保存する', async () => {
    const fake = createFakeGateway();
    const deps = createDeps(fake, createForbiddenKernel());
    const result = await runExportDxf(deps, dxfInputOf([DXF_LINE, DXF_ARC]), '取っ手.pcad');

    expect(result).toEqual({ ok: true, notices: [] });
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0].fileName).toBe('取っ手.dxf');
    expect(fake.saved[0].kind).toBe('dxf');
  });

  it('名前がまだ無い部品は `model.dxf` になる(立体の書き出しと同じ基)', async () => {
    const fake = createFakeGateway();
    const deps = createDeps(fake, createForbiddenKernel());
    await runExportDxf(deps, dxfInputOf([DXF_LINE]), null);
    expect(fake.saved[0].fileName).toBe(`${DEFAULT_EXPORT_BASE_NAME}.dxf`);
  });

  it('中身は R12 のテキストで、線分と円弧がそのまま入っている', async () => {
    const fake = createFakeGateway();
    const deps = createDeps(fake, createForbiddenKernel());
    await runExportDxf(deps, dxfInputOf([DXF_LINE, DXF_ARC]), '部品.pcad');

    const text = new TextDecoder().decode(fake.saved[0].bytes);
    expect(text).toContain(DXF_WRITE_ACAD_VERSION);
    expect(text).toContain('LINE');
    expect(text).toContain('ARC');
  });

  it('楕円は折れ線へ落ち、形が変わったことを案内として返す(赤い断りにしない)', async () => {
    const fake = createFakeGateway();
    const deps = createDeps(fake, createForbiddenKernel());
    const result = await runExportDxf(deps, dxfInputOf([DXF_ELLIPSE]), '部品.pcad');

    expect(result).toEqual({ ok: true, notices: [dxfFlattenedCurveMessage(1)] });
    expect(fake.saved).toHaveLength(1);
  });

  it('書き出す図形が無ければ保存の窓すら開かない', async () => {
    const fake = createFakeGateway();
    const deps = createDeps(fake, createForbiddenKernel());
    const result = await runExportDxf(deps, dxfInputOf([]), '部品.pcad');

    expect(result).toEqual({ ok: false, message: '[exchange.dxfNothingToExport]' });
    expect(fake.saved).toHaveLength(0);
  });

  it('平らでないスケッチは書けない理由をそのまま返す', async () => {
    const fake = createFakeGateway();
    const deps = createDeps(fake, createForbiddenKernel());
    const result = await runExportDxf(deps, dxfInputOf([DXF_LINE], null), '部品.pcad');

    expect(result).toEqual({ ok: false, message: DXF_NOT_PLANAR_MESSAGE });
    expect(fake.saved).toHaveLength(0);
  });

  it('保存を取り消しても失敗にはならない(断りを出さない)', async () => {
    const fake = createFakeGateway({ saveCancels: true });
    const deps = createDeps(fake, createForbiddenKernel());
    const result = await runExportDxf(deps, dxfInputOf([DXF_LINE]), '部品.pcad');

    expect(result).toEqual({ ok: false, cancelled: true });
  });

  it('保存の口が投げた理由は、そのまま利用者へ見せる', async () => {
    const fake = createFakeGateway({ saveThrows: true });
    const deps = createDeps(fake, createForbiddenKernel());
    const result = await runExportDxf(deps, dxfInputOf([DXF_LINE]), '部品.pcad');

    expect(result).toEqual({ ok: false, message: '保存できませんでした' });
  });
});
