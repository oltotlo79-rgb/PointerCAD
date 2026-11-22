/**
 * 表示設定(テーマと拡大率)の型と
 * 永続化。
 *
 * 対応要件: FR-908(表示テーマの切替、5 種、既定はダーク、端末に保存)、
 * FR-909(表示の拡大率、90〜150%、端末に保存)。どちらも「再起動なしに即時反映」
 * と「端末に保存」(`localStorage`)が要件。
 *
 * ここは DOM に触れない純関数だけを持つ。ルート要素(`document.documentElement`)への
 * 反映は `packages/ui/src/shell/applyDisplaySettings.ts` が担う。ストアの状態
 * (`displaySettings` / `setDisplaySettings`)は `packages/ui/src/store/useAppStore.ts`。
 */

import { DEFAULT_CAMERA_CONTROLS, cameraSettingsError, readCameraControlSettings, type CameraControlSettings } from './cameraControlSettings.js';
import { DEFAULT_VIEW_CONTROLS, isViewControlSettings, readStoredViewControls, type ViewControlSettings } from './viewControlSettings.js';

import { belowMagnitude, LENGTH_UNITS, type LengthUnit } from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { EMPTY_SHORTCUT_ASSIGNMENTS, type ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { readMouseButtonCommands, type MouseButtonCommands } from '../commands/pointerCommandGesture.js';
import { readRadialCommands, type RadialCommands } from '../commands/radialCommandSettings.js';
import { readStoredShortcutAssignments, storedShortcutFields } from './shortcutSettings.js';
import { DEFAULT_SELECTION_MODIFIER, selectionModifierOf, type SelectionModifier } from './selectionModifierSetting.js';
import { DEFAULT_SNAP_PAUSE_MODIFIER, snapPauseModifierOf, type SnapPauseModifier } from './snapPauseSetting.js';
import { DEFAULT_SNAP_RADIUS, snapRadiusChoiceOf, type SnapRadiusChoice } from './snapRadiusSetting.js';
import { DEFAULT_GRID_SETTING, gridSettingOf, type GridSetting } from './gridSetting.js';
import type { NumericDefaultSources } from '../sketch/numericDefaultSources.js';
import { DEFAULT_TRACK_ANGLE_STEP, TRACK_ANGLE_STEPS } from '../sketch/trackMath.js';
import {
  ALL_SELECTABLE,
  isSelectionFilter,
  type SelectionFilter,
} from '../solid/selectionFilter.js';
import { readAutoSaveIntervalMs } from './autoSaveSettings.js';
import { readNumericToolDefaults } from './numericToolDefaults.js';
import { DEFAULT_STOCK_CUTTING, readStockCuttingSettings, type StockCuttingSettings } from '../assembly/stockCuttingSettings.js';

/** 表示テーマ 5 種(FR-908)。既定は `dark`(現状の配色をそのまま複製)。 */
export type ThemeId = 'dark' | 'light' | 'darkModern' | 'lightModern' | 'modern';

/** 5 種の並び。設定パネルの見本カードもこの順に並べる(1 か所で決める)。 */
export const THEME_IDS: readonly ThemeId[] = [
  'dark',
  'light',
  'darkModern',
  'lightModern',
  'modern',
];

export interface DisplaySettings {
  /**
   * 視点の操作の v1。**凍結**: 新しい版は viewControls が無い時の移行にだけ読み、書き換えない
   * (古い版へ戻した時に、古い版が読める控え)。読める値は受け取ったまま書き戻す。
   */
  readonly cameraControls?: CameraControlSettings;
  /** 視点の操作の v2(正本)。読むのは viewControlSettings.ts の currentViewControls だけ。 */
  readonly viewControls?: ViewControlSettings;
  /**
   * 起動時に読めなかったため既定へ戻した、視点の操作の項目の数(無い・0 は知らせない)。
   * **表示だけの値で保存しない**(saveSettings が外す)。視点の設定を適用すると消える。
   */
  readonly viewControlsRecovered?: number;
  readonly tutorialCompleted?: boolean;
  readonly screenTourSeen?: boolean;
  readonly shortcutAssignments?: ShortcutAssignments;
  /**
   * 起動時に読めなかったため外したキーの割当の件数(無い・0 は知らせない)。**表示だけの値で保存しない**。
   * キーの割当を適用すると消える(shortcutSettings.ts の prepareShortcutSettings)。
   */
  readonly shortcutAssignmentsRecovered?: number;
  /** マウスの戻る・進むボタンと中ボタンのダブルクリックの命令(B-08e)。既定は無し。 */
  readonly mouseButtonCommands?: MouseButtonCommands;
  /** 起動時に読めなかったため外したマウスのボタンの割当の件数(無い・0 は知らせない)。**表示だけの値で保存しない**。 */
  readonly mouseButtonCommandsRecovered?: number;
  /** 放射メニューの中身(B-08f)。文書の種類ごとの 8 つ。欄の無い種類は既定。 */
  readonly radialCommands?: RadialCommands;
  /** 起動時に読めなかったため既定へ戻した放射メニューの種類の数(無い・0 は知らせない)。**表示だけの値で保存しない**。 */
  readonly radialCommandsRecovered?: number;
  readonly numericToolDefaults?: NumericDefaultSources;
  /** 旧設定は未指定のまま5分。1～60分の間隔を端末へ保存する。 */
  readonly autoSaveIntervalMs?: number;
  /** 切断の一覧の定尺・切断代(J-01)。端末に覚え、文書には保存しない。無い時は 定尺 なし・切断代 0。 */
  readonly stockCutting?: StockCuttingSettings;
  /** 選択に足す・外す修飾キー。欄の無い旧設定は場所ごとの動き。 */
  readonly selectionModifier?: SelectionModifier;
  /** 作図で、押している間だけ吸着と推定を止める修飾キー(B-09 3-2)。既定は 'none'(止めない)。 */
  readonly snapPauseModifier?: SnapPauseModifier;
  /** 吸着の幅(配置の補助 P-D)。点の吸着と部品の頂点への吸着の半径を決める。既定は 'medium'(今までと同じ半径)。 */
  readonly snapRadius?: SnapRadiusChoice;
  /** 方眼の幅と数(配置の補助 P-C)。既定は自動(今までと同じ。カメラの距離で幅が決まる)。 */
  readonly grid?: GridSetting;
  readonly theme: ThemeId;
  /** 表示の拡大率(%)。90〜150(FR-909)。 */
  readonly uiScale: number;
  /**
   * 向きの吸着(FR-110)の角度の刻み(度)。`TRACK_ANGLE_STEPS` の 6 つ
   * (5 / 10 / 15 / 30 / 45 / 90)から選ぶ。既定は 15(利用者の決定)。
   *
   * テーマや拡大率と同じ「端末に覚える設定」なので、同じ 1 つの鍵へまとめて入れる
   * (`localStorage` の鍵を増やさない)。
   */
  readonly trackAngleStep: number;
  /**
   * タイムラインのつまみ(FR-507)の初回の案内を、もう見せたか
   * (利用者の決定①「つまみは控えめのまま+初回だけ帯に案内」)。
   *
   * ソリッドが初めて 2 段以上になったときに 1 度だけ帯へ「左端のつまみを引くと途中まで
   * 戻せます」を出し、その時に true にする。**端末に覚える**ので、同じ人に二度は出ない。
   * テーマや刻み角度と同じ性質の値なので、`localStorage` の鍵を増やさず同じ 1 つへ入れる。
   */
  readonly timelineHintSeen: boolean;
  /**
   * 画面に出す長さの単位(FR-811)。既定は `'mm'`。
   *
   * **端末の設定であって文書の属性ではない**。内部の値は常に mm 固定で、
   * 換算するのは表示と入力の境目だけなので、ここを切り替えても `.pcad` のバイト列は
   * 1 バイトも変わらない(NFR-RE-3。`settings.test.ts` で固定する)。
   *
   * テーマ・拡大率・刻み角度と同じ「端末に覚える設定」なので、`localStorage` の鍵を
   * 増やさず同じ 1 つの `DisplaySettings` へ入れる。
   */
  readonly lengthUnit: LengthUnit;
  /**
   * 選択フィルタ(FR-112)。**既定は全部入**で、フィルタの無い時の操作を 1 つも変えない。
   *
   * **端末の設定であって文書の属性ではない**(切っても形は変わらず `.pcad` にも
   * 書かない)。テーマ・拡大率・刻み角度・単位と同じ性質なので、`localStorage` の鍵を
   * 増やさず同じ 1 つの `DisplaySettings` へ入れる。
   */
  readonly selectionFilter: SelectionFilter;
  /**
   * 拘束の自動推定(FR-333)の入切。**既定は入**(利用者の決定)。
   * 切ると線を引いている最中の予告の印が 1 つも出ず、確定しても
   * 拘束は足されない。
   *
   * **端末の設定であって文書の属性ではない**(切っても既にある拘束は消えず、`.pcad` にも
   * 書かない)。テーマ・拡大率・刻み角度・単位・選択フィルタと同じ性質なので、
   * `localStorage` の鍵を増やさず同じ 1 つの `DisplaySettings` へ入れる。
   */
  readonly inferConstraints: boolean;
}

/** 端末に保存する欄。viewControlsRecovered と shortcutAssignmentsRecovered は表示だけの値なので含まない。 */
export type PersistedDisplaySettings = Omit<DisplaySettings, 'viewControlsRecovered' | 'shortcutAssignmentsRecovered'
  | 'mouseButtonCommandsRecovered' | 'radialCommandsRecovered'>;

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  cameraControls: DEFAULT_CAMERA_CONTROLS,
  viewControls: DEFAULT_VIEW_CONTROLS,
  tutorialCompleted: false,
  screenTourSeen: false,
  shortcutAssignments: EMPTY_SHORTCUT_ASSIGNMENTS,
  // 読み込みの時の循環でも初期化の前の値を読まないよう、空の値はここで作る(readMouseButtonCommands の空と同じ形)。
  mouseButtonCommands: Object.freeze({}),
  radialCommands: Object.freeze({}),
  numericToolDefaults: {},
  autoSaveIntervalMs: readAutoSaveIntervalMs({}),
  stockCutting: DEFAULT_STOCK_CUTTING,
  selectionModifier: DEFAULT_SELECTION_MODIFIER,
  snapPauseModifier: DEFAULT_SNAP_PAUSE_MODIFIER,
  snapRadius: DEFAULT_SNAP_RADIUS,
  grid: DEFAULT_GRID_SETTING,
  theme: 'dark',
  uiScale: 100,
  trackAngleStep: DEFAULT_TRACK_ANGLE_STEP,
  timelineHintSeen: false,
  lengthUnit: 'mm',
  selectionFilter: ALL_SELECTABLE,
  inferConstraints: true,
};
const MIN_UI_SCALE = 90;
const MAX_UI_SCALE = 150;

/** `localStorage` に持つ唯一のキー。値は `DisplaySettings` の JSON。 */
const STORAGE_KEY = 'pointercad.settings';

// ---------------------------------------------------------------------------
// 検証(壊れている・無い・範囲外はすべて既定値へ、NFR-UX-4)
// ---------------------------------------------------------------------------

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.some((id) => id === value);
}

/** 90〜150 の範囲内の有限数か。範囲外は「個別に丸めず既定へ戻す」対象にする。 */
function isValidUiScale(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_UI_SCALE &&
    value <= MAX_UI_SCALE
  );
}

/** 角度の刻みとして選べる 6 つのどれかか。中間の値は受け付けない。 */
function isValidTrackAngleStep(value: unknown): value is number {
  return typeof value === 'number' && TRACK_ANGLE_STEPS.some((step) => step === value);
}

/** 保存されている値のうち、最初からあった 2 欄。 */
interface StoredDisplayCore {
  readonly theme: ThemeId;
  readonly uiScale: number;
}

/**
 * 保存されている形として妥当か。`theme` と `uiScale` のどちらか一方でも壊れていれば
 * 全体を捨てて既定値に戻す(1 つの欄が壊れていても部分的に採用しない。
 * 自動保存の控えの壊れ方への対処と同じ判断)。
 */
function hasValidDisplayCore(value: unknown): value is StoredDisplayCore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'theme' in value &&
    'uiScale' in value &&
    isThemeId(value.theme) &&
    isValidUiScale(value.uiScale)
  );
}

/**
 * 保存されている値から角度の刻みを読む。**この欄だけは欄ごとに既定へ後退させる。**
 *
 * 理由: この欄は後から足したので、それより前に保存された値には**無いのが正常**である。
 * 上の「1 つでも壊れていたら全部捨てる」をこの欄にも当てはめると、前の版から使っている
 * 利用者のテーマと拡大率まで既定へ戻ってしまう(必須の欄を足して旧いデータが読めなく
 * なった過去の差し戻しと同じ前方互換の問題)。
 * 欄はあるが値が壊れている・範囲外のときも、同じ理由でこの欄だけを既定へ戻す(NFR-UX-4)。
 */
function readTrackAngleStep(value: object): number {
  if (!('trackAngleStep' in value) || !isValidTrackAngleStep(value.trackAngleStep)) {
    return DEFAULT_DISPLAY_SETTINGS.trackAngleStep;
  }
  return value.trackAngleStep;
}

/**
 * 保存されている値からつまみの案内の既読を読む。
 * **この欄も欄ごとに既定へ後退させる**(`readTrackAngleStep` と同じ前方互換の理由。
 * この欄より前に保存された値にはこの欄が無いのが正常で、無いことを理由にテーマまで
 * 既定へ戻してはいけない)。既読でない側(false)へ倒すので、壊れていても案内は出る。
 */
function readTimelineHintSeen(value: object): boolean {
  if (!('timelineHintSeen' in value) || typeof value.timelineHintSeen !== 'boolean') {
    return DEFAULT_DISPLAY_SETTINGS.timelineHintSeen;
  }
  return value.timelineHintSeen;
}

/**
 * 保存されている値から表示の長さの単位を読む(FR-811)。
 * **この欄も欄ごとに既定へ後退させる**(`readTrackAngleStep` と同じ前方互換の理由。
 * この欄より前に保存された値にはこの欄が無いのが正常で、無いことを理由にテーマまで
 * 既定へ戻してはいけない)。知らない綴り(`'cm'` など)も同じく `'mm'` へ戻す。
 *
 * 選べる単位の正本は model の `LENGTH_UNITS` 1 か所だけで、ここは写しを作らない
 * (`isValidTrackAngleStep` が `TRACK_ANGLE_STEPS` を見るのと同じ流儀)。
 */
function readLengthUnit(value: object): LengthUnit {
  if (!('lengthUnit' in value)) {
    return DEFAULT_DISPLAY_SETTINGS.lengthUnit;
  }
  const stored: unknown = value.lengthUnit;
  const found = LENGTH_UNITS.find((unit) => unit === stored);
  return found ?? DEFAULT_DISPLAY_SETTINGS.lengthUnit;
}

/**
 * 保存されている値から選択フィルタを読む(FR-112)。
 * **この欄も欄ごとに既定へ後退させる**(`readTrackAngleStep` と同じ前方互換の理由。
 * この欄より前に保存された値にはこの欄が無いのが正常で、無いことを理由にテーマまで
 * 既定へ戻してはいけない)。**戻り先は全部入**なので、壊れていても選べなくならない
 * (NFR-UX-4。「何も選べない」状態のまま起動するのがいちばん困る)。
 */
function readSelectionFilter(value: object): SelectionFilter {
  if (!('selectionFilter' in value) || !isSelectionFilter(value.selectionFilter)) {
    return DEFAULT_DISPLAY_SETTINGS.selectionFilter;
  }
  // 余計な欄が混ざっていても 4 欄だけを写す(保存された形をそのまま持ち回らない)。
  const { vertex, edge, face, body } = value.selectionFilter;
  return { vertex, edge, face, body };
}

/**
 * 保存されている値から拘束の自動推定の入切を読む(FR-333)。
 * **この欄も欄ごとに既定へ後退させる**(`readTrackAngleStep` と同じ前方互換の理由。
 * この欄より前に保存された値にはこの欄が無いのが正常で、無いことを理由にテーマまで
 * 既定へ戻してはいけない)。**戻り先は入**(既定)なので、壊れていても
 * 推定は効いたままになる。
 */
function readInferConstraints(value: object): boolean {
  if (!('inferConstraints' in value) || typeof value.inferConstraints !== 'boolean') {
    return DEFAULT_DISPLAY_SETTINGS.inferConstraints;
  }
  return value.inferConstraints;
}

/**
 * ステータスバーの札に出す文言のキー(FR-811)。**文言は ja.json**(NFR-MA-5)。
 * 単位が増えたら型検査がここを落とすので、札の文言を足し忘れない。
 */
export const LENGTH_UNIT_LABEL_KEYS: Readonly<Record<LengthUnit, MessageKey>> = {
  mm: 'statusBar.unitMillimeter',
  inch: 'statusBar.unitInch',
};

/**
 * 札を押したときに次に選ばれる単位(FR-811)。選択肢が 2 つなので入れ替えるだけにする。
 *
 * 一覧(`LENGTH_UNITS`)を順に送る書き方にしてあるので、単位が 3 つ目に増えても
 * 押すたびに順ぐりに回る(テーマの見本カードの `nextThemeIndex` と同じ考え方)。
 */
export function nextLengthUnit(unit: LengthUnit): LengthUnit {
  // 一覧に無い値(-1)のときは先頭から送り始める(`nextThemeIndex` と同じ受け方)。
  const index = LENGTH_UNITS.indexOf(unit);
  return LENGTH_UNITS[index < 0 ? 0 : (index + 1) % LENGTH_UNITS.length];
}

/** 拡大率を 90〜150 の範囲内へ丸める(スライダー等、利用者の入力をその場で丸める用途)。 */
export function clampUiScale(value: number): number {
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, value));
}

// ---------------------------------------------------------------------------
// 設定パネルが使う刻みとキー操作(ここも DOM に触れない純関数)
// ---------------------------------------------------------------------------

/**
 * 拡大率の段(%)。90〜150(FR-909)を、迷わず押せる 5 つに絞る。
 *
 * 連続のつまみ(スライダー)ではなく段にしたのは、①つまみは掴んで動かす細かい操作が要り、
 * ②いまいくつなのかを別に数字で出さないと読めないため(NFR-UX-1「説明を読まずに触れる」)。
 * 100 の前後を 10% 刻みで、大きくしたい人向けに 125 と 150 を置く。
 */
export const UI_SCALE_STEPS: readonly number[] = [90, 100, 110, 125, 150];

/**
 * 与えた拡大率にいちばん近い段。**どの値でも必ず 1 つの段が選ばれた状態になる**ので、
 * 段に無い値(前の版で保存された値など)でも設定パネルが空白にならない(NFR-UX-4)。
 * 同じ距離なら小さいほうを選ぶ。数でない値は既定(100)。
 */
export function nearestUiScaleStep(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_DISPLAY_SETTINGS.uiScale;
  }
  const target = clampUiScale(value);
  let nearest = UI_SCALE_STEPS[0];
  for (const step of UI_SCALE_STEPS) {
    if (belowMagnitude(step - target, Math.abs(nearest - target))) {
      nearest = step;
    }
  }
  return nearest;
}

const FORWARD_KEYS: readonly string[] = ['ArrowRight', 'ArrowDown'];
const BACKWARD_KEYS: readonly string[] = ['ArrowLeft', 'ArrowUp'];

/**
 * 矢印キーでテーマの見本カードを送ったときの、次に選ぶ番号(端は反対側へ回る)。
 * Home / End は先頭 / 末尾。それ以外のキーでは null を返し、押した側は何もしない。
 *
 * 選択肢が並ぶ操作の作法(WAI-ARIA の radiogroup)に合わせる: Tab では中へ入るだけ、
 * 中の移動と選択は矢印で行う(NFR-UX-7)。
 */
export function nextThemeIndex(currentIndex: number, key: string): number | null {
  const count = THEME_IDS.length;
  // 見つからなかった(-1)ときは先頭から動かし始める。
  const from = currentIndex < 0 ? 0 : currentIndex % count;
  if (FORWARD_KEYS.includes(key)) {
    return (from + 1) % count;
  }
  if (BACKWARD_KEYS.includes(key)) {
    return (from + count - 1) % count;
  }
  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return count - 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// localStorage の有無(型ガードで絞る。`as` は使わない)
// ---------------------------------------------------------------------------

/** `loadSettings` / `saveSettings` が読み書きに使う最小限の形。`Storage` の一部だけを使う。 */
export interface SettingsStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

function isSettingsStorage(value: unknown): value is SettingsStorage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getItem' in value &&
    typeof value.getItem === 'function' &&
    'setItem' in value &&
    typeof value.setItem === 'function'
  );
}

/**
 * 実行環境の `localStorage`。無ければ null。
 *
 * プライベートブラウジング等、`localStorage` という欄に**触れるだけで例外を投げる**
 * 実装があるため、存在確認そのものを try/catch で包む(`fileGateway.ts` の
 * `hasFileSystemAccess` と同じ「検査用に相手を引数で受ける」流儀に、例外を
 * 握りつぶす一手間を足す)。
 */
function browserStorage(scope: object = globalThis): SettingsStorage | null {
  try {
    if (!('localStorage' in scope)) {
      return null;
    }
    return isSettingsStorage(scope.localStorage) ? scope.localStorage : null;
  } catch {
    return null;
  }
}

/** `localStorage` が使える環境か。検査で偽の `globalThis` を渡せるよう相手を引数で受ける。 */
export function hasLocalStorage(scope: object = globalThis): boolean {
  return browserStorage(scope) !== null;
}

// ---------------------------------------------------------------------------
// 読み書き
// ---------------------------------------------------------------------------

/**
 * 保存されている表示設定を読む。壊れている・無い・範囲外・`localStorage` が
 * 使えない環境のいずれでも既定値を返す(NFR-UX-4)。例外は外へ出さない。
 */
export function loadSettings(storage: SettingsStorage | null = browserStorage()): DisplaySettings {
  if (storage === null) {
    return DEFAULT_DISPLAY_SETTINGS;
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_DISPLAY_SETTINGS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!hasValidDisplayCore(parsed)) {
      return DEFAULT_DISPLAY_SETTINGS;
    }
    // 視点の操作は読めない部分だけを既定へ戻し、戻した数を表示だけの欄に置く(他の欄には影響しない)。
    const view = readStoredViewControls(parsed);
    // キーの割当も読めない 1 件だけを外し、外した数を表示だけの欄に置く(設計 R6)。
    const shortcuts = readStoredShortcutAssignments(parsed);
    // マウスのボタンの割当(B-08e)も、知らない入力・無い命令の 1 件だけを外す。
    const mouse = readMouseButtonCommands('mouseButtonCommands' in parsed ? parsed.mouseButtonCommands : undefined);
    const radial = readRadialCommands('radialCommands' in parsed ? parsed.radialCommands : undefined);
    return {
      cameraControls: readCameraControlSettings('cameraControls' in parsed ? parsed.cameraControls : undefined),
      viewControls: view.settings,
      ...(view.dropped > 0 ? { viewControlsRecovered: view.dropped } : {}),
      tutorialCompleted: 'tutorialCompleted' in parsed && parsed.tutorialCompleted === true,
      screenTourSeen: 'screenTourSeen' in parsed && parsed.screenTourSeen === true,
      shortcutAssignments: shortcuts.assignments,
      ...(shortcuts.dropped > 0 ? { shortcutAssignmentsRecovered: shortcuts.dropped } : {}),
      mouseButtonCommands: mouse.commands,
      ...(mouse.dropped > 0 ? { mouseButtonCommandsRecovered: mouse.dropped } : {}),
      radialCommands: radial.commands,
      ...(radial.dropped > 0 ? { radialCommandsRecovered: radial.dropped } : {}),
      theme: parsed.theme,
      uiScale: parsed.uiScale,
      trackAngleStep: readTrackAngleStep(parsed),
      timelineHintSeen: readTimelineHintSeen(parsed),
      lengthUnit: readLengthUnit(parsed),
      selectionFilter: readSelectionFilter(parsed),
      inferConstraints: readInferConstraints(parsed),
      numericToolDefaults: readNumericToolDefaults('numericToolDefaults' in parsed ? parsed.numericToolDefaults : undefined),
      autoSaveIntervalMs: readAutoSaveIntervalMs('autoSaveIntervalMs' in parsed ? { autoSaveIntervalMs: parsed.autoSaveIntervalMs } : {}),
      stockCutting: readStockCuttingSettings('stockCutting' in parsed ? parsed.stockCutting : undefined),
      selectionModifier: selectionModifierOf('selectionModifier' in parsed ? parsed.selectionModifier : undefined) ?? DEFAULT_SELECTION_MODIFIER,
      // 知らない値は既定へ戻す(止めない側へ倒す。今までと同じ動き)。
      snapPauseModifier: snapPauseModifierOf('snapPauseModifier' in parsed ? parsed.snapPauseModifier : undefined) ?? DEFAULT_SNAP_PAUSE_MODIFIER,
      // 吸着の幅の知らない値も既定(今までと同じ半径)へ戻す。
      snapRadius: snapRadiusChoiceOf('snapRadius' in parsed ? parsed.snapRadius : undefined) ?? DEFAULT_SNAP_RADIUS,
      // 方眼の幅と数の形・範囲の違う値も既定(自動)へ戻す。
      grid: gridSettingOf('grid' in parsed ? parsed.grid : undefined) ?? DEFAULT_GRID_SETTING,
    };
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

/** 端末に保存されている v1 のキーの割当(読めない・無い時は undefined)。新しい版は書き換えず、そのまま書き戻す。 */
function storedLegacyShortcuts(storage: SettingsStorage): unknown {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && 'shortcutAssignments' in parsed ? parsed.shortcutAssignments : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 表示設定を保存する。`localStorage` が使えない環境(プライベートモード等)では
 * 黙って諦める(操作は止めない、NFR-RE-1)。
 */
export function saveSettings(
  settings: DisplaySettings,
  storage: SettingsStorage | null = browserStorage(),
): void {
  if (storage === null || (settings.cameraControls !== undefined && cameraSettingsError(settings.cameraControls) !== null)
    || (settings.viewControls !== undefined && !isViewControlSettings(settings.viewControls))) {
    return;
  }
  try {
    // 読めなかった数は表示だけの値なので書かない(undefined の欄は JSON に出ない)。キーの割当は新しい形で書き、
    // v1 の欄は保存されていた値をそのまま残す(storedShortcutFields)。
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, viewControlsRecovered: undefined, shortcutAssignmentsRecovered: undefined,
      mouseButtonCommandsRecovered: undefined, radialCommandsRecovered: undefined,
      ...storedShortcutFields(settings.shortcutAssignments, storedLegacyShortcuts(storage)) }));
  } catch {
    // 書き込み枠が塞がっている等。表示は既に切り替わっているので操作は止めない。
  }
}
