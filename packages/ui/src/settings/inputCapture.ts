import { t, type MessageKey } from '../i18n/t.js';
import { VIEW_KEY_GROUP_ACTIONS, type ViewAction, type ViewKeyGroup, type ViewTrigger } from './viewControlSettings.js';

/*
 * 操作の割り当ての窓の取り込み(設計 1-4・§6.2)。取り込みの枠の中で、マウスのボタンを押す・ホイールを回すと、
 * 視点の操作の入力になる。左ボタンは選択と作図に使うので、Alt を一緒に押した時だけ受ける(viewControlSettings.ts の
 * left-needs-alt と同じ決まり)。キー(矢印・テンキー 8・2・4・6・＋−)は captureViewKey が受ける(B-08)。タッチはまだ受けない。
 */

/** 取り込みの枠が受け取る出来事(PointerEvent と WheelEvent の必要な所だけ)。 */
export interface ViewCaptureEvent {
  readonly type: string;
  readonly button?: number;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export type CapturedViewInput =
  | { readonly status: 'captured'; readonly trigger: ViewTrigger }
  | { readonly status: 'refused'; readonly reason: 'left-needs-alt' }
  | { readonly status: 'ignored' };

const BUTTONS: Readonly<Record<number, 'left' | 'middle' | 'right'>> = { 0: 'left', 1: 'middle', 2: 'right' };

/** 出来事 → 視点の入力。押下(pointerdown)はボタンのドラッグ、ホイール(wheel)はホイール・2 本指スクロール。 */
export function captureViewInput(event: ViewCaptureEvent): CapturedViewInput {
  const modifiers = { alt: event.altKey, shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey };
  if (event.type === 'wheel') return { status: 'captured', trigger: { kind: 'wheel', ...modifiers } };
  if (event.type !== 'pointerdown' || event.button === undefined) return { status: 'ignored' };
  const button = BUTTONS[event.button];
  if (button === undefined) return { status: 'ignored' };
  if (button === 'left' && !event.altKey) return { status: 'refused', reason: 'left-needs-alt' };
  return { status: 'captured', trigger: { kind: 'drag', button, ...modifiers } };
}

/** キーの物理の位置からキーの組(B-08)。組に入らないキーは null。 */
const KEY_GROUP_OF: Readonly<Record<string, ViewKeyGroup>> = {
  ArrowUp: 'arrows', ArrowDown: 'arrows', ArrowLeft: 'arrows', ArrowRight: 'arrows',
  Numpad8: 'numpad', Numpad2: 'numpad', Numpad4: 'numpad', Numpad6: 'numpad',
  NumpadAdd: 'plusMinus', NumpadSubtract: 'plusMinus', Equal: 'plusMinus', Minus: 'plusMinus',
};
export type CapturedViewKey =
  | { readonly status: 'captured'; readonly trigger: ViewTrigger }
  | { readonly status: 'refused'; readonly reason: 'not-for-action' }
  | { readonly status: 'ignored' };

/** 取り込みの枠で押したキー → キーの組の入力。その操作に使えない組(＋−を回転へ、矢印を拡大へ)は断る。 */
export function captureViewKey(event: Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'isComposing'>,
  action: ViewAction): CapturedViewKey {
  const group = event.isComposing ? undefined : KEY_GROUP_OF[event.code];
  if (group === undefined) return { status: 'ignored' };
  if (!VIEW_KEY_GROUP_ACTIONS[group].includes(action)) return { status: 'refused', reason: 'not-for-action' };
  return { status: 'captured', trigger: { kind: 'keys', keys: group, alt: event.altKey, shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey } };
}

const INPUT_KEYS: Readonly<Record<'left' | 'middle' | 'right' | 'wheel' | ViewKeyGroup, MessageKey>> = {
  left: 'settings.camera.chip.left', middle: 'settings.camera.chip.middle', right: 'settings.camera.chip.right',
  wheel: 'settings.camera.chip.wheel',
  arrows: 'settings.camera.keys.arrows', numpad: 'settings.camera.keys.numpad', plusMinus: 'settings.camera.keys.plusMinus',
};
const MODIFIER_KEYS: Readonly<Record<'ctrl' | 'alt' | 'shift' | 'meta', MessageKey>> = {
  ctrl: 'settings.camera.ctrl', alt: 'settings.camera.alt', shift: 'settings.camera.shift', meta: 'settings.camera.meta',
};

/** 札の表記(「Shift＋中ボタン ドラッグ」「Ctrl＋ホイール・2 本指スクロール」)。 */
export function viewTriggerLabel(trigger: ViewTrigger): string {
  const modifiers = (['ctrl', 'alt', 'shift', 'meta'] as const).filter(modifier => trigger[modifier]).map(modifier => t(MODIFIER_KEYS[modifier]));
  const input = trigger.kind === 'wheel' ? 'wheel' : trigger.kind === 'keys' ? trigger.keys : trigger.button;
  return [...modifiers, t(INPUT_KEYS[input])].join(t('settings.camera.chip.join'));
}
