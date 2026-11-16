import type { CommandId } from './commandDefinitions.js';
import { createPointerCommandGesture, type MouseButtonCommands, type PointerCommandInput } from './pointerCommandGesture.js';

/*
 * マウスの戻る・進むボタンと中ボタンのダブルクリックに割り当てた命令を行う(設計 2-4・B-08e)。ビューポートの canvas と
 * 図面の面に結ぶ。割り当てた入力だけを受け、受けた戻る・進むはブラウザーのページの移動(Chromium は離した時に動く)を
 * mouseup・auxclick でも止める。割り当てていない入力は今までどおり(何もしない・ページは動く)。
 */

const SIDE_BUTTONS: Readonly<Record<number, PointerCommandInput>> = { 3: 'back', 4: 'forward' };

export function attachPointerCommands(target: EventTarget, read: () => MouseButtonCommands, run: (id: CommandId) => void): () => void {
  const gesture = createPointerCommandGesture();
  /** 割り当てた戻る・進むなら、ブラウザーの既定の動き(ページの移動)を止める。 */
  const holdSide = (event: MouseEvent): void => {
    const input = SIDE_BUTTONS[event.button];
    if (input !== undefined && read()[input] !== undefined) event.preventDefault();
  };
  const down = (input: Event): void => {
    const event = input as PointerEvent;
    gesture.down(event);
    holdSide(event);
  };
  const up = (input: Event): void => {
    const event = input as PointerEvent;
    holdSide(event);
    const kind = gesture.up(event), id = kind === null ? undefined : read()[kind];
    if (id === undefined) return;
    event.preventDefault();
    run(id);
  };
  const hold = (input: Event): void => { holdSide(input as MouseEvent); };
  // 捕捉の段で受ける。視点の操作と組立の入力は中ボタンの押下を stopImmediatePropagation で自分の物にするので、
  // 同じ canvas の後ろの受け手では押下が見えない(取り合わず、見るだけで既定の動きは割り当てた戻る・進むだけ止める)。
  const listeners = [['pointerdown', down], ['pointerup', up], ['mouseup', hold], ['auxclick', hold]] as const;
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { capture: true });
  return () => { for (const [type, listener] of listeners) target.removeEventListener(type, listener, true); };
}
