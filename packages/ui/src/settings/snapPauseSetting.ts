/**
 * 吸着を一時止める修飾キー(設計 B-09 3-2)。点を置く道具で、選んだキーを押している間だけ、点の吸着・向きの吸着・
 * 拘束の推定を止める。既定は 'none'(止めない。今までと同じ動き)。'ctrl' は Ctrl と Mac の Cmd の両方。
 * 押下の判定と、保存・設定ファイルの値の読み取りだけを持つ(画面・ストア・出来事の扱いは持たない)。
 */
export const SNAP_PAUSE_MODIFIERS = ['none', 'shift', 'ctrl'] as const;
export type SnapPauseModifier = (typeof SNAP_PAUSE_MODIFIERS)[number];
export const DEFAULT_SNAP_PAUSE_MODIFIER: SnapPauseModifier = 'none';

/** 出来事(ポインタ・キー)の修飾キーの押下。 */
export interface ModifierKeys {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** 保存・設定ファイルの値を読む。知らない値・形の違う値は null(呼ぶ側が既定か今の値を使う)。 */
export function snapPauseModifierOf(raw: unknown): SnapPauseModifier | null {
  return SNAP_PAUSE_MODIFIERS.find(item => item === raw) ?? null;
}

/** 設定から読む入口。無い・読めない時は既定('none')。 */
export function currentSnapPauseModifier(settings: { readonly snapPauseModifier?: SnapPauseModifier } | undefined): SnapPauseModifier {
  return snapPauseModifierOf(settings?.snapPauseModifier) ?? DEFAULT_SNAP_PAUSE_MODIFIER;
}

/** 選んだ修飾キーを今押しているか。'none' は常に false。 */
export function snapPauseHeld(modifier: SnapPauseModifier, keys: ModifierKeys): boolean {
  return modifier === 'shift' ? keys.shiftKey : modifier === 'ctrl' ? keys.ctrlKey || keys.metaKey : false;
}
