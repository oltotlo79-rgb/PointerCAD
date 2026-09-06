/**
 * 選択のスライス(選択・ホバー・選択の種類・選択セット FR-112・外観 FR-1106)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import {
  addSelectionSetMembers,
  type AppearanceSpec,
  createSelectionSet,
  findSelectionSet,
  removeSelectionSet as removeSelectionSetFrom,
  renameSelectionSet as renameSelectionSetIn,
  type SelectionSetRefusal,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import {
  assignAppearanceToSelection,
  clearAllAppearance,
  removeAppearanceAt,
} from '../appearance/appearanceCommands.js';
import type { MessageKey } from '../i18n/t.js';
import {
  selectionKindForSet,
  selectionMembersOf,
  selectionSetElementIds,
} from '../solid/selectionSetCommands.js';
import { type SelectionKind, subShapeBodiesOf } from '../solid/subShapeSelection.js';
import type { AppState } from './appState.js';

/** 選択・選択セット・外観のスライスが持つ欄と操作。 */
export interface SelectionSlice {
  /** 選択中の要素 id(FR-106)。面を張るときは選んだ順に意味がある(FR-309)。 */
  readonly selection: readonly string[];
  /** ホバー中の要素 id(FR-106)。 */
  readonly hoveredElementId: string | null;
  /**
   * いま選ぶ部分形状の種類(FR-106、§0.a-0.6)。道具を選ぶと `setActiveTool` が自動で
   * 切り替える。手動の切替は `setSelectionKind`(`1`〜`4` キーの受け口はタスク26)。
   */
  readonly selectionKind: SelectionKind;
  /**
   * 外観を割り当てられなかった理由の文言キー(FR-1106〜1110、NFR-UX-5。P5 タスク11)。
   *
   * 断りは 4 通りで、いずれも**割り当てを作る前**に決まる(`appearanceCommands.ts`):
   * 選んでいるものが無い / 値が 0〜100 の外 / そのボディの材質が 9 種以上 /
   * まとまりが 33 個以上。`faceErrorKey` / `solidErrorKey` と同じ扱いで、
   * ステータスバーが理由の文をそのまま出す(それだけで通じる 1 文なので頭の言葉は付けない)。
   * 文書が変われば用済みなので `applyDocument` が落とす。
   */
  readonly appearanceErrorKey: MessageKey | null;
  /**
   * 選ぶ部分形状の種類を手動で切り替える(§0.a-0.6)。種類が変わったら、いまの選択のうち
   * 種類の合わないものを外す(違う種類の選択が加工の対象に紛れ込むのを防ぐ、NFR-UX-1)。
   */
  readonly setSelectionKind: (kind: SelectionKind) => void;
  /**
   * いま選んでいるものに名前を付けて覚える(FR-112)。作れたら `null`、断ったときは
   * 理由(いまは「名前が空」だけ)を返す。**断るときは文書を 1 バイトも変えない**
   * (NFR-UX-5。取り消しの段も積まない)。**再計算は走らない**(`affectsShape` が偽)。
   */
  readonly createSelectionSetFromSelection: (name: string) => SelectionSetRefusal | null;
  /** 組の名前を変える(FR-112)。断ったときは理由を返す。同じ名前は許す(§2.13)。 */
  readonly renameSelectionSet: (id: string, name: string) => SelectionSetRefusal | null;
  /** 組を 1 つ消す(FR-112)。取り消し(Ctrl+Z)1 回で戻る。 */
  readonly removeSelectionSet: (id: string) => void;
  /** いま選んでいるものを、既にある組へ足す(FR-112「後から足せる」)。 */
  readonly addSelectionToSet: (id: string) => void;
  /**
   * 組の中身を選択にする(FR-112「呼び出す」)。**引けなかった件数を返し**、画面が
   * 「n 件は見つかりませんでした」と知らせる(FR-504、§2.13。組そのものは残す)。
   */
  readonly selectSelectionSet: (id: string) => number;
  readonly setSelection: (ids: readonly string[]) => void;
  readonly toggleSelection: (id: string) => void;
  readonly setHovered: (id: string | null) => void;
  /** 外観を割り当てられなかった理由を出す・消す(FR-1106〜1110、NFR-UX-5)。 */
  readonly setAppearanceError: (key: MessageKey | null) => void;
  /**
   * いま選んでいる立体・面へ外観を割り当てる(FR-1106、FR-1107、FR-1109)。
   *
   * 判断は `appearance/appearanceCommands.ts` の純関数 1 か所に置き、ここは
   * 「文書を渡す」「断りを置く」だけにする。確定は `applyDocument` を通すので、
   * **取り消し(FR-505)と保存は 1 行も足さずに効く**。形は変わらないので
   * `affectsShape` が偽になり、再計算も計算中の札も起きない(§2.3)。
   */
  readonly assignAppearance: (spec: AppearanceSpec) => void;
  /** 割り当てを 1 つ外す(FR-1110)。 */
  readonly removeAppearance: (id: string) => void;
  /** すべての割り当てを外して既定の外観に戻す(FR-1110)。 */
  readonly clearAppearance: () => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(選択・選択セット・外観)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type SelectionInitialState = Pick<
  SelectionSlice,
  | 'selection'
  | 'hoveredElementId'
  | 'selectionKind'
  | 'appearanceErrorKey'
>;

export const createSelectionSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<SelectionSlice, keyof SelectionInitialState>
> = (set, get) => ({
  setSelectionKind: (selectionKind) => {
    // 変わらないときは選択を残す(手動切替でも自動切替と同じ規約、§0.a-0.6)。
    set((state) =>
      state.selectionKind === selectionKind ? {} : { selectionKind, selection: [] },
    );
  },
  createSelectionSetFromSelection: (name) => {
    const state = get();
    const members = selectionMembersOf(subShapeBodiesOf(state.bodies), state.selection);
    const outcome = createSelectionSet(state.document.selectionSets, name, members);
    if (!outcome.ok) {
      // 断るときは文書を 1 バイトも変えない(NFR-UX-5。取り消しの段も積まない)。
      return outcome.reason;
    }
    state.applyDocument({ ...state.document, selectionSets: outcome.sets });
    return null;
  },
  renameSelectionSet: (id, name) => {
    const state = get();
    const outcome = renameSelectionSetIn(state.document.selectionSets, id, name);
    if (!outcome.ok) {
      return outcome.reason;
    }
    if (outcome.sets !== state.document.selectionSets) {
      // 名前が変わらないときは文書を作り直さない(NFR-PF-1。購読側も動かさない)。
      state.applyDocument({ ...state.document, selectionSets: outcome.sets });
    }
    return null;
  },
  removeSelectionSet: (id) => {
    const state = get();
    const selectionSets = removeSelectionSetFrom(state.document.selectionSets, id);
    if (selectionSets === state.document.selectionSets) {
      return;
    }
    state.applyDocument({ ...state.document, selectionSets });
  },
  addSelectionToSet: (id) => {
    const state = get();
    const members = selectionMembersOf(subShapeBodiesOf(state.bodies), state.selection);
    const selectionSets = addSelectionSetMembers(state.document.selectionSets, id, members);
    if (selectionSets === state.document.selectionSets) {
      // 1 件も増えないとき(同じ面をもう一度足した)は文書を作り直さない。
      return;
    }
    state.applyDocument({ ...state.document, selectionSets });
  },
  selectSelectionSet: (id) => {
    const state = get();
    const found = findSelectionSet(state.document.selectionSets, id);
    if (found === undefined) {
      return 0;
    }
    const outcome = selectionSetElementIds(subShapeBodiesOf(state.bodies), found);
    /*
      選ぶ種類を**先に**合わせる。`setSelectionKind` は種類が変わると選択を空にするので、
      順序を逆にすると選んだそばから消える(§0.a-0.6)。
    */
    state.setSelectionKind(selectionKindForSet(found));
    state.setSelection(outcome.elementIds);
    return outcome.missingCount;
  },
  setSelection: (selection) => {
    // 選び直したら、直前に断られた面・立体・オフセットの理由は用済みなので消す(NFR-UX-5)。
    set({
      selection,
      faceErrorKey: null,
      solidErrorKey: null,
      editErrorKey: null,
      appearanceErrorKey: null,
      editNoticeKey: null,
    });
  },
  toggleSelection: (id) => {
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((selected) => selected !== id)
        : [...state.selection, id],
      faceErrorKey: null,
      solidErrorKey: null,
      editErrorKey: null,
      appearanceErrorKey: null,
      editNoticeKey: null,
    }));
  },
  setHovered: (hoveredElementId) => {
    set({ hoveredElementId });
  },
  setAppearanceError: (appearanceErrorKey) => {
    set({ appearanceErrorKey });
  },
  assignAppearance: (spec) => {
    const state = get();
    const outcome = assignAppearanceToSelection(
      {
        document: state.document,
        bodies: subShapeBodiesOf(state.bodies),
        selection: state.selection,
        selectionKind: state.selectionKind,
        matches: state.appearanceMatches,
      },
      spec,
    );
    if (!outcome.ok) {
      // 断ったときは文書を 1 バイトも変えない(NFR-UX-5)。理由だけを帯へ置く。
      state.setAppearanceError(outcome.reasonKey);
      return;
    }
    // `applyDocument` は前の断りを落とすので、消す処理をここに書く必要はない。
    state.applyDocument(outcome.document);
  },
  removeAppearance: (id) => {
    const state = get();
    state.applyDocument(removeAppearanceAt(state.document, id));
  },
  clearAppearance: () => {
    const state = get();
    state.applyDocument(clearAllAppearance(state.document));
  },
});
