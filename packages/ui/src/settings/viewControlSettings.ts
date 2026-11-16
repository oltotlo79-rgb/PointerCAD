import { isRecord } from '../valueGuards.js';
import {
  CAMERA_ACTIONS, CAMERA_CONTROL_PRESETS, DEFAULT_CAMERA_CONTROLS, isCameraBinding, isCameraControlSettings, withCameraControlPreset,
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
 * キーで視点を動かす入力の組(第 2 段、B-08)。押している間(キーの繰り返しの間)動かす。
 * 矢印とテンキー 8・4・6・2 は回転と平行移動、＋・−は拡大縮小に使う。
 */
export const VIEW_KEY_GROUPS = ['arrows', 'numpad', 'plusMinus'] as const;
export type ViewKeyGroup = (typeof VIEW_KEY_GROUPS)[number];
/** 組ごとに使える操作。 */
export const VIEW_KEY_GROUP_ACTIONS: Readonly<Record<ViewKeyGroup, readonly ViewAction[]>> = {
  arrows: ['orbit', 'pan'], numpad: ['orbit', 'pan'], plusMinus: ['zoom'],
};

/**
 * タッチ画面の指の操作(第 2 段)。1 本指ドラッグ(B-08h。割り当てた時だけ。軽く触れて離すのは今どおり作図・選択)、
 * 2 本指ドラッグ(中点の移動。B-08g)と、つまむ(指の間の距離。B-08g)。
 */
export const VIEW_TOUCH_GESTURES = ['oneFinger', 'twoFinger', 'pinch'] as const;
export type ViewTouchGesture = (typeof VIEW_TOUCH_GESTURES)[number];
/** 指の操作ごとに使える操作。ドラッグは回転か平行移動、つまむは拡大縮小だけ。 */
export const VIEW_TOUCH_GESTURE_ACTIONS: Readonly<Record<ViewTouchGesture, readonly ViewAction[]>> = {
  oneFinger: ['orbit', 'pan'], twoFinger: ['pan', 'orbit'], pinch: ['zoom'],
};

/**
 * 視点を連続して動かす入力。修飾キーは押している組合せと完全に一致した時だけ当たる。
 * ホイールはタッチパッドの 2 本指スクロール(Ctrl 付きはつまむ)を含み、縦と横の量を両方使う。
 * タッチは修飾キーを使わない(形を揃えるために欄は持ち、全部 false の時だけ読む。設計 §5 の形からの差)。
 */
export type ViewTrigger =
  | (ModifierFlags & { readonly kind: 'drag'; readonly button: 'left' | 'middle' | 'right' })
  | (ModifierFlags & { readonly kind: 'wheel' })
  | (ModifierFlags & { readonly kind: 'keys'; readonly keys: ViewKeyGroup })
  | (ModifierFlags & { readonly kind: 'touch'; readonly gesture: ViewTouchGesture });

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
  /** キー 1 回(繰り返しの 1 回)で回す角度(1〜90 度)。第 2 段で足した欄で、無ければ 15。 */
  readonly keyStepDegrees?: number;
  /** 回転の中心(B-08d。設計 §5 の名前)。無ければ 'target'(今までどおり画面の中心=注視点の周り)。 */
  readonly orbitCenter?: OrbitCenter;
  /** 拡大縮小の中心(B-08d。3D だけ。図面は今どおりカーソル)。無ければ 'target'(今までどおり画面の中心へ)。 */
  readonly zoomCenter?: ZoomCenter;
}

/** 回転の中心: 画面の中心(注視点)・押した所の形の上の点(当たらなければ画面の中心)・選んだ物の中心(無ければ画面の中心)。 */
export const ORBIT_CENTERS = ['target', 'pointer', 'selection'] as const;
export type OrbitCenter = typeof ORBIT_CENTERS[number];
/** 拡大縮小の中心: 画面の中心・ポインターの所(形の上の点、当たらなければ注視点の深さの点)。 */
export const ZOOM_CENTERS = ['target', 'pointer'] as const;
export type ZoomCenter = typeof ZOOM_CENTERS[number];

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
  /** ドラッグとホイールの割当が 4 つを超える、またはキー・タッチの割当がそれぞれ 2 つを超える。 */
  | { readonly code: 'too-many'; readonly action: ViewAction }
  /** 速さが 0.1〜10 の有限の数でない、またはキーの角度が 1〜90 でない。 */
  | { readonly code: 'range'; readonly field: string };

const MAX_TRIGGERS_PER_ACTION = 4;
const MAX_KEY_TRIGGERS_PER_ACTION = 2;
const MAX_TOUCH_TRIGGERS_PER_ACTION = 2;
const DEFAULT_KEY_STEP_DEGREES = 15;
const MIN_KEY_STEP_DEGREES = 1;
const MAX_KEY_STEP_DEGREES = 90;
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;
const SPEED_OPTIONS = ['orbitSensitivity', 'panSensitivity', 'wheelSensitivity', 'zoomDragSensitivity'] as const;
const INVERT_OPTIONS = ['invertWheel', 'invertZoomDrag', 'invertOrbitX', 'invertOrbitY'] as const;
/**
 * 後の版で足しうる入力の種類。形が読めない時でも、この種類なら not-allowed として捨てて知らせる(タッチの知らない指の操作や、
 * 修飾キーの付いたタッチ)。
 */
const LATER_TRIGGER_KINDS: readonly unknown[] = ['touch'];
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

/** 雛形。v1 の 4 つ(他の CAD に近い割当)に、v2 だけの「タッチパッド向け」を足す(設計 1-4・§6.2)。 */
export const VIEW_CONTROL_PRESETS = [...CAMERA_CONTROL_PRESETS, 'touchpad', 'keyboard', 'touchscreen'] as const;
export type ViewControlPreset = CameraControlPreset | 'touchpad' | 'keyboard' | 'touchscreen';

const NO_MODIFIERS = { alt: false, shift: false, ctrl: false, meta: false } as const;
/** タッチパッド向け: 2 本指スクロール(修飾なしのホイール)で平行移動、つまむ(Ctrl＋ホイール)で拡大、Shift＋2 本指で回転。 */
const TOUCHPAD_BINDINGS: ViewControlSettings['bindings'] = {
  orbit: [{ kind: 'drag', button: 'middle', ...NO_MODIFIERS }, { kind: 'drag', button: 'left', ...NO_MODIFIERS, alt: true },
    { kind: 'wheel', ...NO_MODIFIERS, shift: true }],
  pan: [{ kind: 'wheel', ...NO_MODIFIERS }, { kind: 'drag', button: 'right', ...NO_MODIFIERS },
    { kind: 'drag', button: 'middle', ...NO_MODIFIERS, shift: true }],
  zoom: [{ kind: 'wheel', ...NO_MODIFIERS, ctrl: true }],
};

/**
 * キーボードで視点(B-08): 既定のマウスの割当に、矢印＝回転・Shift＋矢印＝平行移動・＋−＝拡大縮小を足す
 * (マウスの割当は既定のまま)。ほかの CAD の割当との比べは未確認で、利用者が視点のタブで変えられる。
 */
const KEYBOARD_BINDINGS: ViewControlSettings['bindings'] = {
  orbit: [...DEFAULT_VIEW_CONTROLS.bindings.orbit, { kind: 'keys', keys: 'arrows', ...NO_MODIFIERS }],
  pan: [...DEFAULT_VIEW_CONTROLS.bindings.pan, { kind: 'keys', keys: 'arrows', ...NO_MODIFIERS, shift: true }],
  zoom: [...DEFAULT_VIEW_CONTROLS.bindings.zoom, { kind: 'keys', keys: 'plusMinus', ...NO_MODIFIERS }],
};

/**
 * タッチ画面向け(B-08h。設計 §0.3-3「既定はなし・雛形で入れる」): 既定のマウスの割当に、1 本指ドラッグ＝回転・
 * 2 本指ドラッグ＝平行移動・つまむ＝拡大縮小を足す(マウスの割当は既定のまま)。1 本指で点や部品を引っぱる操作は
 * できなくなる(窓の注意で知らせる)。
 */
const TOUCHSCREEN_BINDINGS: ViewControlSettings['bindings'] = {
  orbit: [...DEFAULT_VIEW_CONTROLS.bindings.orbit, { kind: 'touch', gesture: 'oneFinger', ...NO_MODIFIERS }],
  pan: [...DEFAULT_VIEW_CONTROLS.bindings.pan, { kind: 'touch', gesture: 'twoFinger', ...NO_MODIFIERS }],
  zoom: [...DEFAULT_VIEW_CONTROLS.bindings.zoom, { kind: 'touch', gesture: 'pinch', ...NO_MODIFIERS }],
};

/** この操作のタッチの指の割当が上限(2 つ)に達しているか(取り込みの枠で足せない理由を出す。B-08h)。 */
export function touchTriggersFull(settings: ViewControlSettings, action: ViewAction): boolean {
  return settings.bindings[action].filter(trigger => trigger.kind === 'touch').length >= MAX_TOUCH_TRIGGERS_PER_ACTION;
}

/** 1 本指のドラッグを視点に割り当てているか(窓の注意を出す。B-08h)。 */
export function hasOneFingerTouch(settings: ViewControlSettings): boolean {
  return VIEW_ACTIONS.some(action => settings.bindings[action].some(trigger => trigger.kind === 'touch' && trigger.gesture === 'oneFinger'));
}

/** 雛形の割当を入れる。v1 の雛形は v1 の表を移行して作り、速さと反転はそのまま残す。 */
export function withViewControlPreset(settings: ViewControlSettings, preset: ViewControlPreset): ViewControlSettings {
  if (preset === 'touchpad') return { ...settings, bindings: TOUCHPAD_BINDINGS };
  if (preset === 'keyboard') return { ...settings, bindings: KEYBOARD_BINDINGS };
  if (preset === 'touchscreen') return { ...settings, bindings: TOUCHSCREEN_BINDINGS };
  return { ...settings, bindings: migrateCameraControlsV1(withCameraControlPreset(DEFAULT_CAMERA_CONTROLS, preset)).bindings };
}

function isViewTrigger(value: unknown): value is ViewTrigger {
  if (!isRecord(value) || !MODIFIERS.every(modifier => typeof value[modifier] === 'boolean')) return false;
  return value.kind === 'wheel' || (value.kind === 'drag' && DRAG_BUTTONS.includes(value.button))
    || (value.kind === 'keys' && (VIEW_KEY_GROUPS as readonly unknown[]).includes(value.keys))
    || (value.kind === 'touch' && (VIEW_TOUCH_GESTURES as readonly unknown[]).includes(value.gesture)
      && MODIFIERS.every(modifier => value[modifier] === false));
}

/** 入力の種類の組(数の上限を分けて数える): マウス(ドラッグとホイール)・キー・タッチ。 */
const TRIGGER_FAMILIES = ['mouse', 'keys', 'touch'] as const;
type TriggerFamily = (typeof TRIGGER_FAMILIES)[number];
function triggerFamily(trigger: ViewTrigger): TriggerFamily {
  return trigger.kind === 'keys' ? 'keys' : trigger.kind === 'touch' ? 'touch' : 'mouse';
}
const FAMILY_LIMITS: Readonly<Record<TriggerFamily, number>> = {
  mouse: MAX_TRIGGERS_PER_ACTION, keys: MAX_KEY_TRIGGERS_PER_ACTION, touch: MAX_TOUCH_TRIGGERS_PER_ACTION,
};

/** マウス(ドラッグかホイール)の入力か。キーとタッチの入力は数えない。 */
function isPointerTrigger(trigger: ViewTrigger): boolean {
  return triggerFamily(trigger) === 'mouse';
}

/**
 * キーの組・タッチの指の操作がこの操作に使えるか(矢印・テンキーは回転と平行移動、＋−は拡大縮小、
 * 2 本指は平行移動と回転、つまむは拡大縮小)。マウスの入力はどの操作にも使える。
 */
function triggerFitsAction(trigger: ViewTrigger, action: ViewAction): boolean {
  if (trigger.kind === 'keys') return VIEW_KEY_GROUP_ACTIONS[trigger.keys].includes(action);
  if (trigger.kind === 'touch') return VIEW_TOUCH_GESTURE_ACTIONS[trigger.gesture].includes(action);
  return true;
}

function isKeyStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_KEY_STEP_DEGREES && value <= MAX_KEY_STEP_DEGREES;
}

/** キー 1 回で回す角度(度)。欄が無ければ 15。 */
export function viewKeyStepDegrees(options: ViewControlOptions): number {
  return options.keyStepDegrees ?? DEFAULT_KEY_STEP_DEGREES;
}

function isOrbitCenter(value: unknown): value is OrbitCenter {
  return ORBIT_CENTERS.some(center => center === value);
}
function isZoomCenter(value: unknown): value is ZoomCenter {
  return ZOOM_CENTERS.some(center => center === value);
}
/** 回転の中心(欄が無ければ画面の中心)。 */
export function viewOrbitCenter(options: ViewControlOptions): OrbitCenter {
  return options.orbitCenter ?? 'target';
}
/** 拡大縮小の中心(欄が無ければ画面の中心)。 */
export function viewZoomCenter(options: ViewControlOptions): ZoomCenter {
  return options.zoomCenter ?? 'target';
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

/** 入力の同じさを比べる鍵(種類・ボタンかキーの組・修飾キー)。重なりの判定はこれ 1 つで行う。 */
export function viewTriggerKey(trigger: ViewTrigger): string {
  const detail = trigger.kind === 'drag' ? trigger.button : trigger.kind === 'keys' ? trigger.keys
    : trigger.kind === 'touch' ? trigger.gesture : '';
  return [trigger.kind, detail, trigger.alt, trigger.shift, trigger.ctrl, trigger.meta].join(':');
}
const triggerKey = viewTriggerKey;

function actionProblems(action: ViewAction, list: unknown, owners: Map<string, ViewAction>): ViewSettingsProblem[] {
  if (!Array.isArray(list)) return [{ code: 'shape', at: `bindings.${action}` }];
  const items: readonly unknown[] = list;
  const problems: ViewSettingsProblem[] = [];
  const triggers = items.filter(isViewTrigger), mouse = triggers.filter(isPointerTrigger).length;
  if (mouse === 0) problems.push({ code: 'mouse-required', action });
  const over = TRIGGER_FAMILIES.some(family => triggers.filter(trigger => triggerFamily(trigger) === family).length > FAMILY_LIMITS[family]);
  if (over) problems.push({ code: 'too-many', action });
  for (const [index, item] of items.entries()) {
    const at = `bindings.${action}.${index}`;
    if (!isViewTrigger(item)) {
      problems.push(isLaterTrigger(item) ? { code: 'not-allowed', action, at } : { code: 'shape', at });
      continue;
    }
    if (!triggerFitsAction(item, action)) { problems.push({ code: 'not-allowed', action, at }); continue; }
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
  if (options.keyStepDegrees !== undefined && !isKeyStep(options.keyStepDegrees)) problems.push({ code: 'range', field: 'keyStepDegrees' });
  if (options.orbitCenter !== undefined && !isOrbitCenter(options.orbitCenter)) problems.push({ code: 'shape', at: 'options.orbitCenter' });
  if (options.zoomCenter !== undefined && !isZoomCenter(options.zoomCenter)) problems.push({ code: 'shape', at: 'options.zoomCenter' });
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
    && [...SPEED_OPTIONS, ...INVERT_OPTIONS].every(field => a.options[field] === b.options[field])
    && viewKeyStepDegrees(a.options) === viewKeyStepDegrees(b.options)
    && viewOrbitCenter(a.options) === viewOrbitCenter(b.options) && viewZoomCenter(a.options) === viewZoomCenter(b.options);
}

/** 読む時の結果。dropped は読めずに捨てた・既定へ戻した項目の数(0 なら知らせない)。 */
interface StoredViewControls {
  readonly settings: ViewControlSettings;
  readonly dropped: number;
}

function copyTrigger(trigger: ViewTrigger): ViewTrigger {
  const { alt, shift, ctrl, meta } = trigger;
  if (trigger.kind === 'keys') return { kind: 'keys', keys: trigger.keys, alt, shift, ctrl, meta };
  if (trigger.kind === 'touch') return { kind: 'touch', gesture: trigger.gesture, alt, shift, ctrl, meta };
  return trigger.kind === 'wheel' ? { kind: 'wheel', alt, shift, ctrl, meta } : { kind: 'drag', button: trigger.button, alt, shift, ctrl, meta };
}

/** この操作にもう置けない入力か(マウスは 4 つ、キーとタッチはそれぞれ 2 つまで)。 */
function actionFull(kept: readonly ViewTrigger[], trigger: ViewTrigger): boolean {
  const family = triggerFamily(trigger);
  return kept.filter(item => triggerFamily(item) === family).length >= FAMILY_LIMITS[family];
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
  // 第 2 段の欄(キーの角度・回転と拡大縮小の中心。無ければ既定)。読めない値は欄ごと外して知らせる。
  const keyStep = raw.keyStepDegrees === undefined ? {} : isKeyStep(raw.keyStepDegrees) ? { keyStepDegrees: raw.keyStepDegrees } : null;
  const orbitCenter = raw.orbitCenter === undefined ? {} : isOrbitCenter(raw.orbitCenter) ? { orbitCenter: raw.orbitCenter } : null;
  const zoomCenter = raw.zoomCenter === undefined ? {} : isZoomCenter(raw.zoomCenter) ? { zoomCenter: raw.zoomCenter } : null;
  return { options: { ...options, ...keyStep, ...orbitCenter, ...zoomCenter },
    dropped: dropped + [keyStep, orbitCenter, zoomCenter].filter(field => field === null).length };
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
      if (!isViewTrigger(item) || needsAlt(item) || !triggerFitsAction(item, action) || seen.has(triggerKey(item))
        || actionFull(kept[action], item)) {
        dropped++;
        continue;
      }
      seen.add(triggerKey(item));
      kept[action].push(copyTrigger(item));
    }
  }
  for (const action of VIEW_ACTIONS) {
    if (kept[action].some(isPointerTrigger)) continue;
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
