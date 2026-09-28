/**
 * 非同期の文書操作の採用判定(docs/review-2026-09-28-codex.md R01・R02・§6.1 の1)。
 *
 * 読み込み・開く・置き換えなど、**待ちをはさんで文書へ結果を当てる操作**は、待ちの間に
 * 利用者が文書を切り替えた・編集した・取り消した(Undo)・同じ操作をもう一度始めたときに、
 * 開始時の古い文書から作った結果を今の文書へ当ててはならない。その判定をここ 1 か所に置く。
 *
 * **版の番号(`documentVersion`)だけでは足りない。** プロパティ欄の 1 文字ずつの編集や
 * 通常の `applyDocument` では番号が増えない(`documentSlice.ts` の `applyDocument`)。
 * 文書・履歴・添付はどれも不変の値で、変わるたびに参照が変わるので、**参照で比べる**。
 *
 * 判定の単位は次の 3 つをまとめたもの。
 * - 文書の同一性: 開いている文書の寿命(`activeDocumentId`)とファイルの口。
 * - 内容: 部品・組立・図面の文書と Undo の履歴、それに付く添付(読み込んだ形・下絵)。
 * - 依頼の順序: 同じ種類の依頼を後から始めたら、先の依頼の結果は採らない。
 */

import type { AppState } from './appState.js';
import { useAppStore } from './useAppStore.js';

/**
 * 変われば「別の文書になった」とみなす欄。文書を開く・新規・閉じるたびに
 * `activeDocumentId` が振り直される(`assemblySlice.ts` の `createAssemblyInitialState`)。
 */
const SESSION_KEYS = ['activeDocumentId', 'fileGateway'] as const satisfies readonly (keyof AppState)[];

/**
 * 変われば「同じ文書の中身が変わった」とみなす欄。**文書を差し替える口が触る欄は全て入れる**
 * (部品・組立・図面の本文、Undo の履歴、添付)。計算結果の控え(形・診断など)は入れない
 * (利用者の操作ではなく、結果を当てても失われるものが無いため)。
 */
const CONTENT_KEYS = [
  'documentVersion',
  'document', 'undoStack',
  'assembly', 'assemblyLibrary', 'assemblyUndoStack',
  'drawing', 'drawingSources', 'drawingUndoStack', 'drawingImportedShapes',
  'importedShapes', 'importedMeshes', 'canvases',
] as const satisfies readonly (keyof AppState)[];

type SessionKey = (typeof SESSION_KEYS)[number];
type ContentKey = (typeof CONTENT_KEYS)[number];

/** 採用判定に使う欄の控え。参照をそのまま持つだけで、複製はしない。 */
export type DocumentIdentity = Pick<AppState, SessionKey | ContentKey>;

/** 今のストアから控えを取る。欄の過不足は `DocumentIdentity` の型が検査する。 */
export function captureDocumentIdentity(state: AppState): DocumentIdentity {
  return {
    activeDocumentId: state.activeDocumentId, fileGateway: state.fileGateway,
    documentVersion: state.documentVersion,
    document: state.document, undoStack: state.undoStack,
    assembly: state.assembly, assemblyLibrary: state.assemblyLibrary, assemblyUndoStack: state.assemblyUndoStack,
    drawing: state.drawing, drawingSources: state.drawingSources, drawingUndoStack: state.drawingUndoStack,
    drawingImportedShapes: state.drawingImportedShapes,
    importedShapes: state.importedShapes, importedMeshes: state.importedMeshes, canvases: state.canvases,
  };
}

/**
 * 控えと今の状態の関係。
 * - `current`: 何も変わっていない。結果を当ててよい。
 * - `superseded`: 同じ種類の依頼が後から始まった。先の結果は黙って捨てる。
 * - `changed`: 同じ文書の中身(本文・履歴・添付)が変わった。
 * - `switched`: 別の文書に切り替わった(開く・新規・閉じる)。
 */
export type DocumentRequestStatus = 'current' | 'superseded' | 'changed' | 'switched';

/** 控えと今の状態を比べる。順序の判定は含まない(`DocumentRequest` が足す)。 */
export function compareDocumentIdentity(identity: DocumentIdentity, state: AppState): 'current' | 'changed' | 'switched' {
  for (const key of SESSION_KEYS) if (!Object.is(identity[key], state[key])) return 'switched';
  for (const key of CONTENT_KEYS) if (!Object.is(identity[key], state[key])) return 'changed';
  return 'current';
}

/** 待ちをはさむ文書操作 1 回分の札。 */
export interface DocumentRequest {
  /** 開始時(または `accept` した時点)から今までの変化。 */
  status(): DocumentRequestStatus;
  /** `status() === 'current'` の略。 */
  isCurrent(): boolean;
  /**
   * 利用者が今の状態を見たうえで改めて続けると決めたときに、判定の基準を今へ移す
   * (改めての破棄の確認で「続ける」と答えたとき)。順序の判定は引き継ぐ。
   */
  accept(): void;
}

/** 依頼の種類ごとの最新の通し番号。ストアには画面に出す値だけを置く(rules/04)。 */
const latestSequence = new Map<string, number>();
let nextSequence = 0;

/**
 * 待ちをはさむ文書操作を始める。**待つ前に**呼び、結果を当てる直前に `status()` を見る。
 *
 * @param channel 依頼の種類(例 `'import'`・`'open'`)。同じ種類を後から始めると先の札は
 *   `superseded` になる。
 */
export function beginDocumentRequest(channel: string, state: AppState = useAppStore.getState()): DocumentRequest {
  nextSequence += 1;
  const sequence = nextSequence;
  latestSequence.set(channel, sequence);
  let identity = captureDocumentIdentity(state);
  const status = (): DocumentRequestStatus => {
    if (latestSequence.get(channel) !== sequence) return 'superseded';
    return compareDocumentIdentity(identity, useAppStore.getState());
  };
  return {
    status,
    isCurrent: () => status() === 'current',
    accept: () => { identity = captureDocumentIdentity(useAppStore.getState()); },
  };
}
