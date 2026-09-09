/**
 * 表示のスライス(投影・様式・グリッド・断面表示・端末の設定・視点の要求)。
 *
 * ストアは 1 本のまま(rules/04-設計の規律.md)で、**書く場所だけ**を機能ごとに分けてある
 * (P6 タスク52)。`set` / `get` はどのスライスでも `AppState` 全体を指すので、
 * スライスをまたぐ読み書きは `get()` 経由で行い、スライス同士を import しない。
 */

import { type ExpressionValue, expressionValueFromNumber } from '@pointercad/expression';
import { DEFAULT_WORK_PLANE_ID, isBaseWorkPlaneId, type PlaneSpec } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import { type DisplaySettings, loadSettings, saveSettings } from '../settings/settings.js';
import type { AppState } from './appState.js';
import type { ViewCameraController } from '../viewport/namedCamera.js';
import { orbitFromNamedCamera } from '../viewport/namedCamera.js';
import { HOME_ORBIT, type OrbitState } from '../viewport/cameraMath.js';
import { createQuadCameraState, resetQuadCamera, updateQuadCamera, type QuadCameraState } from '../viewport/quadCamera.js';
import type { QuadViewId } from '../viewport/quadLayout.js';

/** 透視投影 / 平行投影(FR-102)。 */
export type ProjectionMode = 'perspective' | 'orthographic';

/** 表示スタイル 3 種(FR-105)。 */
export type DisplayStyle = 'shaded' | 'shadedWithEdges' | 'wireframe';

/**
 * ビューの断面表示(FR-111。P6 タスク34・35、計画書 §2.12、§0.40〜0.42)。
 *
 * **形は切らない。** ここにあるのは「どの面で、どれだけずらして、どちら側を残して
 * **見た目だけ**クリップするか」という表示の札で、`affectsShape` の経路には乗らない
 * (再計算を起こさない)。導出できる表示の状態なので `.pcad` にも書かない(rules/04)。
 *
 * 切断面の指定は P5 の切断(FR-432)と同じ `PlaneSpec` を共有する(要件 FR-111 の明記)。
 */
export interface SectionViewState {
  /** 切る面の決め方(FR-432 と共有)。既定は今の作図面(基準の 3 面)。 */
  readonly plane: PlaneSpec;
  /** 平面の法線方向へずらす量(mm、§0.42)。既定は 0。つまみのドラッグで変わる。 */
  readonly offsetMm: number;
  /** 残す側を反対にするか(§0.42 の裏返しのつまみ 1 つ)。 */
  readonly flipped: boolean;
}

/** 表示のスライスが持つ欄と操作。 */
export interface ViewSlice {
  readonly quadCamera: QuadCameraState | null;
  readonly setQuadViewEnabled: (enabled: boolean) => void;
  readonly setQuadActivePane: (pane: QuadViewId) => void;
  readonly setQuadOrbit: (orbit: OrbitState) => void;
  readonly resetQuadOrbit: () => void;
  readonly viewCameraController: ViewCameraController | null;
  readonly setViewCameraController: (controller: ViewCameraController | null) => void;
  readonly projection: ProjectionMode;
  readonly displayStyle: DisplayStyle;
  readonly showGrid: boolean;
  /**
   * ビューの断面表示(FR-111。P6 タスク35)。出していないときは `null` で、そのとき
   * 材質のクリッピング平面は空になる(費用ゼロ、NFR-PF-1)。
   *
   * **再計算を起こさない。** 入切しても体積も形も変わらず、`isComputing` も立たない。
   * 文書を作り直したら消える(平面の指定が古い文書の面を指したままになるため)ので、
   * `createInitialDocumentState` の側に置いてある。
   */
  readonly sectionView: SectionViewState | null;
  /**
   * 表示テーマと拡大率(FR-908、FR-909、§0.a-0.1〜0.3)。端末(`localStorage`)へ保存され、
   * 部品文書とは無関係な利用者・端末の好みなので `resetDocument`(新規)では戻さない。
   * ルート要素への反映(`data-theme` / `--pcad-scale`)は `shell/applyDisplaySettings.ts`。
   */
  readonly displaySettings: DisplaySettings;
  /** ホーム視点への復帰要求を数える(FR-108)。増えるたびにビューポートが反応する。 */
  readonly homeViewRequestCount: number;
  /**
   * 「視点に合わせる」の要求を数える(§0.a-0.3)。視点の正本は `attachCameraControls` に
   * あってストアからは読めないので、ビューポートが増加に気づいて今の視点を渡し返す。
   */
  readonly matchWorkPlaneRequestCount: number;
  /**
   * ビューポートへ焦点を戻す要求を数える。canvas を持っているのは
   * `attachSketchInteraction` だけなので、増加に気づいた向こう側が焦点を移す。
   * 道具を選んだ直後に Enter が効くようにするため(NFR-UX-1、NFR-UX-4)。
   */
  readonly focusViewportRequestCount: number;
  /**
   * コマンドラインの欄(FR-208、P4b タスク18)へ焦点を移す要求を数える。欄を持っているのは
   * `shell/CommandLine.tsx` だけなので、増加に気づいた向こう側が焦点を移す
   * (`focusViewportRequestCount` と対になる仕組み)。`AppShell.tsx` の `Space` が増やす。
   */
  readonly commandLineFocusRequestCount: number;
  /**
   * コマンドラインの欄に焦点があるか(FR-208、P4b タスク18)。
   *
   * ビューポート(`attachSketchInteraction.ts`)は React の外にいて、どこに焦点があるかを
   * props からは知れない。欄に焦点があるあいだの押下は「欄から出るための押下」として
   * 当たり判定を飛ばすので、その判定材料をここに置く(rules/04-設計の規律.md
   * 「フロントの状態は Zustand 1 本」。DOM を直接探しに行かない)。
   */
  readonly commandLineFocused: boolean;
  /** ビューポート区画の大きさ(画素)。その場入力を端で折り返すのに使う。 */
  readonly viewportSize: readonly [number, number];
  /**
   * 球面の案内線(球面グリッド、FR-431、P5 タスク21)の間隔(度)。**式のまま持つ**
   * (FR-201)ので `ExpressionValue`。既定は 5 度(§0.a-0.21)で、1 度未満と 90 度超は
   * 線が引けないので案内線そのものを出さない(`buildSphereGrid.ts` の断り)。
   *
   * **文書には持たない。** 見えるか見えないかだけを決める表示の設定で、形にも保存する
   * 内容にも 1 ミリも影響しないため(rules/04「導出できるものは保存しない」と同じ切り分けで、
   * 方眼の表示・表示スタイルと同じ側に置く)。
   */
  readonly sphereGridStep: ExpressionValue;
  /**
   * 球面の案内線をいつも出すか(FR-431「常時表示への切替」、§0.a-0.21)。
   * 既定は切で、そのときは**球を選んでいる間だけ**出る。
   */
  readonly sphereGridAlwaysVisible: boolean;
  readonly setProjection: (projection: ProjectionMode) => void;
  readonly setDisplayStyle: (displayStyle: DisplayStyle) => void;
  readonly setShowGrid: (showGrid: boolean) => void;
  /**
   * 断面表示(FR-111)の入切をひっくり返す。入れるときは**今の作図面**を切る面にし、
   * オフセット 0・表向きから始める(§0.42 の既定)。基準の 3 面でない作図面(任意の
   * 作業平面・3D スケッチ)のときは XY から始める——予告の解決(`resolveCutPlane`)が
   * 基準の 3 面しか引けないので、解けない面で始めて何も起きないのを避ける。
   *
   * **再計算を起こさない**(文書に触らない、`affectsShape` の経路を通らない)。
   */
  readonly toggleSectionView: () => void;
  /** 断面表示の状態を丸ごと差し替える(`null` で切る)。 */
  readonly setSectionView: (sectionView: SectionViewState | null) => void;
  /** 断面表示のオフセット(mm)だけを差し替える(つまみのドラッグ・その場の数値入力)。 */
  readonly setSectionOffset: (offsetMm: number) => void;
  /** 断面表示の残す側を反対にする(§0.42)。 */
  readonly flipSectionView: () => void;
  /** 表示テーマ・拡大率を差し替え、`localStorage` へ保存する(FR-908、FR-909)。 */
  readonly setDisplaySettings: (settings: DisplaySettings) => void;
  readonly requestHomeView: () => void;
  /** ビューポート(canvas)へ焦点を戻してほしい、と頼む。 */
  readonly requestViewportFocus: () => void;
  /** コマンドラインの欄へ焦点を移してほしい、と頼む(FR-208。`Space` の受け口)。 */
  readonly requestCommandLineFocus: () => void;
  /** コマンドラインの欄が焦点を得た・失ったことを知らせる(FR-208)。 */
  readonly setCommandLineFocused: (focused: boolean) => void;
  readonly setViewportSize: (size: readonly [number, number]) => void;
  /** 球面の案内線の間隔を式のまま差し替える(FR-431、FR-201)。 */
  readonly setSphereGridStep: (step: ExpressionValue) => void;
  /** 球面の案内線をいつも出すかを切り替える(FR-431)。 */
  readonly setSphereGridAlwaysVisible: (always: boolean) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(表示)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type ViewInitialState = Pick<
  ViewSlice,
  | 'sectionView'
  | 'sphereGridStep'
  | 'sphereGridAlwaysVisible'
>;

export const createViewSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<ViewSlice, keyof ViewInitialState>
> = (set) => ({
  quadCamera: null,
  setQuadViewEnabled: (enabled) => {
    set((state) => {
      if (!enabled) return state.quadCamera === null ? {} : { quadCamera: null };
      if (state.quadCamera !== null) return {};
      const captured = state.viewCameraController?.capture();
      return { quadCamera: createQuadCameraState(captured === undefined ? HOME_ORBIT : orbitFromNamedCamera(captured) ?? HOME_ORBIT) };
    });
  },
  setQuadActivePane: (pane) => {
    set((state) => state.quadCamera === null || state.quadCamera.active === pane ? {}
      : { quadCamera: { ...state.quadCamera, active: pane } });
  },
  setQuadOrbit: (orbit) => {
    set((state) => state.quadCamera === null ? {} : { quadCamera: updateQuadCamera(state.quadCamera, state.quadCamera.active, orbit) });
  },
  resetQuadOrbit: () => {
    set((state) => state.quadCamera === null ? {} : { quadCamera: resetQuadCamera(state.quadCamera) });
  },
  viewCameraController: null,
  setViewCameraController: (viewCameraController) => { set({ viewCameraController }); },
  projection: 'perspective',
  displayStyle: 'shadedWithEdges',
  showGrid: true,
  // 部品を作り直しても(resetDocument)戻さないので、文書まわりの初期値には含めない
  // (kernelLoaded と同じ扱い)。起動時に localStorage から読む(壊れていれば既定値)。
  displaySettings: loadSettings(),
  homeViewRequestCount: 0,
  matchWorkPlaneRequestCount: 0,
  focusViewportRequestCount: 0,
  // コマンドライン(FR-208、P4b タスク18)。文書を作り直しても要求の数は戻さないので、
  // ここ(createInitialDocumentState の外)に置く。欄の打ちかけは部品側が捨てる。
  commandLineFocusRequestCount: 0,
  commandLineFocused: false,
  viewportSize: [0, 0],
  setProjection: (projection) => {
    set({ projection });
  },
  setDisplayStyle: (displayStyle) => {
    set({ displayStyle });
  },
  setShowGrid: (showGrid) => {
    set({ showGrid });
  },
  toggleSectionView: () => {
    set((state) => ({
      sectionView:
        state.sectionView === null
          ? {
              plane: {
                kind: 'workPlane',
                // 基準の 3 面でない作図面は予告の解決が引けないので XY から始める。
                planeId: isBaseWorkPlaneId(state.workPlaneId)
                  ? state.workPlaneId
                  : DEFAULT_WORK_PLANE_ID,
                offset: expressionValueFromNumber(0),
              },
              offsetMm: 0,
              flipped: false,
            }
          : null,
    }));
  },
  setSectionView: (sectionView) => {
    set({ sectionView });
  },
  setSectionOffset: (offsetMm) => {
    /*
      数にならない値(式が解けなかった)は**据え置く**。断りは打ち込んだ欄の側が出すので、
      ここで NaN を覚えると次に描くたびに断りの経路へ落ちてしまう(操作は止めない、
      NFR-RE-1)。値が変わらないときも新しい物を作らない(NFR-PF-1。描き直しを呼ばない)。
    */
    set((state) =>
      state.sectionView === null ||
      !Number.isFinite(offsetMm) ||
      state.sectionView.offsetMm === offsetMm
        ? {}
        : { sectionView: { ...state.sectionView, offsetMm } },
    );
  },
  flipSectionView: () => {
    set((state) =>
      state.sectionView === null
        ? {}
        : { sectionView: { ...state.sectionView, flipped: !state.sectionView.flipped } },
    );
  },
  setDisplaySettings: (displaySettings) => {
    saveSettings(displaySettings);
    set({ displaySettings });
  },
  requestHomeView: () => {
    set((state) => ({ homeViewRequestCount: state.homeViewRequestCount + 1 }));
  },
  requestViewportFocus: () => {
    set((state) => ({ focusViewportRequestCount: state.focusViewportRequestCount + 1 }));
  },
  requestCommandLineFocus: () => {
    set((state) => ({
      commandLineFocusRequestCount: state.commandLineFocusRequestCount + 1,
    }));
  },
  setCommandLineFocused: (commandLineFocused) => {
    set({ commandLineFocused });
  },
  setViewportSize: (viewportSize) => {
    set({ viewportSize });
  },
  setSphereGridStep: (sphereGridStep) => {
    set({ sphereGridStep });
  },
  setSphereGridAlwaysVisible: (sphereGridAlwaysVisible) => {
    set({ sphereGridAlwaysVisible });
  },
});
