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
import { describe, expect, it, vi } from 'vitest';

import type { PickedFile, PickedTypedFile, FileGateway } from './fileGateway.js';
import type { ExportSaveControl } from './saveExportFile.js';
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
  prepareExport,
  consumePreparedExport,
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
  type ExchangeFile,
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((reply) => { resolve = reply; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// 形式の対応表
// ---------------------------------------------------------------------------

describe('形式の一覧と対応(FR-802、FR-803)', () => {
  it('書き出しは 5 形式(STEP / STL / 3MF / OBJ / glTF)', () => {
    expect([...EXPORT_FORMAT_ORDER]).toEqual(['step', 'stl', '3mf', 'obj', 'glb']);
  });

  it('直接読める6形式とDWGの変換案内を並べる', () => {
    expect([...IMPORT_FILE_KINDS]).toEqual(['step', 'stl', 'obj', '3mf', 'glb', 'dxf', 'dwg']);
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
  it('表示用の実枚数と保存は同じowned kernel結果を一度だけ使う', async () => {
    const fake = createFakeGateway();
    const bytes = Uint8Array.of(2, 3, 5);
    const kernel = createFakeKernel({ files: [{ fileName: '部品.stl', bytes }],
      droppedTriangleCount: 0, triangleCount: 137 });
    const deps = createDeps(fake, kernel.kernel);
    const prepared = await prepareExport(deps, ONE_SOLID, createExportRequest('stl'), '部品.pcad');
    expect(prepared.ok).toBe(true);
    expect(fake.saved).toHaveLength(0);
    if (!prepared.ok) throw new Error('preview was not prepared');
    expect(prepared.prepared.outcome.triangleCount).toBe(137);
    await expect(consumePreparedExport(deps, prepared.prepared)).resolves.toMatchObject({ ok: true });
    await expect(consumePreparedExport(deps, prepared.prepared)).resolves.toEqual({ ok: false, cancelled: true });
    expect(kernel.exportRequests).toHaveLength(1);
    expect(fake.saved).toEqual([{ fileName: '部品.stl', kind: 'stl', bytes }]);
  });

  it('3MF preview後の読取待ちは25秒計算へ課さず、計算済み分だけserializer予算を減らす', async () => {
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const fake = createFakeGateway();
      const remaining: number[] = [];
      const kernel: ExchangeKernel = { exportShapes: () => {
        now = 1_100;
        return Promise.resolve({ files: [], droppedTriangleCount: 0, triangleCount: 4,
          meshes: [{ name: null, color: null, positions: new Float32Array(9),
            indices: Uint32Array.of(0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2) }] });
      }, importShape: () => Promise.reject(new Error('unused')) };
      const deps = createDeps(fake, kernel, { buildThreeMf: (_outcome, control) => {
        remaining.push(control.remainingMs);
        return { fileName: '部品.3mf', bytes: Uint8Array.of(80, 75) };
      } });
      const preparation = await prepareExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad');
      if (!preparation.ok) throw new Error('3MF preview was not prepared');
      expect(preparation.prepared.outcome.triangleCount).toBe(4);
      now = 100_000; // the user read the displayed count before clicking
      await expect(consumePreparedExport(deps, preparation.prepared)).resolves.toMatchObject({ ok: true });
      expect(remaining).toEqual([24_000]);
      expect(fake.saved).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });

  it('3MF previewはowned indicesをcopy込みadmissionしてから実枚数を表示する', async () => {
    const fake = createFakeGateway();
    const kernel = createFakeKernel({ files: [], droppedTriangleCount: 0, triangleCount: 999,
      meshes: [{ name: null, color: null, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: Uint32Array.of(0, 1, 2) }] });
    const deps = createDeps(fake, kernel.kernel, { buildThreeMf: () =>
      ({ fileName: '部品.3mf', bytes: Uint8Array.of(80, 75) }) });
    const preparation = await prepareExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad');
    if (!preparation.ok) throw new Error('3MF preview was not prepared');
    expect(preparation.prepared.outcome.triangleCount).toBe(1);
    expect(fake.saved).toHaveLength(0);
    await expect(consumePreparedExport(deps, preparation.prepared)).resolves.toMatchObject({ ok: true });
    expect(kernel.exportRequests).toHaveLength(1);
    expect(fake.saved).toHaveLength(1);

    const excess = createFakeGateway();
    const tooMany = createFakeKernel({ files: [], droppedTriangleCount: 0,
      meshes: [{ name: null, color: null, positions: new Float32Array(9),
        indices: new Uint32Array(3_000_003) }] });
    const rejected = await prepareExport(createDeps(excess, tooMany.kernel, { buildThreeMf: () => {
      throw new Error('serializer must not start');
    } }), ONE_SOLID, createExportRequest('3mf'), '部品.pcad');
    expect(rejected).toEqual({ ok: false, message: '3MFの三角形は100万枚までです。' });
    expect(excess.saved).toHaveLength(0);

    const empty = await prepareExport(createDeps(createFakeGateway(), createFakeKernel({
      files: [], droppedTriangleCount: 0, triangleCount: 0, meshes: [],
    }).kernel), ONE_SOLID, createExportRequest('3mf'), '部品.pcad');
    if (!empty.ok) throw new Error('empty preview unexpectedly failed');
    expect(empty.prepared.outcome.triangleCount).toBeUndefined();
  });

  it('3MF previewは512MiB超の疎なfaceRangesをserializer前に拒否する', async () => {
    const fake = createFakeGateway();
    const buildThreeMf = vi.fn(() => ({ fileName: 'unexpected.3mf', bytes: Uint8Array.of(1) }));
    const kernel = createFakeKernel({ files: [], droppedTriangleCount: 0,
      meshes: [{ name: null, color: null, positions: new Float32Array(9),
        indices: Uint32Array.of(0, 1, 2),
        faceColors: new Map<number, readonly [number, number, number]>(),
        faceRanges: new Array<{ readonly triangleOffset: number; readonly triangleCount: number }>(8_388_608) }] });
    const result = await prepareExport(createDeps(fake, kernel.kernel, { buildThreeMf }),
      ONE_SOLID, createExportRequest('3mf'), '部品.pcad');
    expect(result).toEqual({ ok: false, message: '3MF書き出しの追加メモリは512MiBまでです。' });
    expect(buildThreeMf).not.toHaveBeenCalled();
    expect(fake.saved).toHaveLength(0);
  });

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
      handoff: { format: 'stl', token: null },
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
    expect(result).toEqual({ ok: true, notices: ['[exchangeError.shellNotSupported]'], handoff: { format: 'stl', token: null } });
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

describe('書き出し試行の現行性', () => {
  it('submit の signal を一回の kernel export に渡し、現行結果だけ一回保存する', async () => {
    const fake = createFakeGateway();
    const controller = new AbortController();
    let calls = 0;
    let seen: AbortSignal | undefined;
    const kernel: ExchangeKernel = {
      exportShapes: (request) => {
        calls += 1;
        seen = request.signal;
        return Promise.resolve(oneFileOutcome('current.stl'));
      },
      importShape: () => Promise.reject(new Error('unused')),
    };
    await expect(runExport(createDeps(fake, kernel), ONE_SOLID,
      createExportRequest('stl'), '部品.pcad', { signal: controller.signal, isCurrent: () => true }))
      .resolves.toMatchObject({ ok: true });
    expect(seen).toBe(controller.signal);
    expect(calls).toBe(1);
    expect(fake.saved).toHaveLength(1);
  });

  it('開始前の取消は kernel 送信と保存をどちらも行わない', async () => {
    const fake = createFakeGateway();
    const controller = new AbortController();
    controller.abort();
    const exportShapes = vi.fn(() => Promise.resolve(oneFileOutcome('old.stl')));
    const kernel: ExchangeKernel = {
      exportShapes,
      importShape: () => Promise.reject(new Error('unused')),
    };
    await expect(runExport(createDeps(fake, kernel), ONE_SOLID,
      createExportRequest('stl'), '部品.pcad', { signal: controller.signal, isCurrent: () => true }))
      .resolves.toEqual({ ok: false, cancelled: true });
    expect(exportShapes).not.toHaveBeenCalled();
    expect(fake.saved).toHaveLength(0);
  });

  it('カーネル返信待ちの取消後は保存の口を呼ばない', async () => {
    const pending = deferred<ExchangeExportOutcome>();
    const fake = createFakeGateway();
    const save = vi.spyOn(fake.gateway, 'saveFileAs');
    const controller = new AbortController();
    const control: ExportSaveControl = { signal: controller.signal, isCurrent: () => true };
    const deps = createDeps(fake, { exportShapes: () => pending.promise, importShape: () => Promise.reject(new Error('unused')) });
    const result = runExport(deps, ONE_SOLID, createExportRequest('obj'), '部品.pcad', control);
    controller.abort();
    pending.resolve(oneFileOutcome('部品.obj'));
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('3MF 組立の間に失効したら生成済バイトを保存しない', async () => {
    const fake = createFakeGateway();
    let current = true;
    const control: ExportSaveControl = { signal: new AbortController().signal, isCurrent: () => current };
    const deps = createDeps(fake, createFakeKernel({ files: [], droppedTriangleCount: 0 }).kernel, {
      buildThreeMf: () => { current = false; return { fileName: '部品.3mf', bytes: Uint8Array.of(1) }; },
    });
    await expect(runExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad', control))
      .resolves.toEqual({ ok: false, cancelled: true });
    expect(fake.saved).toHaveLength(0);
  });

  it('3MF kernel 中の同期失効でも拒否返信を観測し、次の現行依頼は保存できる', async () => {
    const fake = createFakeGateway();
    let current = true;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const kernel: ExchangeKernel = {
        exportShapes: () => { current = false; return Promise.reject(new Error('kernel rejected after stale')); },
        importShape: () => Promise.reject(new Error('unused')),
      };
      const deps = createDeps(fake, kernel, { buildThreeMf: () => { throw new Error('must not build'); } });
      await expect(runExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad',
        { signal: new AbortController().signal, isCurrent: () => current }))
        .resolves.toEqual({ ok: false, cancelled: true });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(fake.saved).toHaveLength(0);
    } finally { process.off('unhandledRejection', onUnhandled); }
    current = true;
    const next = createDeps(fake, createFakeKernel({ files: [], droppedTriangleCount: 0 }).kernel,
      { buildThreeMf: () => ({ fileName: 'current.3mf', bytes: Uint8Array.of(1) }) });
    await expect(runExport(next, ONE_SOLID, createExportRequest('3mf'), '部品.pcad',
      { signal: new AbortController().signal, isCurrent: () => current }))
      .resolves.toMatchObject({ ok: true });
    expect(fake.saved).toHaveLength(1);
  });

  it('3MF kernel 保留中に文字列の理由で取消しても旧結果を保存しない', async () => {
    const pending = deferred<ExchangeExportOutcome>();
    const fake = createFakeGateway();
    const controller = new AbortController();
    const deps = createDeps(fake, {
      exportShapes: () => pending.promise,
      importShape: () => Promise.reject(new Error('unused')),
    }, { buildThreeMf: () => { throw new Error('取消後に組立しない'); } });
    const running = runExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad',
      { signal: controller.signal, isCurrent: () => true });
    controller.abort('plain reason');
    await expect(running).resolves.toEqual({ ok: false, cancelled: true });
    expect(fake.saved).toHaveLength(0);
    pending.resolve({ files: [], droppedTriangleCount: 0 });
    await Promise.resolve();
    expect(fake.saved).toHaveLength(0);
  });

  it('3MF builder が保留中の取消は戻りを待たずに終了し、遅いZIPを保存しない', async () => {
    const fake = createFakeGateway(), result = deferred<ExchangeFile>(), started = deferred<void>();
    const controller = new AbortController();
    const deps = createDeps(fake, createFakeKernel({ files: [], droppedTriangleCount: 0 }).kernel, {
      buildThreeMf: () => { started.resolve(undefined); return result.promise; },
    });
    const running = runExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad',
      { signal: controller.signal, isCurrent: () => true });
    await started.promise;
    controller.abort();
    await expect(running).resolves.toEqual({ ok: false, cancelled: true });
    result.resolve({ fileName: 'late.3mf', bytes: Uint8Array.of(1) });
    await Promise.resolve();
    expect(fake.saved).toHaveLength(0);
  });

  it('3MF kernel と serializer は一つの25秒計算期限を使い、残りだけ渡す', async () => {
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const fake = createFakeGateway();
      const kernel: ExchangeKernel = { exportShapes: () => {
        now = 25_000;
        return Promise.resolve({ files: [], droppedTriangleCount: 0 });
      }, importShape: () => Promise.reject(new Error('unused')) };
      const remaining: number[] = [];
      const deps = createDeps(fake, kernel, { buildThreeMf: (_outcome, control) => {
        remaining.push(control.remainingMs);
        return { fileName: 'current.3mf', bytes: Uint8Array.of(1) };
      } });
      await expect(runExport(deps, ONE_SOLID, createExportRequest('3mf'), '部品.pcad'))
        .resolves.toMatchObject({ ok: true });
      expect(remaining).toEqual([100]);
      expect(fake.saved).toHaveLength(1);
      now = 100;
      const lateKernel: ExchangeKernel = { exportShapes: () => {
        now = 25_101;
        return Promise.resolve({ files: [], droppedTriangleCount: 0 });
      }, importShape: () => Promise.reject(new Error('unused')) };
      const late = createFakeGateway();
      await expect(runExport(createDeps(late, lateKernel, { buildThreeMf: () => {
        throw new Error('must not build');
      } }), ONE_SOLID, createExportRequest('3mf'), '部品.pcad'))
        .resolves.toMatchObject({ ok: false });
      expect(late.saved).toHaveLength(0);
    } finally { clock.mockRestore(); }
  });

  it('OBJ先頭保存中の取消は次のMTL保存と旧成功案内を止める', async () => {
    const first = deferred<boolean>();
    const started = deferred<void>();
    const fake = createFakeGateway();
    const saves = vi.fn(() => { started.resolve(undefined); return first.promise; });
    const gateway: FileGateway = { ...fake.gateway, saveFileAs: saves };
    const controller = new AbortController();
    const deps = createDeps({ ...fake, gateway }, createFakeKernel({
      files: [{ fileName: '部品.obj', bytes: Uint8Array.of(1) }, { fileName: '部品.mtl', bytes: Uint8Array.of(2) }],
      droppedTriangleCount: 0,
    }).kernel);
    const result = runExport(deps, ONE_SOLID, createExportRequest('obj'), '部品.pcad', {
      signal: controller.signal, isCurrent: () => true,
    });
    await started.promise;
    expect(saves).toHaveBeenCalledTimes(1);
    controller.abort();
    first.resolve(true);
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
    expect(saves).toHaveBeenCalledTimes(1);
  });

  it('現行の依頼は従来どおり保存・成功し、DXF失効は保存前に止める', async () => {
    const fake = createFakeGateway();
    const controller = new AbortController();
    const control: ExportSaveControl = { signal: controller.signal, isCurrent: () => true };
    await expect(runExport(createDeps(fake, createFakeKernel(oneFileOutcome('部品.stl')).kernel),
      ONE_SOLID, createExportRequest('stl'), '部品.pcad', control))
      .resolves.toEqual({ ok: true, notices: [], handoff: { format: 'stl', token: null } });
    expect(fake.saved).toHaveLength(1);
    controller.abort();
    await expect(runExportDxf(createDeps(fake, createForbiddenKernel()), dxfInputOf([DXF_LINE]), '部品.pcad', control))
      .resolves.toEqual({ ok: false, cancelled: true });
    expect(fake.saved).toHaveLength(1);
  });

  it('DXF保存待ちで失効した返信は旧成功案内へ進めない', async () => {
    const pending = deferred<boolean>();
    const fake = createFakeGateway();
    const save = vi.fn(() => pending.promise);
    let current = true;
    const deps = createDeps({ ...fake, gateway: { ...fake.gateway, saveFileAs: save } }, createForbiddenKernel());
    const result = runExportDxf(deps, dxfInputOf([DXF_LINE]), '部品.pcad', {
      signal: new AbortController().signal, isCurrent: () => current,
    });
    expect(save).toHaveBeenCalledTimes(1);
    current = false;
    pending.resolve(true);
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
    expect(save).toHaveBeenCalledTimes(1);
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
    expect(fake.openedKinds[0]).toEqual(['step', 'stl', 'obj', '3mf', 'glb', 'dxf']);
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
    expect(fake.openedKinds[0]).toEqual(['step', 'stl', 'obj', '3mf', 'glb', 'dxf']);
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
    expect(result).toEqual({ ok: true, notices: [], handoff: { format: 'step', token: null } });
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
    expect(result).toEqual({ ok: true, notices: [], handoff: { format: 'stl', token: null } });
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
    expect(result).toEqual({ ok: true, notices: ['[exchangeError.shellNotSupported]'], handoff: { format: 'stl', token: null } });
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
