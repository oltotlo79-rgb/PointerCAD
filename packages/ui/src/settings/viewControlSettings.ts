import { isRecord } from '../valueGuards.js';
import {
  CAMERA_ACTIONS, DEFAULT_CAMERA_CONTROLS, isCameraBinding, isCameraControlSettings, withCameraControlPreset,
  type CameraAction, type CameraBinding, type CameraControlPreset, type CameraControlSettings,
} from './cameraControlSettings.js';

/*
 * 視点の操作の設定 v2(FR-101)。保存の鍵 'pointercad.settings' の欄 `viewControls` が正本で、v1 の欄
 * `cameraControls` は凍結する(新しい版は v2 が無い時の移行にだけ読み、書き換えない。古い版へ戻した時の控え)。
 * 既定値は v1 の既定を移行して作るので、v1 と v2 の既定は食い違わない。後の版で足す欄は「無ければ既定」で足し、
 * 版の番号は上げない。
 */

/** 視点の操作。v1 と同じ 3 つで、並びは判定の優先順(先に当たった操作を使う)。 */
export const VIEW_ACTIONS = CAMERA_ACTIONS;
export type ViewAction = CameraAction;

type ModifierFlags = Readonly<Record<'alt' | 'shift' | 'ctrl' | 'meta', boolean>>;
const MODIFIERS = ['alt', 'shift', 'ctrl', 'meta'] as const;
const DRAG_BUTTONS: readonly unknown[] = ['left', 'middle', 'right'];

/**
 * 視点を連続して動かす入力。修飾キーは押している組合せと完全に一致した時だけ当たる。
 * ホイールはタッチパッドの 2 本指スクロール(Ctrl 付きはつまむ)を含み、縦と横の量を両方使う。
 */
export type ViewTrigger =
  | (ModifierFlags & { readonly kind: 'drag'; readonly button: 'left' | 'middle' | 'right' })
  | (ModifierFlags & { readonly kind: 'wheel' });

/** 速さ(0.1〜10 倍)と向き。拡大縮小の 4 つは v1 の欄をそのまま移したもの。 */
export interface ViewControlOptions {
  /** 回転の速さ。ビューキューブのドラッグにも効く。 */
  readonly orbitSensitivity: number;
  /** 平行移動の速さ。 */
  readonly panSensitivity: number;
  /** ホイールで拡大縮小する速さ(v1 の wheelSensitivity)。 */
  readonly wheelSensitivity: number;
  /** ドラッグで拡大縮小する速さ(v1 の dragSensitivity)。 */
  readonly zoomDragSensitivity: number;
  /** ホイールの拡大縮小の向きを入れ替える(v1 の invertWheel)。 */
  readonly invertWheel: boolean;
  /** ドラッグの拡大縮小の向きを入れ替える(v1 の invertDrag)。 */
  readonly invertZoomDrag: boolean;
  /** 回転の左右を入れ替える。 */
  readonly invertOrbitX: boolean;
  /** 回転の上下を入れ替える。 */
  readonly invertOrbitY: boolean;
}

export interface ViewControlSettings {
  readonly version: 2;
  /** 操作ごとの入力。ドラッグとホイールを合わせて 1〜4 個。 */
  readonly bindings: Readonly<Record<ViewAction, readonly ViewTrigger[]>>;
  readonly options: ViewControlOptions;
}

/** 適用を断る理由。読む時は、問題のある項目だけを捨てるか既定へ戻す(readStoredViewControls)。 */
export type ViewSettingsProblem =
  /** 種類・ボタン・修飾キーの形が違う。 */
  | { readonly code: 'shape'; readonly at: string }
  /** 形は分かるが、この操作(この版)には使えない入力。後の版で足すキー・タッチの入力。 */
  | { readonly code: 'not-allowed'; readonly action: ViewAction; readonly at: string }
  /** 左ボタンは選択と作図に使うので、Alt を含む形だけ割り当てられる。 */
  | { readonly code: 'left-needs-alt'; readonly action: ViewAction }
  /** 同じ入力が 2 つの割当にある。 */
  | { readonly code: 'duplicate'; readonly first: ViewAction; readonly second: ViewAction; readonly trigger: ViewTrigger }
  /** ドラッグかホイールの割当が 1 つも無い。 */
  | { readonly code: 'mouse-required'; readonly action: ViewAction }
  /** ドラッグとホイールの割当が 4 つを超える。 */
  | { readonly code: 'too-many'; readonly action: ViewAction }
  /** 速さが 0.1〜10 の有限の数でない。 */
  | { readonly code: 'range'; readonly field: string };

const MAX_TRIGGERS_PER_ACTION = 4;
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;
const SPEED_OPTIONS = ['orbitSensitivity', 'panSensitivity', 'wheelSensitivity', 'zoomDragSensitivity'] as const;
const INVERT_OPTIONS = ['invertWheel', 'invertZoomDrag', 'invertOrbitX', 'invertOrbitY'] as const;
/** 後の版(第 2 段)で足す入力の種類。この版では使えないので、読む時はその項目だけ捨てて知らせる。 */
const LATER_TRIGGER_KINDS: readonly unknown[] = ['keys', 'touch'];
/** v1 に無かった欄の既定。今の動き(感度 1・反転なし)と同じ。 */
const NEW_OPTION_DEFAULTS = { orbitSensitivity: 1, panSensitivity: 1, invertOrbitX: false, invertOrbitY: false } as const;

function triggerFromV1(binding: CameraBinding): ViewTrigger {
  const { alt, shift, ctrl, meta } = binding;
  return binding.input === 'wheel' ? { kind: 'wheel', alt, shift, ctrl, meta }
    : { kind: 'drag', button: binding.input, alt, shift, ctrl, meta };
}

/** 読める v1 を v2 へ写す(並びを保つ)。v1 に無かった欄は既定。 */
function migrateCameraControlsV1(v1: CameraControlSettings): ViewControlSettings {
  return {
    version: 2,
    bindings: { orbit: v1.orbit.map(triggerFromV1), pan: v1.pan.map(triggerFromV1), zoom: v1.zoom.map(triggerFromV1) },
    options: {
      orbitSensitivity: NEW_OPTION_DEFAULTS.orbitSensitivity, panSensitivity: NEW_OPTION_DEFAULTS.panSensitivity,
      wheelSensitivity: v1.wheelSensitivity, zoomDragSensitivity: v1.dragSensitivity,
      invertWheel: v1.invertWheel, invertZoomDrag: v1.invertDrag,
      invertOrbitX: NEW_OPTION_DEFAULTS.invertOrbitX, invertOrbitY: NEW_OPTION_DEFAULTS.invertOrbitY,
    },
  };
}

/** 既定は v1 の既定を移行したもの(1 か所。v1 と v2 の既定が構造上食い違わない)。今の版と同じ操作になる。 */
export const DEFAULT_VIEW_CONTROLS: ViewControlSettings = migrateCameraControlsV1(DEFAULT_CAMERA_CONTROLS);

/** 他の CAD に近い雛形。v1 の雛形の表を移行して作り、速さと反転はそのまま残す。 */
export function withViewControlPreset(settings: ViewControlSettings, preset: CameraControlPreset): ViewControlSettings {
  return { ...settings, bindings: migrateCameraControlsV1(withCameraControlPreset(DEFAULT_CAMERA_CONTROLS, preset)).bindings };
}

function isViewTrigger(value: unknown): value is ViewTrigger {
  if (!isRecord(value) || !MODIFIERS.every(modifier => typeof value[modifier] === 'boolean')) return false;
  return value.kind === 'wheel' || (value.kind === 'drag' && DRAG_BUTTONS.includes(value.button));
}

function isLaterTrigger(value: unknown): boolean {
  return isRecord(value) && LATER_TRIGGER_KINDS.includes(value.kind);
}

function isSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_SPEED && value <= MAX_SPEED;
}

function needsAlt(trigger: ViewTrigger): boolean {
  return trigger.kind === 'drag' && trigger.button === 'left' && !trigger.alt;
}

function triggerKey(trigger: ViewTrigger): string {
  return [trigger.kind, trigger.kind === 'drag' ? trigger.button : '', trigger.alt, trigger.shift, trigger.ctrl, trigger.meta].join(':');
}

function actionProblems(action: ViewAction, list: unknown, owners: Map<string, ViewAction>): ViewSettingsProblem[] {
  if (!Array.isArray(list)) return [{ code: 'shape', at: `bindings.${action}` }];
  const items: readonly unknown[] = list;
  const problems: ViewSettingsProblem[] = [];
  const mouse = items.filter(isViewTrigger).length;
  if (mouse === 0) problems.push({ code: 'mouse-required', action });
  if (mouse > MAX_TRIGGERS_PER_ACTION) problems.push({ code: 'too-many', action });
  for (const [index, item] of items.entries()) {
    const at = `bindings.${action}.${index}`;
    if (!isViewTrigger(item)) {
      problems.push(isLaterTrigger(item) ? { code: 'not-allowed', action, at } : { code: 'shape', at });
      continue;
    }
    if (needsAlt(item)) { problems.push({ code: 'left-needs-alt', action }); continue; }
    const key = triggerKey(item), first = owners.get(key);
    if (first === undefined) owners.set(key, action);
    else problems.push({ code: 'duplicate', first, second: action, trigger: item });
  }
  return problems;
}

/** 適用の時の検査。1 件でもあれば適用しない(今の cameraSettingsError と同じ厳しさ)。 */
export function viewControlProblems(value: unknown): readonly ViewSettingsProblem[] {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.bindings) || !isRecord(value.options)) {
    return [{ code: 'shape', at: 'viewControls' }];
  }
  const owners = new Map<string, ViewAction>(), bindings = value.bindings, options = value.options;
  const problems = VIEW_ACTIONS.flatMap(action => actionProblems(action, bindings[action], owners));
  for (const field of SPEED_OPTIONS) if (!isSpeed(options[field])) problems.push({ code: 'range', field });
  for (const field of INVERT_OPTIONS) if (typeof options[field] !== 'boolean') problems.push({ code: 'shape', at: `options.${field}` });
  return problems;
}

export function isViewControlSettings(value: unknown): value is ViewControlSettings {
  return viewControlProblems(value).length === 0;
}

/** 割当・速さ・向きが同じか(並びも比べる)。 */
export function sameViewControls(a: ViewControlSettings, b: ViewControlSettings): boolean {
  return VIEW_ACTIONS.every(action => a.bindings[action].length === b.bindings[action].length
    && a.bindings[action].every((trigger, index) => {
      const other = b.bindings[action][index];
      return other !== undefined && triggerKey(trigger) === triggerKey(other);
    }))
    && [...SPEED_OPTIONS, ...INVERT_OPTIONS].every(field => a.options[field] === b.options[field]);
}

/** 読む時の結果。dropped は読めずに捨てた・既定へ戻した項目の数(0 なら知らせない)。 */
interface StoredViewControls {
  readonly settings: ViewControlSettings;
  readonly dropped: number;
}

function copyTrigger(trigger: ViewTrigger): ViewTrigger {
  const { alt, shift, ctrl, meta } = trigger;
  return trigger.kind === 'wheel' ? { kind: 'wheel', alt, shift, ctrl, meta } : { kind: 'drag', button: trigger.button, alt, shift, ctrl, meta };
}

function salvageOptions(raw: unknown): { readonly options: ViewControlOptions; readonly dropped: number } {
  const defaults = DEFAULT_VIEW_CONTROLS.options;
  if (!isRecord(raw)) return { options: defaults, dropped: 1 };
  let dropped = 0;
  const speed = (field: typeof SPEED_OPTIONS[number]): number => {
    const value = raw[field];
    if (isSpeed(value)) return value;
    dropped++;
    return defaults[field];
  };
  const flag = (field: typeof INVERT_OPTIONS[number]): boolean => {
    const value = raw[field];
    if (typeof value === 'boolean') return value;
    dropped++;
    return defaults[field];
  };
  const options: ViewControlOptions = {
    orbitSensitivity: speed('orbitSensitivity'), panSensitivity: speed('panSensitivity'),
    wheelSensitivity: speed('wheelSensitivity'), zoomDragSensitivity: speed('zoomDragSensitivity'),
    invertWheel: flag('invertWheel'), invertZoomDrag: flag('invertZoomDrag'),
    invertOrbitX: flag('invertOrbitX'), invertOrbitY: flag('invertOrbitY'),
  };
  return { options, dropped };
}

/**
 * v2 の形の値から、読める項目だけを残す(R4)。知らない種類・形の壊れた入力・Alt の無い左・重複(後の方)・
 * 5 つ目からの入力は捨てる。割当が空になった操作は、ほかの操作が使っていない既定の入力で埋める。
 */
function salvageV2(raw: Record<string, unknown>): StoredViewControls {
  const lists = isRecord(raw.bindings) ? raw.bindings : null;
  let dropped = lists === null ? 1 : 0;
  const seen = new Set<string>();
  const kept: Record<ViewAction, ViewTrigger[]> = { orbit: [], pan: [], zoom: [] };
  for (const action of VIEW_ACTIONS) {
    const list: unknown = lists?.[action];
    if (!Array.isArray(list)) { dropped += lists === null ? 0 : 1; continue; }
    const items: readonly unknown[] = list;
    if (items.length === 0) dropped++;
    for (const item of items) {
      if (!isViewTrigger(item) || needsAlt(item) || seen.has(triggerKey(item)) || kept[action].length >= MAX_TRIGGERS_PER_ACTION) {
        dropped++;
        continue;
      }
      seen.add(triggerKey(item));
      kept[action].push(copyTrigger(item));
    }
  }
  for (const action of VIEW_ACTIONS) {
    if (kept[action].length > 0) continue;
    for (const trigger of DEFAULT_VIEW_CONTROLS.bindings[action].filter(item => !seen.has(triggerKey(item)))) {
      seen.add(triggerKey(trigger));
      kept[action].push(trigger);
    }
  }
  const options = salvageOptions(raw.options);
  const settings: ViewControlSettings = { version: 2, bindings: kept, options: options.options };
  // 既定の入力まで全部ほかの操作と重なった時(手で書き換えた値でしか起きない)だけ、全体を既定へ戻す。
  return isViewControlSettings(settings) ? { settings, dropped: dropped + options.dropped }
    : { settings: DEFAULT_VIEW_CONTROLS, dropped: dropped + options.dropped + 1 };
}

/** v1 の欄の名前を v2 の名前へ写すだけ。値の検査は salvageV2 が行う(v1 では断ったが v2 で受ける形は残る)。 */
function salvageV1(raw: unknown): StoredViewControls {
  if (isCameraControlSettings(raw)) return { settings: migrateCameraControlsV1(raw), dropped: 0 };
  if (!isRecord(raw) || raw.version !== 1) return { settings: DEFAULT_VIEW_CONTROLS, dropped: 1 };
  const bindings: Record<string, unknown> = {};
  for (const action of CAMERA_ACTIONS) {
    const list: unknown = raw[action];
    if (!Array.isArray(list)) { bindings[action] = list; continue; }
    const items: readonly unknown[] = list;
    bindings[action] = items.map(item => isCameraBinding(item) ? triggerFromV1(item) : item);
  }
  return salvageV2({ version: 2, bindings, options: { ...NEW_OPTION_DEFAULTS, wheelSensitivity: raw.wheelSensitivity,
    zoomDragSensitivity: raw.dragSensitivity, invertWheel: raw.invertWheel, invertZoomDrag: raw.invertDrag } });
}

/**
 * 保存されていた設定(JSON を読んだ物)から視点の操作を読む。
 * R3/R4: 読める v2 があればそれを使う(壊れた項目だけ直す)。v1 は読まない。
 * R1/R2: v2 が無ければ v1 から移す。どちらも無ければ既定(知らせない)。
 * R5: v2 の欄があるのに読めない(物でない・未来の版)時は、v1 から移したうえで知らせる。
 */
export function readStoredViewControls(stored: object): StoredViewControls {
  const view: unknown = 'viewControls' in stored ? stored.viewControls : undefined;
  if (isRecord(view) && view.version === 2) return salvageV2(view);
  const fromV1 = 'cameraControls' in stored ? salvageV1(stored.cameraControls) : { settings: DEFAULT_VIEW_CONTROLS, dropped: 0 };
  return 'viewControls' in stored ? { settings: fromV1.settings, dropped: fromV1.dropped + 1 } : fromV1;
}

/**
 * 視点の操作を読む入口。3D・図面・ビューキューブ・下絵・設定の画面は、ここを通してだけ読む。
 * 設定がまだ無い・読めない時も既定で動く(操作を止めない)。
 */
export function currentViewControls(settings: { readonly viewControls?: ViewControlSettings } | undefined): ViewControlSettings {
  const value = settings?.viewControls;
  return value !== undefined && isViewControlSettings(value) ? value : DEFAULT_VIEW_CONTROLS;
}
