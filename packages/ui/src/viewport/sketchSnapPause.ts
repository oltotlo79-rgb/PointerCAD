import { currentSnapPauseModifier, snapPauseHeld, type ModifierKeys } from '../settings/snapPauseSetting.js';
import { isCoordinateStep, type NumericInputToolId } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';

const RELEASED: ModifierKeys = { shiftKey: false, ctrlKey: false, metaKey: false };

/**
 * 1 つの canvas の「吸着を一時止める修飾キー」の押下の控え(設計 B-09 3-2)。ポインタの出来事と、焦点が数値の欄に
 * あっても届く window のキーの出来事のたびに更新する。止めるのは**点を置く時だけ**(作図の道具と、座標を聞いている段)。
 * 選択の道具・対象を選ぶ道具の Shift・Ctrl(選択に足す・外す)と、Shift の推定の停止(FR-333)は今のまま。
 * 設定が既定の 'none' なら常に止めない。
 */
export function createSketchSnapPause(isDrawingTool: (tool: NumericInputToolId) => boolean) {
  let held = RELEASED;
  /** いま吸着と推定を止めるか。呼ばれた時点のストア(道具・開いている欄・設定)で決める。 */
  function active(): boolean {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    const placesPoint = isDrawingTool(state.activeTool) || (opened !== null && isCoordinateStep(opened.step));
    return placesPoint && snapPauseHeld(currentSnapPauseModifier(state.displaySettings), held);
  }
  return {
    active,
    /** 出来事の修飾キーを控える。止まり始めた時だけ true(呼ぶ側が吸着と推定の印をすぐ消す合図)。 */
    update(keys: ModifierKeys): boolean {
      const before = active();
      held = { shiftKey: keys.shiftKey, ctrlKey: keys.ctrlKey, metaKey: keys.metaKey };
      return !before && active();
    },
    /** 窓が焦点を失った時(キーを離した出来事が届かない)。押していない扱いへ戻す。 */
    release(): void {
      held = RELEASED;
    },
  };
}

export type SketchSnapPause = ReturnType<typeof createSketchSnapPause>;
