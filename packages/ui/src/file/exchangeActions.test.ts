/**
 * 単位を訊く小窓の待ち合わせ(`exchangeActions.ts`、計画書 docs/plans/P6-入出力.md
 * §0.a-0.6、タスク32b)の検査。
 *
 * 対応要件: FR-802、FR-811、NFR-UX-5(2 択を「OK / キャンセル」で訊かない)。
 *
 * 画面(`ImportUnitPanel.tsx`)は押されたボタンを `answerImportUnit` へ渡すだけなので、
 * ここでは**待ち合わせ**——訊いている間は印が立ち、答えると読み込みへ値が返る——を固定する。
 */

import { writeThreeMf, type ThreeMfColor, type ThreeMfMeshInput } from '@pointercad/io';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { answerImportUnit, createExchangeDeps, importFile } from './exchangeActions.js';
import type { ExchangeImportOutcome } from './exchangeFile.js';

beforeEach(resetTestStore);

function importedPair(value: number): ExchangeImportOutcome {
  return { unit: 'mm', bodies: [
    { bodyKind: 'solid', name: 'solid', volume: 1, triangleCount: 1, brepBytes: Uint8Array.of(value) },
    { bodyKind: 'mesh', name: 'mesh', volume: 0, triangleCount: 1, mesh: {
      positions: Float32Array.of(value, 0, 0, value + 1, 0, 0, value, 1, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2),
    } },
  ] };
}

function installImport(read: () => Promise<ExchangeImportOutcome>): void {
  const state = useAppStore.getState();
  useAppStore.setState({ fileGateway: { ...state.fileGateway,
    openFile: () => Promise.resolve({ kind: 'step', fileName: 'body.step', bytes: Uint8Array.of(1) }) },
  exchangeKernel: { importShape: read, exportShapes: () => Promise.reject(new Error('Not used')) } });
}

describe('実importFileの添付所有', () => {
  it('削除後のfeature.id再利用でも旧原本を保ち、追加1回だけUndoへ積む', async () => {
    installImport(() => Promise.resolve(importedPair(1))); await importFile('step');
    const first = useAppStore.getState();
    expect(first.document.solids.map(feature => feature.id)).toEqual(['importedSolid-1', 'importedMesh-1']);
    first.applyDocument({ ...first.document, solids: [] });
    const before = useAppStore.getState();
    installImport(() => Promise.resolve(importedPair(2))); await importFile('step');
    const next = useAppStore.getState();
    expect(next.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(next.document.solids.map(feature => feature.id)).toEqual(first.document.solids.map(feature => feature.id));
    const solid = next.document.solids[0], mesh = next.document.solids[1];
    if (solid.kind !== 'importedSolid' || mesh.kind !== 'importedMesh') throw new Error('Missing imported bodies');
    expect(solid.source.fileName).toBe('body.step'); expect(mesh.source.fileName).toBe('body.step');
    expect(solid.shapeRef).not.toBe('importedSolid-1'); expect(mesh.meshRef).not.toBe('importedMesh-1');
    expect(next.importedShapes.get(solid.shapeRef)).toEqual(Uint8Array.of(2));
    expect(next.importedMeshes.get(mesh.meshRef)?.positions[0]).toBe(2);
    expect(next.importedShapes.get('importedSolid-1')).toBe(first.importedShapes.get('importedSolid-1'));
    expect(next.importedMeshes.get('importedMesh-1')).toBe(first.importedMeshes.get('importedMesh-1'));
    next.undo(); next.undo(); expect(useAppStore.getState().document).toBe(first.document);
    next.redo(); next.redo(); expect(useAppStore.getState().document).toBe(next.document);
    expect(first.importedShapes.size).toBe(1); expect(first.importedMeshes.size).toBe(1);
  });

  it('旧featureが新featureの仮refを使っていても新規2件の参照だけを移す', async () => {
    installImport(() => Promise.resolve(importedPair(1))); await importFile('step');
    const first = useAppStore.getState(), solid = first.document.solids[0], mesh = first.document.solids[1];
    if (solid.kind !== 'importedSolid' || mesh.kind !== 'importedMesh') throw new Error('Missing imported bodies');
    const oldMesh = first.importedMeshes.get(mesh.meshRef);
    if (oldMesh === undefined) throw new Error('Missing mesh bytes');
    first.setImportedAttachments(new Map([...first.importedShapes, ['importedSolid-2', Uint8Array.of(1)]]),
      new Map([...first.importedMeshes, ['importedMesh-2', oldMesh]]));
    first.applyDocument({ ...first.document, solids: [{ ...solid, shapeRef: 'importedSolid-2' }, { ...mesh, meshRef: 'importedMesh-2' }] });
    const existing = useAppStore.getState();
    installImport(() => Promise.resolve(importedPair(2))); await importFile('step');
    const next = useAppStore.getState();
    expect(next.document.solids.slice(0, 2)).toEqual(existing.document.solids);
    expect(next.document.solids[0]).toBe(existing.document.solids[0]);
    expect(next.document.solids[1]).toBe(existing.document.solids[1]);
    for (const feature of next.document.solids.slice(2)) {
      if (feature.kind === 'importedSolid') {
        expect(feature.id).toBe('importedSolid-2'); expect(feature.shapeRef).not.toBe('importedSolid-2');
        expect(next.importedShapes.get(feature.shapeRef)).toEqual(Uint8Array.of(2));
      } else if (feature.kind === 'importedMesh') {
        expect(feature.id).toBe('importedMesh-2'); expect(feature.meshRef).not.toBe('importedMesh-2');
        expect(next.importedMeshes.get(feature.meshRef)?.positions[0]).toBe(2);
      } else throw new Error('Unexpected imported body');
    }
    expect(next.importedShapes.get('importedSolid-2')).toEqual(Uint8Array.of(1));
    expect(next.importedMeshes.get('importedMesh-2')?.positions[0]).toBe(1);
  });

  it('待機中の文書変更とファイル取消は文書・Undo・原本Mapを変更しない', async () => {
    let finish: (outcome: ExchangeImportOutcome) => void = () => { throw new Error('Not pending'); };
    let started: () => void = () => { throw new Error('Not installed'); };
    const waiting = new Promise<void>(resolve => { started = resolve; });
    installImport(() => new Promise(resolve => { finish = resolve; started(); }));
    const pending = importFile('step');
    await waiting;
    const state = useAppStore.getState(); state.applyDocument({ ...state.document, name: 'edited' });
    const edited = useAppStore.getState(); finish(importedPair(2)); await pending;
    function unchanged(): void {
      const current = useAppStore.getState(); expect(current.document).toBe(edited.document);
      expect(current.undoStack).toBe(edited.undoStack); expect(current.importedShapes).toBe(edited.importedShapes);
      expect(current.importedMeshes).toBe(edited.importedMeshes);
    }
    unchanged();
    useAppStore.setState({ fileGateway: { ...edited.fileGateway, openFile: () => Promise.resolve(null) } });
    await importFile('step'); unchanged();
  });
});

describe('単位を訊く(§0.a-0.6)', () => {
  it('訊いている間は印が立ち、答えると読み込みへ単位が返る', async () => {
    const pending = createExchangeDeps('model').askImportUnit();
    expect(useAppStore.getState().importUnitAsked).toBe(true);

    answerImportUnit('inch');
    await expect(pending).resolves.toBe('inch');
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('「やめる」は null を返す(読み込みそのものが取り消しになる)', async () => {
    const pending = createExchangeDeps('model').askImportUnit();
    answerImportUnit(null);
    await expect(pending).resolves.toBeNull();
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('誰も待っていないときに答えても何も起きない(小窓が二重に閉じても壊れない)', () => {
    answerImportUnit('mm');
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('前の問いが残ったまま次を訊いたら、前の問いは取り消しになる(答えを 2 つ待たない)', async () => {
    const first = createExchangeDeps('model').askImportUnit();
    const second = createExchangeDeps('model').askImportUnit();
    await expect(first).resolves.toBeNull();

    answerImportUnit('mm');
    await expect(second).resolves.toBe('mm');
  });
});

/*
 * `createExchangeDeps(...).buildThreeMf` の面ごとの色(R04・§6.1 の3の是正)。
 *
 * `docs/review-2026-09-28-codex.md` の R04・付録Cは、UI 側の実際の書き出しの入口
 * (`createExchangeDeps(...).buildThreeMf`)を通すと、面ごとの色(青)が消えて立体の色
 * (赤)しか出力に残らないことを、`writeThreeMf` への直接呼び出しとの比較で示した。
 * この検査は同じ比較を行い、**UI の入口を通した結果が、同じ面色を渡した
 * `writeThreeMf` の直接呼び出しと 1 バイトも違わない**ことを固定する
 * (`writeThreeMf.test.ts` は下位のライター単体だけを見ており、UI からの到達は見ない)。
 */
describe('createExchangeDeps(...).buildThreeMf の面ごとの色(R04)', () => {
  const BODY_COLOR: ThreeMfColor = [1, 0, 0];
  const FACE_COLOR: ThreeMfColor = [0, 0, 1];
  const FACE_RANGES = [
    { triangleOffset: 0, triangleCount: 1 },
    { triangleOffset: 1, triangleCount: 1 },
  ];

  const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3]);

  function meshInput(withFaceColor: boolean): ThreeMfMeshInput {
    return {
      name: 'two-triangles',
      color: BODY_COLOR,
      positions: POSITIONS,
      indices: INDICES,
      ...(withFaceColor
        ? { faceColors: new Map([[1, FACE_COLOR]]), faceRanges: FACE_RANGES }
        : {}),
    };
  }

  function buildThreeMfOrThrow(baseName: string) {
    const buildThreeMf = createExchangeDeps(baseName, meshes => Promise.resolve().then(() => writeThreeMf(meshes))).buildThreeMf;
    if (buildThreeMf === undefined) throw new Error('buildThreeMf が組まれていません');
    return buildThreeMf;
  }

  it('面の色を渡すと、UI の入口を通した結果が writeThreeMf の直接呼び出しと1バイトも違わない', async () => {
    const mesh = meshInput(true);
    const direct = writeThreeMf([mesh]);
    const throughUi = await buildThreeMfOrThrow('review')({
      files: [],
      droppedTriangleCount: 0,
      meshes: [
        {
          name: mesh.name,
          color: mesh.color,
          positions: POSITIONS,
          indices: INDICES,
          faceColors: mesh.faceColors,
          faceRanges: mesh.faceRanges,
        },
      ],
    }, { remainingMs: 25_000 });
    expect(throughUi.bytes).toEqual(direct);
  });

  it('面の色を持たない依頼は今までどおり立体の色だけになる(退行が無い)', async () => {
    const mesh = meshInput(false);
    const direct = writeThreeMf([mesh]);
    const throughUi = await buildThreeMfOrThrow('review')({
      files: [],
      droppedTriangleCount: 0,
      meshes: [
        {
          name: mesh.name,
          color: mesh.color,
          positions: POSITIONS,
          indices: INDICES,
        },
      ],
    }, { remainingMs: 25_000 });
    expect(throughUi.bytes).toEqual(direct);
  });
});
