/**
 * 書き出し・読み込みの 1 手(計画書 docs/plans/P6-入出力.md §2.2・§2.8、タスク32)。
 *
 * 対応要件: FR-802、FR-803、FR-811、FR-813、NFR-RE-1(止めずに警告する)。
 *
 * **判断と手続きは `exchangeFile.ts`、ここはストアとつなぐだけ。** `partFile.ts` の
 * `createDefaultPartFileDeps` と同じ役目で、ストアの持ち物(ファイルの口・幾何カーネルの
 * 口・添付の表)を `ExchangeDeps` の形へ詰め替え、結果を帯へ流す。
 *
 * **`exchangeFile.ts` はストアを輸入しない**(輪を作らない、P6 タスク28 の申し送り)ので、
 * つなぎ目はこのファイルの中だけにある。
 */

import { writeThreeMf, type ThreeMfMeshInput } from '@pointercad/io';
import type { LengthUnit } from '@pointercad/model';

import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import {
  runImport,
  type ExchangeDeps,
  type ExchangeExportOutcome,
  type ExchangeFile,
  type ExchangeKernel,
} from './exchangeFile.js';

/**
 * 幾何カーネルの口がまだ差し出されていないとき(`attachExchangeKernel` を呼ぶ前)の断り。
 *
 * **文言の正本はこの層**(§2.8「文言の正本の層」に言う下の層と同じ扱いで、
 * `ja.json` には持たない)。起動直後の一瞬と、幾何カーネルを載せない検査でしか出ない。
 */
export const EXCHANGE_KERNEL_MISSING_MESSAGE =
  'いまは書き出しと読み込みを使えません。少し待ってからもう一度お試しください。';

/** 口が無いときの代わり。頼まれたら必ず上の理由で断る(押しても何も起きない、を避ける)。 */
function missingKernel(): ExchangeKernel {
  return {
    exportShapes: () => Promise.reject(new Error(EXCHANGE_KERNEL_MISSING_MESSAGE)),
    importShape: () => Promise.reject(new Error(EXCHANGE_KERNEL_MISSING_MESSAGE)),
  };
}

/**
 * 3MF を組む(§0.a-0.19)。カーネルは三角形までしか返さないので、ZIP と XML は
 * `packages/io` が組む。**この 1 行が「io は幾何カーネルを呼べない」という約束の接ぎ目**である。
 */
function buildThreeMf(baseName: string) {
  return (outcome: ExchangeExportOutcome): ExchangeFile => {
    const meshes: ThreeMfMeshInput[] = (outcome.meshes ?? []).map((mesh) => ({
      name: mesh.name,
      color: mesh.color,
      positions: mesh.positions,
      indices: mesh.indices,
    }));
    return { fileName: `${baseName}.3mf`, bytes: writeThreeMf(meshes) };
  };
}

/**
 * 単位を訊いている読み込みの返し先(§0.a-0.6)。**同時に 1 本しか走らない**——
 * 読み込みはファイルを選ぶ窓から始まり、その 1 本が終わるまで次の答えは来ない。
 *
 * ストアへ関数を置かないのは、ストアに持たせるのは**画面に出す値**だけという決め
 * (rules/04)に沿うため。ストアには「訊いている最中か」の真偽だけを置く。
 */
let pendingImportUnit: ((unit: LengthUnit | null) => void) | null = null;

/**
 * 単位を訊く(§0.a-0.6)。STL / OBJ / 単位の無い DXF のときだけ呼ばれる。
 *
 * **確認の窓(`confirm`)は使わない。** 2 択を「OK / キャンセル」で訊くと、どちらが
 * どの単位か覚えていないと誤って選んでしまい、しかも 3 つ目の答え(やめる)を
 * 取り消しと区別できない(NFR-UX-5)。代わりにアプリの流儀の小窓を出し、
 * 「ミリメートル」「インチ」「やめる」の 3 つを名前のまま押せるようにする。
 */
function askImportUnit(): Promise<LengthUnit | null> {
  return new Promise<LengthUnit | null>((resolve) => {
    // 前の問いが残っていたら取り消し扱いで閉じる(答えを 2 つ待たない)。
    pendingImportUnit?.(null);
    pendingImportUnit = resolve;
    useAppStore.getState().setImportUnitAsked(true);
  });
}

/**
 * 単位の問いに答える(小窓のボタンが呼ぶ)。`null` は「やめる」で、読み込みそのものが
 * 取り消しになる(今の文書は 1 バイトも変わらない、NFR-RE-1)。
 *
 * 誰も待っていないときに呼ばれても何も起きない(小窓が二重に閉じても壊れない)。
 */
export function answerImportUnit(unit: LengthUnit | null): void {
  const resolve = pendingImportUnit;
  pendingImportUnit = null;
  useAppStore.getState().setImportUnitAsked(false);
  resolve?.(unit);
}

/** ストアの持ち物から、手続きが要る口一式を組み立てる。 */
export function createExchangeDeps(baseName: string): ExchangeDeps {
  const state = useAppStore.getState();
  return {
    gateway: state.fileGateway,
    kernel: state.exchangeKernel ?? missingKernel(),
    askImportUnit,
    buildThreeMf: buildThreeMf(baseName),
    droppedTriangleTemplate: t('exchange.droppedTriangles'),
    messageOf: t,
    now: () => new Date().toISOString(),
  };
}

/** 案内と断りを帯へ流す(NFR-RE-1「止めずに警告する」)。 */
function showNotices(notices: readonly string[]): void {
  if (notices.length > 0) {
    useAppStore.getState().setError(notices.join(' '));
  }
}

/**
 * 読み込む(FR-802、FR-813)。**窓は 1 つ**で、選んだ拡張子で立体か図形かが決まる。
 *
 * **読めなかったら今の文書は変えない**(NFR-RE-1)。立体を取り込めたら履歴へベースボディを
 * 積み、形そのもの(B-rep・三角形)は添付の表へ入れる。どちらか片方だけを入れると、
 * 次の再計算で形が見つからないか、保存したファイルが開き直せなくなる
 * (`packages/io` の `findMissingAttachment`)。
 */
export async function importFile(): Promise<void> {
  const store = useAppStore.getState();
  const outcome = await runImport(
    createExchangeDeps(''),
    store.document,
    store.sketch,
    store.workPlane,
  );
  if (!outcome.ok) {
    // 取り消しは失敗ではないので、断りも出さない(NFR-UX-3)。
    if (!('cancelled' in outcome)) {
      useAppStore.getState().setError(outcome.message);
    }
    return;
  }
  const after = useAppStore.getState();
  if (outcome.kind === 'sketch') {
    after.setSketch(outcome.sketch);
    showNotices(outcome.notices);
    return;
  }
  // 形を先に入れてから文書を差し替える(差し替えの直後に再計算が走るため)。
  after.addImportedAttachments(outcome.shapes, outcome.meshes);
  after.applyDocument(outcome.document);
  showNotices(outcome.notices);
}
