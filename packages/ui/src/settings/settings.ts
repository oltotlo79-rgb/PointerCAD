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

/** 表示テーマ 5 種(FR-908)。既定は `dark`(現状の配色をそのまま複製)。 */
export type ThemeId = 'dark' | 'light' | 'darkModern' | 'lightModern' | 'modern';

const THEME_IDS: readonly ThemeId[] = ['dark', 'light', 'darkModern', 'lightModern', 'modern'];

export interface DisplaySettings {
  readonly theme: ThemeId;
  /** 表示の拡大率(%)。90〜150(FR-909)。 */
  readonly uiScale: number;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { theme: 'dark', uiScale: 100 };
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

/**
 * 保存されている形として妥当か。`theme` と `uiScale` のどちらか一方でも壊れていれば
 * 全体を捨てて既定値に戻す(1 つの欄が壊れていても部分的に採用しない。
 * P2 の自動保存の控えの壊れ方への対処(docs/報告記録.md 2026-09-03 19:10)と同じ判断)。
 */
function isDisplaySettings(value: unknown): value is DisplaySettings {
  return (
    typeof value === 'object' &&
    value !== null &&
    'theme' in value &&
    'uiScale' in value &&
    isThemeId(value.theme) &&
    isValidUiScale(value.uiScale)
  );
}

/** 拡大率を 90〜150 の範囲内へ丸める(スライダー等、利用者の入力をその場で丸める用途)。 */
export function clampUiScale(value: number): number {
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, value));
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
    return isDisplaySettings(parsed) ? parsed : DEFAULT_DISPLAY_SETTINGS;
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
