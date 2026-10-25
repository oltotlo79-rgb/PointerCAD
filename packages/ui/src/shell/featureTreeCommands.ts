/**
 * モデルブラウザ(`FeatureTree`)からストアを変える口(R07、レビュー F07 の責務の分離)。
 *
 * 木の入力(行を押す・右クリック・名前の検索・一覧の項目・名前の欄・並べ替えのドラッグ)が
 * 最後に呼ぶ「確定」は、全てここを通る。どの口も呼ばれた時点のストアを読み直し、文書は
 * 1 回だけ差し替える(取り消し 1 回で戻る。NFR-UX-3)。画面の一時状態(一覧の開閉・改名中・
 * 掴んでいる行)は持たない(`useFeatureTreeInput.ts`)。窓の listener の寿命も持たない
 * (`featureTreeLifetime.ts`)。
 *
 * 選択の出所(R29 の2点接続・R30 の面)は、行が属するスケッチを `{ kind: 'sketch' }` として
 * 渡す。要素の id はスケッチをまたいで重なるため、id だけで選ぶと別のスケッチの同じ id と
 * 取り違える(rules/06 §10.381)。
 */
import {
  addSketch,
  createSketchFor,
  findFeature,
  findReference,
  findSketch,
  findSolid,
  removeReference,
  removeSketch,
  removeSolid,
  replaceReference,
  replaceSketch,
  replaceSolid,
  setActiveSketch,
  type FeatureNoteTarget,
  type PartDocument,
} from '@pointercad/model';

import type { SelectionSource } from '../sketch/connectionSelection.js';
import { featureIdOf, renameFeature } from '../sketch/featureSummary.js';
import { originChangeFor } from '../sketch/originCommands.js';
import {
  renameReference,
  renameSketch,
  renameSolid,
  setReferenceVisible,
  setSolidSuppressed,
  type TreeSectionKey,
} from '../solid/solidSummary.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 一覧を開ける行の種類。節のキー 3 つに、スケッチそのものの親行を足す。
 * 親行は節ではないので `TreeSectionKey` には入れない(節の並びを作る関数の戻りが変わるため)。
 */
export type RowMenuSection = TreeSectionKey | 'sketchDocument';

/** 行のメモ・フォルダの対象。スケッチの要素は所属するスケッチと組で指す。 */
export function noteTargetForRow(part: PartDocument, id: string, section: RowMenuSection, sketchId?: string): FeatureNoteTarget {
  if (section === 'sketch') return { kind: 'sketch-feature', sketchId: sketchId ?? part.activeSketchId, id };
  return { kind: section === 'sketchDocument' ? 'sketch' : section, id };
}

function sketchSource(sketchId: string | undefined): SelectionSource | undefined {
  return sketchId === undefined ? undefined : { kind: 'sketch', sketchId };
}

/**
 * 行が属するスケッチを作図中にする。プロパティ欄は編集中のスケッチからしか要素を探さない
 * ため、選んだ要素をそのまま編集できるようにする。作図面の追従はストアの `setActiveSketch`。
 */
export function activateRowSketch(sketchId: string | undefined): void {
  if (sketchId === undefined) return;
  const store = useAppStore.getState();
  if (store.document.activeSketchId !== sketchId) store.setActiveSketch(sketchId);
}

/** 行を押した。Shift / Ctrl なら足す・外す(FR-106)、無ければその行だけを選ぶ。 */
export function selectTreeRow(rowId: string, sketchId: string | undefined, additive: boolean): void {
  const store = useAppStore.getState();
  if (additive) {
    store.toggleSelection(rowId, sketchSource(sketchId));
    return;
  }
  activateRowSketch(sketchId);
  store.setSelection([rowId], sketchSource(sketchId));
}

/** 右クリックで一覧を開く行を、その行だけの選択にする(一覧の操作の対象を画面でも示す)。 */
export function selectRowForMenu(rowId: string, sketchId: string | undefined): void {
  activateRowSketch(sketchId);
  useAppStore.getState().setSelection([rowId], sketchSource(sketchId));
}

/** 名前の検索で選んだ行を選ぶ。行の無い見出し(`selectionId` が null)は選択を空にする。 */
export function selectSearchedRow(selectionId: string | null, sketchId: string | undefined): void {
  activateRowSketch(sketchId);
  useAppStore.getState().setSelection(selectionId === null ? [] : [selectionId], sketchSource(sketchId));
}

/** スケッチの親行を押した。作図するスケッチを切り替える(形は変わらないので Undo の段は作らない)。 */
export function switchSketch(sketchId: string): void {
  useAppStore.getState().setActiveSketch(sketchId);
}

/** 木が出したホバー(ビューポートの同じ形も光る一時表示、FR-106)の持ち主。 */
export interface TreeHoverOwner {
  /** 行に指を乗せた。 */
  readonly publish: (rowId: string) => void;
  /** 行から指が離れた。その行(またはその部分形状)を光らせているときだけ消す。 */
  readonly leave: (rowId: string) => void;
  /**
   * 木の破棄。木が最後に出した id のままのときだけ消し、その後にビューポート等が出した
   * ホバーは残す(自分が出した一時表示だけを片付ける)。
   */
  readonly dispose: () => void;
}

export function createTreeHoverOwner(): TreeHoverOwner {
  let published: string | null = null;
  return {
    publish: (rowId) => {
      published = rowId;
      useAppStore.getState().setHovered(rowId);
    },
    leave: (rowId) => {
      const store = useAppStore.getState();
      const current = store.hoveredElementId;
      if (current !== null && featureIdOf(current) === rowId) store.setHovered(null);
      if (published === rowId) published = null;
    },
    dispose: () => {
      const store = useAppStore.getState();
      if (published !== null && store.hoveredElementId === published) store.setHovered(null);
      published = null;
    },
  };
}

/**
 * 新しいスケッチを 1 本作り、そこへ作図を切り替える(FR-501)。投影・断面は「そのスケッチを
 * 使う立体より前の立体」しかもとにできないので、別のスケッチが要る。その入口。
 */
export function addNewSketch(): void {
  const store = useAppStore.getState();
  const sketch = createSketchFor(store.document);
  store.applyDocument(setActiveSketch(addSketch(store.document, sketch), sketch.id));
}

/**
 * 行を消す(FR-503)。参照していたものが消えても止めず、後の段が赤い印になるだけにする
 * (FR-504、NFR-RE-1)。最後の 1 本のスケッチは model 側(`removeSketch`)が断る。
 */
export function removeTreeRow(featureId: string, sectionKey: RowMenuSection): void {
  const store = useAppStore.getState();
  if (sectionKey === 'sketchDocument') {
    store.applyDocument(removeSketch(store.document, featureId));
    return;
  }
  if (sectionKey === 'sketch') {
    store.removeSketchFeature(featureId);
    return;
  }
  if (sectionKey === 'reference') {
    store.applyDocument(removeReference(store.document, featureId));
    return;
  }
  store.applyDocument(removeSolid(store.document, featureId));
}

/** 名前を変える(FR-503)。同じ名前・空の名前なら文書を変えない(各 rename* が同じものを返す)。 */
export function renameTreeRow(featureId: string, sectionKey: RowMenuSection, name: string): void {
  const store = useAppStore.getState();
  if (sectionKey === 'sketchDocument') {
    const sketch = findSketch(store.document, featureId);
    if (sketch === undefined) return;
    const next = renameSketch(sketch, name);
    if (next !== sketch) store.applyDocument(replaceSketch(store.document, next));
    return;
  }
  if (sectionKey === 'sketch') {
    const feature = findFeature(store.sketch, featureId);
    if (feature === undefined) return;
    const next = renameFeature(feature, name);
    if (next !== feature) store.replaceSketchFeature(featureId, next);
    return;
  }
  if (sectionKey === 'reference') {
    const feature = findReference(store.document, featureId);
    if (feature === undefined) return;
    const next = renameReference(feature, name);
    if (next !== feature) store.applyDocument(replaceReference(store.document, featureId, next));
    return;
  }
  const feature = findSolid(store.document, featureId);
  if (feature === undefined) return;
  const next = renameSolid(feature, name);
  if (next !== feature) store.applyDocument(replaceSolid(store.document, featureId, next));
}

/** 基準ジオメトリを画面に出す・隠す(FR-329)。参照はどちらでもできる。 */
export function toggleReferenceVisible(featureId: string): void {
  const store = useAppStore.getState();
  const feature = findReference(store.document, featureId);
  if (feature === undefined) return;
  store.applyDocument(replaceReference(store.document, featureId, setReferenceVisible(feature, !feature.visible)));
}

/** 立体を抑制する・戻す(FR-503)。 */
export function toggleSolidSuppressed(featureId: string): void {
  const store = useAppStore.getState();
  const feature = findSolid(store.document, featureId);
  if (feature === undefined) return;
  store.applyDocument(replaceSolid(store.document, featureId, setSolidSuppressed(feature, !feature.suppressed)));
}

/**
 * 選んだ点を原点にする(FR-331)。座標の式を書き換えるだけなので、文書を 1 回積めば Undo 1 回で
 * 戻る。動かした量は帯に一言で出す。位置が計算できていない点は断って何も変えない(FR-504)。
 */
export function setTreeOrigin(featureId: string): void {
  const store = useAppStore.getState();
  const change = originChangeFor(store, featureId);
  if (change === null) {
    store.setEditError('originCommand.failed');
    return;
  }
  store.applyDocument(change.document);
  store.setOriginNotice(change.notice);
}

/** 作る順序を入れ替える(FR-507)。押せるかどうか・断りの理由はストアの `moveTimelineItem` が決める。 */
export function moveTreeRow(featureId: string, toIndex: number): void {
  useAppStore.getState().moveTimelineItem(featureId, toIndex);
}
