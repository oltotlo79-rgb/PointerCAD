/**
 * 表示設定(テーマと拡大率)の型と永続化(計画書 docs/plans/P4-スケッチ拡張.md タスク1、
 * §0.a-0.1〜0.3、§2.2)。
 *
 * 対応要件: FR-908(表示テーマの切替、5 種、既定はダーク、端末に保存)、
 * FR-909(表示の拡大率、90〜150%、端末に保存)。どちらも「再起動なしに即時反映」
 * (§0.a-0.1・0.2)と「端末に保存」(§0.a-0.3、`localStorage`)が要件。
 *
 * ここは DOM に触れない純関数だけを持つ。ルート要素(`document.documentElement`)への
 * 反映は `packages/ui/src/shell/applyDisplaySettings.ts` が担う。ストアの状態
 * (`displaySettings` / `setDisplaySettings`)は `packages/ui/src/store/useAppStore.ts`。
 */

import { DEFAULT_TRACK_ANGLE_STEP, TRACK_ANGLE_STEPS } from '../sketch/trackMath.js';

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
  readonly theme: ThemeId;
  /** 表示の拡大率(%)。90〜150(FR-909)。 */
  readonly uiScale: number;
  /**
   * 向きの吸着(FR-110)の角度の刻み(度)。`TRACK_ANGLE_STEPS` の 6 つ
   * (5 / 10 / 15 / 30 / 45 / 90)から選ぶ。既定は 15(§0.12 の利用者の決定)。
   *
   * テーマや拡大率と同じ「端末に覚える設定」なので、同じ 1 つの鍵へまとめて入れる
   * (`localStorage` の鍵を増やさない)。
   */
  readonly trackAngleStep: number;
  /**
   * タイムラインのつまみ(FR-507)の初回の案内を、もう見せたか
   * (利用者の決定①(2026-09-05)「つまみは控えめのまま+初回だけ帯に案内」、P4b タスク22b)。
   *
   * ソリッドが初めて 2 段以上になったときに 1 度だけ帯へ「左端のつまみを引くと途中まで
   * 戻せます」を出し、その時に true にする。**端末に覚える**ので、同じ人に二度は出ない。
   * テーマや刻み角度と同じ性質の値なので、`localStorage` の鍵を増やさず同じ 1 つへ入れる。
   */
  readonly timelineHintSeen: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  theme: 'dark',
  uiScale: 100,
  trackAngleStep: DEFAULT_TRACK_ANGLE_STEP,
  timelineHintSeen: false,
};
export const MIN_UI_SCALE = 90;
export const MAX_UI_SCALE = 150;

/** `localStorage` に持つ唯一のキー。値は `DisplaySettings` の JSON。 */
const STORAGE_KEY = 'pointercad.settings';

// ---------------------------------------------------------------------------
// 検証(壊れている・無い・範囲外はすべて既定値へ、NFR-UX-4)
// ---------------------------------------------------------------------------

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.some((id) => id === value);
}

/** 90〜150 の範囲内の有限数か。範囲外は「個別に丸めず既定へ戻す」対象にする(タスク1の検証表)。 */
function isValidUiScale(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_UI_SCALE &&
    value <= MAX_UI_SCALE
  );
}

/** 角度の刻みとして選べる 6 つのどれかか(§0.12)。中間の値は受け付けない。 */
function isValidTrackAngleStep(value: unknown): value is number {
  return typeof value === 'number' && TRACK_ANGLE_STEPS.some((step) => step === value);
}

/** 保存されている値のうち、P4 までにもあった 2 欄。 */
interface StoredDisplayCore {
  readonly theme: ThemeId;
  readonly uiScale: number;
}

/**
 * 保存されている形として妥当か。`theme` と `uiScale` のどちらか一方でも壊れていれば
 * 全体を捨てて既定値に戻す(1 つの欄が壊れていても部分的に採用しない。
 * P2 の自動保存の控えの壊れ方への対処(docs/報告記録.md 2026-09-03 19:10)と同じ判断)。
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
 * 理由: この欄は P4b で足したので、それより前に保存された値には**無いのが正常**である。
 * 上の「1 つでも壊れていたら全部捨てる」をこの欄にも当てはめると、前の版から使っている
 * 利用者のテーマと拡大率まで既定へ戻ってしまう(必須の欄を足して旧いデータが読めなく
 * なった P4 タスク6 の差し戻しと同じ前方互換の問題、docs/報告記録.md 2026-09-04 15:20)。
 * 欄はあるが値が壊れている・範囲外のときも、同じ理由でこの欄だけを既定へ戻す(NFR-UX-4)。
 */
function readTrackAngleStep(value: object): number {
  if (!('trackAngleStep' in value) || !isValidTrackAngleStep(value.trackAngleStep)) {
    return DEFAULT_DISPLAY_SETTINGS.trackAngleStep;
  }
  return value.trackAngleStep;
}

/**
 * 保存されている値からつまみの案内の既読を読む(P4b タスク22b)。
 * **この欄も欄ごとに既定へ後退させる**(`readTrackAngleStep` と同じ前方互換の理由。
 * P4b より前に保存された値にはこの欄が無いのが正常で、無いことを理由にテーマまで
 * 既定へ戻してはいけない)。既読でない側(false)へ倒すので、壊れていても案内は出る。
 */
function readTimelineHintSeen(value: object): boolean {
  if (!('timelineHintSeen' in value) || typeof value.timelineHintSeen !== 'boolean') {
    return DEFAULT_DISPLAY_SETTINGS.timelineHintSeen;
  }
  return value.timelineHintSeen;
}

/** 拡大率を 90〜150 の範囲内へ丸める(スライダー等、利用者の入力をその場で丸める用途)。 */
export function clampUiScale(value: number): number {
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, value));
}

// ---------------------------------------------------------------------------
// 設定パネルが使う刻みとキー操作(タスク2。ここも DOM に触れない純関数)
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
    if (Math.abs(step - target) < Math.abs(nearest - target)) {
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
    return {
      theme: parsed.theme,
      uiScale: parsed.uiScale,
      trackAngleStep: readTrackAngleStep(parsed),
      timelineHintSeen: readTimelineHintSeen(parsed),
    };
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
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
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 書き込み枠が塞がっている等。表示は既に切り替わっているので操作は止めない。
  }
}
