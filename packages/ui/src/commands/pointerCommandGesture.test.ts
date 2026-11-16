import { describe, expect, it } from 'vitest';
import {
  createPointerCommandGesture, EMPTY_MOUSE_BUTTON_COMMANDS, MIDDLE_DOUBLE_GAP_MS, MIDDLE_DOUBLE_SLOP_PX, readMouseButtonCommands,
} from './pointerCommandGesture.js';

/* 設計 2-4・B-08e: 戻る・進むボタンと中ボタンのダブルクリックの見分け、保存の値の読み取り。 */
const at = (button: number, timeStamp: number, clientX = 100, clientY = 100) => ({ button, clientX, clientY, timeStamp });

describe('マウスのボタンの入力の見分け', () => {
  it('戻る(button 3)・進む(button 4)は離した時に 1 回ずつ', () => {
    const gesture = createPointerCommandGesture();
    gesture.down(at(3, 0));
    expect(gesture.up(at(3, 10))).toBe('back');
    gesture.down(at(4, 20));
    expect(gesture.up(at(4, 30))).toBe('forward');
    expect(gesture.up(at(0, 40))).toBeNull();
    expect(gesture.up(at(2, 50))).toBeNull();
  });

  it(`中ボタンは動かさない押下が ${String(MIDDLE_DOUBLE_GAP_MS)} ms の内に 2 回続いた時だけダブルクリック`, () => {
    const gesture = createPointerCommandGesture();
    gesture.down(at(1, 0)); expect(gesture.up(at(1, 50))).toBeNull();
    gesture.down(at(1, 200)); expect(gesture.up(at(1, 250, 100 + MIDDLE_DOUBLE_SLOP_PX, 100))).toBe('middleDouble');
    // 3 回目は新しい 1 回目。間隔が長ければ数え直す。
    gesture.down(at(1, 300)); expect(gesture.up(at(1, 320))).toBeNull();
    gesture.down(at(1, 900)); expect(gesture.up(at(1, 950))).toBeNull();
    // 境目: 前に離した時刻(950)からちょうど間隔の上限で離せば、ダブルクリック。
    gesture.down(at(1, 1000)); expect(gesture.up(at(1, 950 + MIDDLE_DOUBLE_GAP_MS))).toBe('middleDouble');
  });

  it('中ボタンで回したドラッグ(押して離すまでに動いた)は数えず、続くクリックとも組にしない', () => {
    const gesture = createPointerCommandGesture();
    gesture.down(at(1, 0)); expect(gesture.up(at(1, 100, 160, 100))).toBeNull();
    gesture.down(at(1, 150)); expect(gesture.up(at(1, 200))).toBeNull();
    gesture.down(at(1, 250)); expect(gesture.up(at(1, 300, 100, 100 + MIDDLE_DOUBLE_SLOP_PX + 1))).toBeNull();
    gesture.down(at(1, 350)); expect(gesture.up(at(1, 400))).toBeNull();
    // 押下を見ていない離しは数えない。
    expect(gesture.up(at(1, 450))).toBeNull();
  });
});

describe('マウスのボタンの割当の読み取り', () => {
  it('知らない入力・登録の無い命令・文字でない値はその 1 件だけ捨てる', () => {
    expect(readMouseButtonCommands(undefined)).toEqual({ commands: EMPTY_MOUSE_BUTTON_COMMANDS, dropped: 0 });
    expect(readMouseButtonCommands({ back: 'history.undo', forward: 'history.redo', middleDouble: 'toolbar.view.home' }))
      .toEqual({ commands: { back: 'history.undo', forward: 'history.redo', middleDouble: 'toolbar.view.home' }, dropped: 0 });
    expect(readMouseButtonCommands({ back: 'no.such.command', side: 'history.undo', forward: 3, middleDouble: 'toolbar.view.fitAll' }))
      .toEqual({ commands: { middleDouble: 'toolbar.view.fitAll' }, dropped: 3 });
    for (const raw of [null, [], 'back']) expect(readMouseButtonCommands(raw)).toEqual({ commands: EMPTY_MOUSE_BUTTON_COMMANDS, dropped: 1 });
  });
});
