/** 添付・3D プリント点検。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  createEmptyPartDocument,
  type SolidBody,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  t,
} from '../i18n/t.js';
import type {
  PartInspector,
} from '../solid/printCheckCommands.js';
import {
  attachExchangeKernel,
  currentPcadAttachments,
} from './attachKernel.js';
import type {
  PrintabilityReport,
} from './exchangeSlice.js';
import {
  createInitialDocumentState,
} from './initialDocumentState.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('読み込んだ形の添付', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  it('起動直後は 1 つも持たない', () => {
    expect(useAppStore.getState().importedShapes.size).toBe(0);
    expect(useAppStore.getState().importedMeshes.size).toBe(0);
  });

  it('開いた部品の形は表ごと入れ直す(`packages/io` の添付から)', () => {
    useAppStore
      .getState()
      .setImportedAttachments(new Map([['shape-1', new Uint8Array([1, 2])]]), new Map());
    expect(useAppStore.getState().importedShapes.get('shape-1')).toEqual(new Uint8Array([1, 2]));
  });

  it('入れ直しは丸ごとの差し替え(前の部品の形を残さない)', () => {
    const store = useAppStore.getState();
    store.setImportedAttachments(new Map([['shape-1', new Uint8Array([1])]]), new Map());
    store.setImportedAttachments(new Map([['shape-2', new Uint8Array([2])]]), new Map());
    expect(useAppStore.getState().importedShapes.has('shape-1')).toBe(false);
    expect(useAppStore.getState().importedShapes.has('shape-2')).toBe(true);
  });

  it('取り込みで足すときは、前からある形を残す', () => {
    const store = useAppStore.getState();
    store.setImportedAttachments(new Map([['shape-1', new Uint8Array([1])]]), new Map());
    store.addImportedAttachments(new Map([['shape-2', new Uint8Array([2])]]), new Map());
    expect([...useAppStore.getState().importedShapes.keys()]).toEqual(['shape-1', 'shape-2']);
  });

  it('足しても前の表そのものは書き換えない(不変)', () => {
    const store = useAppStore.getState();
    store.setImportedAttachments(new Map([['shape-1', new Uint8Array([1])]]), new Map());
    const before = useAppStore.getState().importedShapes;
    store.addImportedAttachments(new Map([['shape-2', new Uint8Array([2])]]), new Map());
    expect(before.size).toBe(1);
    expect(useAppStore.getState().importedShapes).not.toBe(before);
  });

  it('新規(文書の作り直し)では持ち越さない(参照が振り直されるため)', () => {
    useAppStore
      .getState()
      .setImportedAttachments(new Map([['shape-1', new Uint8Array([1])]]), new Map());
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().importedShapes.size).toBe(0);
    expect(useAppStore.getState().importedMeshes.size).toBe(0);
  });

  it('保存へ渡す添付の表は、読み込んだ形と三角形と下絵の 3 つをまとめて出す', () => {
    const store = useAppStore.getState();
    store.setImportedAttachments(new Map([['shape-1', new Uint8Array([1])]]), new Map());
    store.setCanvasImages(new Map([['canvas-1', new Uint8Array([9])]]));
    const attachments = currentPcadAttachments();
    expect(attachments.shapes.get('shape-1')).toEqual(new Uint8Array([1]));
    expect(attachments.meshes.size).toBe(0);
    expect(attachments.canvases.get('canvas-1')).toEqual(new Uint8Array([9]));
  });

  it('書き出し・読み込みの口は差し出されるまで null(差し出すと立ち、戻り値で下ろせる)', () => {
    const kernel = {
      exportShapes: () => Promise.reject(new Error('使わない')),
      importShape: () => Promise.reject(new Error('使わない')),
    };
    expect(useAppStore.getState().exchangeKernel).toBeNull();
    const detach = attachExchangeKernel(kernel);
    expect(useAppStore.getState().exchangeKernel).toBe(kernel);
    detach();
    expect(useAppStore.getState().exchangeKernel).toBeNull();
  });
});

/**
 * 選択セット(FR-112、P6 §2.13、§0.a-0.44。タスク43)。
 *
 * 覚えられるのは**立体・面・辺・頂点の 4 種**(利用者の決定、2026-09-06)。
 * ここで押さえるのは「文書だけが変わり、形の計算は 1 度も走らない」ことと、
 * §2.13 の表の断り方(名前が空・同じ名前・空の組・消えた面)である。
 */

describe('3D プリントの点検の結果(FR-815、P6 タスク43)', () => {
  /** 三角形 1 枚ぶんの、中身を見ない偽の結果。 */
  function sampleReport(): PrintabilityReport {
    return {
      triangleCount: 1,
      thinTriangles: new Uint8Array(1),
      overhangTriangles: new Uint8Array(1),
      openEdgeTriangles: new Uint8Array(1),
      summary: {
        triangleCount: 1,
        degenerateCount: 0,
        inspectedTriangleCount: 1,
        thinCount: 0,
        overhangCount: 0,
        openEdgeCount: 0,
        openEdgeTriangleCount: 0,
        watertight: true,
        minThicknessFoundMm: 20,
        minThicknessMm: 0.8,
        overhangAngleDeg: 45,
        cellSizeMm: 1.6,
      },
      cancelled: false,
    };
  }

  it('起動直後はまだ点検していない(null)', () => {
    expect(useAppStore.getState().printability).toBeNull();
  });

  it('結果を置ける。置いても形の計算は走らない(§0.53)', () => {
    useAppStore.getState().setPrintability(sampleReport());
    expect(useAppStore.getState().printability?.summary.watertight).toBe(true);
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('新しい部品にすると消える(前の形の三角形の並びを持ち越さない)', () => {
    useAppStore.getState().setPrintability(sampleReport());
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().printability).toBeNull();
  });
});
/**
 * 点検を走らせる口(FR-815、P6 §0.53。タスク46 = 43a)。
 *
 * カーネル(Worker)は起こさず、`PartInspector` の偽物を差し込んで
 * ①点検の間だけ札が立つ、②結果と塗る相手が一緒に入る、③**再計算が走らない**、
 * ④断りは帯へ出す 1 行になる、を確かめる。
 */

describe('3D プリントの点検を走らせる(FR-815、P6 タスク46)', () => {
  /** 三角形 `count` 枚ぶんの、中身を見ない偽の結果。 */
  function reportOf(count: number): PrintabilityReport {
    const bytes = Math.ceil(count / 8);
    return {
      triangleCount: count,
      thinTriangles: new Uint8Array(bytes),
      overhangTriangles: new Uint8Array(bytes),
      openEdgeTriangles: new Uint8Array(bytes),
      summary: {
        triangleCount: count,
        degenerateCount: 0,
        inspectedTriangleCount: count,
        thinCount: 0,
        overhangCount: 0,
        openEdgeCount: 0,
        openEdgeTriangleCount: 0,
        watertight: true,
        minThicknessFoundMm: 20,
        minThicknessMm: 0.8,
        overhangAngleDeg: 45,
        cellSizeMm: 1.6,
      },
      cancelled: false,
    };
  }

  /** 三角形 `triangleCount` 枚の立体 1 つ(点検が見るのは id と枚数だけ)。 */
  function bodyOf(featureId: string, triangleCount: number): SolidBody {
    return {
      featureId,
      mesh: {
        positions: new Float32Array(triangleCount * 9),
        normals: new Float32Array(triangleCount * 9),
        indices: new Uint32Array(triangleCount * 3),
        edgePositions: new Float32Array(0),
        triangleCount,
      },
      volume: 1,
      isValid: true,
      faces: [],
      edges: [],
      vertices: [],
      threadMarks: [],
    };
  }

  it('点検の口が無ければ理由を帯へ出し、結果は入らない(NFR-UX-5)', async () => {
    useAppStore.setState({ bodies: [bodyOf('box-1', 12)] });
    useAppStore.getState().inspectPrintability();
    await vi.waitFor(() => {
      expect(useAppStore.getState().isInspectingPrint).toBe(false);
    });
    expect(useAppStore.getState().printability).toBeNull();
    expect(useAppStore.getState().printCheckErrorMessage).toBe(t('printCheck.unavailable'));
  });

  it('立体が 1 つも無ければカーネルを呼ばずに断る', async () => {
    const inspector = vi.fn<PartInspector>(() => Promise.resolve({ kind: 'failed', message: 'x' }));
    useAppStore.setState({ bodies: [] });
    useAppStore.getState().setPartInspector(inspector);
    useAppStore.getState().inspectPrintability();
    await vi.waitFor(() => {
      expect(useAppStore.getState().printCheckErrorMessage).toBe(t('printCheck.noBody'));
    });
    expect(inspector).not.toHaveBeenCalled();
  });

  it('結果と塗る相手が一緒に入り、形の計算は走らない(§0.53)', async () => {
    const inspector = vi.fn<PartInspector>(() =>
      Promise.resolve({ kind: 'inspected', report: reportOf(20) }),
    );
    useAppStore.setState({ bodies: [bodyOf('box-1', 12), bodyOf('box-2', 8)] });
    useAppStore.getState().setPartInspector(inspector);
    useAppStore.getState().inspectPrintability();
    await vi.waitFor(() => {
      expect(useAppStore.getState().printability).not.toBeNull();
    });

    // 選んでいないので全部を点検する(頼んだ順に三角形が連なる)。
    expect(inspector).toHaveBeenCalledTimes(1);
    expect(inspector.mock.calls[0][1]).toEqual(['box-1', 'box-2']);
    expect(useAppStore.getState().printabilityOffsets?.get('box-1')).toBe(0);
    expect(useAppStore.getState().printabilityOffsets?.get('box-2')).toBe(12);
    // 点検は文書を 1 バイトも変えない読み取り(§0.a-0.30)。
    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().printCheckErrorMessage).toBeNull();
  });

  it('立体を選んでいればその立体だけを点検する', async () => {
    const inspector = vi.fn<PartInspector>(() =>
      Promise.resolve({ kind: 'inspected', report: reportOf(8) }),
    );
    useAppStore.setState({ bodies: [bodyOf('box-1', 12), bodyOf('box-2', 8)] });
    useAppStore.getState().setPartInspector(inspector);
    useAppStore.getState().setSelection(['box-2']);
    useAppStore.getState().inspectPrintability();
    await vi.waitFor(() => {
      expect(useAppStore.getState().printability).not.toBeNull();
    });

    expect(inspector.mock.calls[0][1]).toEqual(['box-2']);
    expect(useAppStore.getState().printabilityOffsets?.get('box-2')).toBe(0);
    expect(useAppStore.getState().printabilityOffsets?.has('box-1')).toBe(false);
  });

  it('カーネルが断ったらその日本語をそのまま帯へ出す(文言の正本は 1 つ)', async () => {
    const inspector = vi.fn<PartInspector>(() =>
      Promise.resolve({ kind: 'failed', message: 'もとになる立体が見つかりませんでした。' }),
    );
    useAppStore.setState({ bodies: [bodyOf('box-1', 12)] });
    useAppStore.getState().setPartInspector(inspector);
    useAppStore.getState().inspectPrintability();
    await vi.waitFor(() => {
      expect(useAppStore.getState().printCheckErrorMessage).toBe(
        'もとになる立体が見つかりませんでした。',
      );
    });
    expect(useAppStore.getState().printability).toBeNull();
  });

  it('閉じると結果も塗る相手も消える(元の外観に戻る)', async () => {
    const inspector = vi.fn<PartInspector>(() =>
      Promise.resolve({ kind: 'inspected', report: reportOf(12) }),
    );
    useAppStore.setState({ bodies: [bodyOf('box-1', 12)] });
    useAppStore.getState().setPartInspector(inspector);
    useAppStore.getState().inspectPrintability();
    await vi.waitFor(() => {
      expect(useAppStore.getState().printability).not.toBeNull();
    });

    useAppStore.getState().setPrintability(null);
    expect(useAppStore.getState().printability).toBeNull();
    expect(useAppStore.getState().printabilityOffsets).toBeNull();
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('走っている最中にもう一度押すと、二重に頼まず「やめる」になる(NFR-PF-4)', async () => {
    // 約束を解く手を控えておく(未代入の narrowing を避けるため、初期値は何もしない関数)。
    let release = (): void => undefined;
    const inspector = vi.fn<PartInspector>(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ kind: 'inspected', report: reportOf(12) });
          };
        }),
    );
    useAppStore.setState({ bodies: [bodyOf('box-1', 12)] });
    useAppStore.getState().setPartInspector(inspector);
    useAppStore.getState().inspectPrintability();
    expect(useAppStore.getState().isInspectingPrint).toBe(true);
    expect(useAppStore.getState().printCheckCancelRequested).toBe(false);

    useAppStore.getState().inspectPrintability();
    // 2 回目は依頼を増やさず、中止を頼むだけ(ヘルプ「もう一度押せば止まります」)。
    expect(inspector).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().printCheckCancelRequested).toBe(true);
    // 中止の答えは呼ばれるたびにストアから読む(押した瞬間の値を閉じ込めない)。
    expect(inspector.mock.calls[0][2]?.()).toBe(true);

    release();
    await vi.waitFor(() => {
      expect(useAppStore.getState().isInspectingPrint).toBe(false);
    });
    // 終わったら中止の頼みは必ず下ろす(次の点検が始まった瞬間に止まらないように)。
    expect(useAppStore.getState().printCheckCancelRequested).toBe(false);
  });
});
