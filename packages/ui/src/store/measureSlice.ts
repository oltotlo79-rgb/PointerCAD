/**
 * 測定のスライス(FR-1101・FR-1102)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import type { StateCreator } from 'zustand';
import type { MessageKey } from '../i18n/t.js';
import {
  type MassPropertiesResult,
  type PartMeasurer,
  runMeasure,
} from '../solid/measureCommands.js';
import type { MeasurementState } from '../viewport/createMeasureLayer.js';
import type { AppState } from './appState.js';
import {
  calculateStrengthSession, createStrengthSession, editStrengthSession,
  type StrengthEdit, type StrengthSession,
} from '../strength/strengthSession.js';

/** 測定のスライスが持つ欄と操作。 */
export interface MeasureSlice {
  readonly strengthSession: StrengthSession | null;
  readonly toggleStrength: () => void;
  readonly closeStrength: () => void;
  readonly editStrength: (edit: StrengthEdit) => void;
  readonly calculateStrength: () => void;
  /**
   * いま画面に出している測定の結果(FR-1102、P5 タスク31)。無ければ null。
   *
   * ビューポートの層(`createMeasureLayer.ts`)が線・弧・端の丸・値の札を出し、
   * プロパティ欄(タスク32)が同じものを数字で出す。**測る・消すの操作はタスク32** で、
   * ここは「結果を持つ欄」と「いつ消えるか」だけを決める。
   *
   * **形が変わったら消す**(FR-1102「モデルを変更するまで残る」、§0.a-0.29)。判定は
   * `affectsShape` で、`applyDocument` / `undo` / `redo` の 3 か所が落とす。**外観だけの
   * 変更(FR-1106〜1110)では消えない**(形は 1 ミリも動いていないので、測った値は
   * そのまま正しい)。
   */
  readonly measurement: MeasurementState | null;
  /**
   * いま出している質量特性(FR-1101、P5 タスク32)。無ければ null。
   *
   * 体積・重心・慣性モーメントはカーネルが測った**密度を掛けていない**値で、
   * 材料と密度はプロパティ欄が持つ(材料を切り替えるたびに測り直さないため)。
   * 消える条件は `measurement` とまったく同じ(形の変更と Esc)。
   */
  readonly massProperties: MassPropertiesResult | null;
  /**
   * 測れなかった理由の文言キー(FR-1102、NFR-UX-5。P5 タスク32)。
   *
   * `appearanceErrorKey` と同じ扱いで、いま押した「測る」への返事。理由の文はそれだけで
   * 通じる 1 文(「測りたいものを 1 つか 2 つ選んでください。」)なので、帯は頭の言葉を
   * 付けずにそのまま出す。文書が変われば用済みなので `applyDocument` が落とす。
   */
  readonly measureErrorKey: MessageKey | null;
  /**
   * 覚えてある形を測る手立て(FR-1101、FR-1102。P5 タスク32)。
   *
   * カーネル(Worker)を持っているのは `PointerCadApp` だけなので、`PartRecomputer` と
   * 同じ流儀で外から差し出してもらう(`attachPartMeasure`)。差し出されていなければ
   * **一覧から出せる測定だけ**が効き、往復の要る測定(辺どうし・立体どうしの最短距離、
   * 質量特性)は理由つきで断られる(NFR-UX-5)。
   */
  readonly partMeasurer: PartMeasurer | null;
  /**
   * 測った結果を出す・消す(FR-1102、タスク32)。`null` を渡せば画面からも消える。
   * 質量特性(立体を選んだときだけ付く)も一緒に差し替えるので、
   * 「値は消えたのに重さだけ残る」状態にならない。
   */
  readonly setMeasurement: (
    measurement: MeasurementState | null,
    massProperties?: MassPropertiesResult | null,
  ) => void;
  /**
   * 測った結果を消す(FR-1102、§0.a-0.68 の Esc)。**何も測っていなければ何もしない**
   * ので、Esc の他の働き(道具の取り消し)を横取りするかどうかを呼ぶ側が
   * `measurement` の有無で決められる。
   */
  readonly clearMeasurement: () => void;
  /** 測れなかった理由を出す・消す(FR-1102、NFR-UX-5)。 */
  readonly setMeasureError: (key: MessageKey | null) => void;
  /**
   * いま選んでいるものを測る(FR-1101、FR-1102。ツールバーの「測る」とプロパティ欄の
   * 「測り直す」の**共通の入口**)。
   *
   * 判断と組み立ては `solid/measureCommands.ts` の `runMeasure` 1 か所に置き、ここは
   * 「ストアの値を渡す」「結果か理由を置く」だけにする。**文書は 1 バイトも変えない**ので
   * 取り消しの段も積まず、再計算も起きない(§0.a-0.30 の読み取り)。
   * 一覧から出せる測定はその場で終わり、往復の要るものだけカーネルを待つ(NFR-PF-4)。
   */
  readonly measureSelection: () => void;
  /** 形を測る手立てを差し出す・取り下げる(`attachPartMeasure` が呼ぶ)。 */
  readonly setPartMeasurer: (measurer: PartMeasurer | null) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(測定)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type MeasureInitialState = Pick<
  MeasureSlice,
  | 'measurement'
  | 'massProperties'
  | 'measureErrorKey'
  | 'partMeasurer'
  | 'strengthSession'
>;

export const createMeasureSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<MeasureSlice, keyof MeasureInitialState>
> = (set, get) => ({
  toggleStrength: () => {
    const state = get();
    set({ strengthSession: state.strengthSession === null ? createStrengthSession(state.displaySettings.lengthUnit) : null });
  },
  closeStrength: () => { set({ strengthSession: null }); },
  editStrength: edit => {
    const session = get().strengthSession;
    if (session !== null) set({ strengthSession: editStrengthSession(session, edit) });
  },
  calculateStrength: () => {
    const state = get();
    if (state.strengthSession !== null) set({ strengthSession: calculateStrengthSession(state.strengthSession, state.assembly?.parameters ?? state.document.parameters) });
  },
  setMeasurement: (measurement, massProperties = null) => {
    // 測った値を出したら、前の断りは用済み(NFR-UX-5「押したら必ず何かが起きる」)。
    set({ measurement, massProperties, measureErrorKey: null });
  },
  clearMeasurement: () => {
    const state = get();
    if (state.measurement === null && state.massProperties === null) {
      // 何も出していない。Esc の他の働き(道具の取り消し)へそのまま譲る(§0.a-0.68)。
      return;
    }
    set({ measurement: null, massProperties: null });
  },
  setMeasureError: (measureErrorKey) => {
    set({ measureErrorKey });
  },
  measureSelection: () => {
    const state = get();
    void runMeasure({
      document: state.document,
      selection: state.selection,
      // カーネルが返したボディはそのまま `MeasureBody`(体積つき)を満たす。
      bodies: state.bodies,
      measurer: state.partMeasurer,
      // 測定の帯は表示の単位で出す(FR-811、P6 タスク3 の残り。値は mm のまま)。
      lengthUnit: state.displaySettings.lengthUnit,
    }).then((outcome) => {
      // 待っているあいだに文書が変わっていることがあるので、置く先は取り直す。
      const after = get();
      if (outcome.ok) {
        after.setMeasurement(outcome.measurement, outcome.massProperties);
        return;
      }
      after.setMeasureError(outcome.reasonKey);
    });
  },
  setPartMeasurer: (partMeasurer) => {
    set({ partMeasurer });
  },
});
