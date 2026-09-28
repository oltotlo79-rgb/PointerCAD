/**
 * 読み込み(`importFile`)の待ちの間に文書が変わったときの採用判定の回帰検査
 * (docs/review-2026-09-28-codex.md R01・§6.1 の1、付録C の再現を公開入口から移したもの)。
 *
 * ファイルの口と形の計算部はストアへ差し込む(実際の画面と同じ入口)。待ちの長さを
 * 検査が決められるよう、形の計算部の返事だけを手で返す。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { answerImportUnit, importFile } from './exchangeActions.js';
import type { ExchangeImportedBody, ExchangeImportOutcome, ExchangeKernel } from './exchangeFile.js';
import type { FileGateway, PickedTypedFile } from './fileGateway.js';

beforeEach(resetTestStore);

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Not initialized'); };
  const promise = new Promise<T>((callback) => { resolve = callback; });
  return { promise, resolve };
}

function meshBody(name: string): ExchangeImportedBody {
  return {
    bodyKind: 'mesh', name, volume: 1, triangleCount: 1,
    mesh: {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2]),
    },
  };
}

/** 線分 1 本だけで、単位がメートル($INSUNITS = 6。mm でも inch でもない)の DXF。読み込むと単位を訊く。 */
const ONE_LINE_DXF = [
  '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '10', '0.0', '20', '0.0', '30', '0.0', '11', '10.0', '21', '0.0', '31', '0.0',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\r\n');

/** 選ぶファイルと、手で返す形の計算部をストアへ差し込む。 */
function installImport(picked: PickedTypedFile = { kind: 'stl', fileName: 'part.stl', bytes: Uint8Array.of(1) }) {
  const pending: ReturnType<typeof deferred<ExchangeImportOutcome>>[] = [];
  const kernel: ExchangeKernel = {
    exportShapes: () => Promise.reject(new Error('unused')),
    importShape: () => {
      const reply = deferred<ExchangeImportOutcome>();
      pending.push(reply);
      return reply.promise;
    },
  };
  const openFile = vi.fn<NonNullable<FileGateway['openFile']>>(() => Promise.resolve(picked));
  const gateway: FileGateway = {
    openPcad: () => Promise.resolve(null),
    savePcad: () => Promise.resolve(null),
    hasSaveTarget: () => false,
    openFile,
  };
  useAppStore.setState({ fileGateway: gateway });
  useAppStore.getState().setExchangeKernel(kernel);
  return { pending, openFile };
}

async function waitForKernelCalls(pending: readonly unknown[], count: number): Promise<void> {
  await vi.waitFor(() => { expect(pending).toHaveLength(count); });
}

function renamePart(name: string): void {
  const state = useAppStore.getState();
  // プロパティ欄の 1 文字ずつの編集と同じ束ねる変更。documentVersion は増えない。
  state.applyDocument({ ...state.document, name }, { coalesceKey: 'name' });
}

describe('読み込みの待ちの間の文書の変化(R01)', () => {
  it('何も変わらなければ、形と添付を 1 度に取り込む', async () => {
    const { pending } = installImport();
    const start = useAppStore.getState().document;
    const importing = importFile('stl');
    await waitForKernelCalls(pending, 1);
    pending[0]?.resolve({ bodies: [meshBody('取り込み')], unit: 'mm' });
    await importing;
    const after = useAppStore.getState();
    expect(after.document.solids).toHaveLength(start.solids.length + 1);
    expect(after.importedMeshes.size).toBe(1);
    expect(after.canUndo).toBe(true);
  });

  it('別の文書へ切り替わったら、古い文書への結果を使わない', async () => {
    const { pending } = installImport();
    const importing = importFile('stl');
    await waitForKernelCalls(pending, 1);
    useAppStore.getState().resetDocument({ ...useAppStore.getState().document, id: 'switched', name: 'B' });
    const switched = useAppStore.getState();
    pending[0]?.resolve({ bodies: [meshBody('古い依頼')], unit: 'mm' });
    await importing;
    const after = useAppStore.getState();
    expect(after.activeDocumentId).toBe(switched.activeDocumentId);
    expect(after.document).toBe(switched.document);
    expect(after.undoStack).toBe(switched.undoStack);
    expect(after.importedMeshes.size).toBe(0);
    expect(after.errorMessage).toBe(t('exchange.importStale'));
  });

  it('同じ文書を編集したら(版の番号が増えない編集でも)取り込まない', async () => {
    const { pending } = installImport();
    const importing = importFile('stl');
    await waitForKernelCalls(pending, 1);
    const version = useAppStore.getState().documentVersion;
    renamePart('編集中');
    const edited = useAppStore.getState();
    expect(edited.documentVersion).toBe(version);
    pending[0]?.resolve({ bodies: [meshBody('古い依頼')], unit: 'mm' });
    await importing;
    const after = useAppStore.getState();
    expect(after.document).toBe(edited.document);
    expect(after.document.name).toBe('編集中');
    expect(after.undoStack).toBe(edited.undoStack);
    expect(after.importedMeshes.size).toBe(0);
    expect(after.errorMessage).toBe(t('exchange.importStale'));
  });

  it('取り消し(Undo)をしたら取り込まず、やり直しの段も残す', async () => {
    const { pending } = installImport();
    renamePart('前の編集');
    const importing = importFile('stl');
    await waitForKernelCalls(pending, 1);
    useAppStore.getState().undo();
    const undone = useAppStore.getState();
    expect(undone.canRedo).toBe(true);
    pending[0]?.resolve({ bodies: [meshBody('古い依頼')], unit: 'mm' });
    await importing;
    const after = useAppStore.getState();
    expect(after.document).toBe(undone.document);
    expect(after.canRedo).toBe(true);
    expect(after.undoStack).toBe(undone.undoStack);
    expect(after.importedMeshes.size).toBe(0);
  });

  it('続けて 2 回読み込むと、後の依頼だけを採る(先の返事が先に届いても後に届いても)', async () => {
    for (const order of [[0, 1], [1, 0]] as const) {
      resetTestStore();
      const { pending } = installImport();
      const start = useAppStore.getState().document;
      const first = importFile('stl');
      await waitForKernelCalls(pending, 1);
      const second = importFile('stl');
      await waitForKernelCalls(pending, 2);
      const names = ['先の依頼', '後の依頼'];
      for (const index of order) {
        pending[index]?.resolve({ bodies: [meshBody(names[index] ?? '')], unit: 'mm' });
        await (index === 0 ? first : second);
      }
      const after = useAppStore.getState();
      expect(after.document.solids, `order ${order.join(',')}`).toHaveLength(start.solids.length + 1);
      expect(after.document.solids.at(-1)?.name).toBe('後の依頼');
      expect(after.importedMeshes.size).toBe(1);
      expect(after.errorMessage).toBeNull();
    }
  });

  it('単位を訊いている間に編集したら、答えても取り込まない', async () => {
    const { pending } = installImport();
    const importing = importFile('stl');
    await waitForKernelCalls(pending, 1);
    pending[0]?.resolve({ bodies: [meshBody('単位の無い形')], unit: 'other' });
    await vi.waitFor(() => { expect(useAppStore.getState().importUnitAsked).toBe(true); });
    renamePart('訊かれている間の編集');
    const edited = useAppStore.getState();
    answerImportUnit('mm');
    await importing;
    const after = useAppStore.getState();
    expect(after.document).toBe(edited.document);
    expect(after.importedMeshes.size).toBe(0);
    expect(after.errorMessage).toBe(t('exchange.importStale'));
  });

  it('DXF も、単位を訊いている間の編集の後は図形を足さない', async () => {
    installImport({ kind: 'dxf', fileName: 'line.dxf', bytes: new TextEncoder().encode(ONE_LINE_DXF) });
    const importing = importFile('dxf');
    await vi.waitFor(() => { expect(useAppStore.getState().importUnitAsked).toBe(true); });
    renamePart('DXFを訊かれている間の編集');
    const edited = useAppStore.getState();
    answerImportUnit('mm');
    await importing;
    const after = useAppStore.getState();
    expect(after.document).toBe(edited.document);
    expect(after.errorMessage).toBe(t('exchange.importStale'));
  });

  it('DXF は、何も変わらなければいま編集しているスケッチへ図形を足す', async () => {
    installImport({ kind: 'dxf', fileName: 'line.dxf', bytes: new TextEncoder().encode(ONE_LINE_DXF) });
    const before = useAppStore.getState().sketch.features.length;
    const importing = importFile('dxf');
    await vi.waitFor(() => { expect(useAppStore.getState().importUnitAsked).toBe(true); });
    answerImportUnit('mm');
    await importing;
    expect(useAppStore.getState().sketch.features.length).toBe(before + 1);
  });
});
