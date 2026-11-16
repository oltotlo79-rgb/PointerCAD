/*
 * タッチの指の動きの読み取り(設計 2-2・B-08g)。DOM を持たない純粋な追跡で、3D(attachCameraControls)と
 * 図面(attachDrawingNavigation)の両方が同じ読み方を使う。
 *
 * - 1 本目の指は、今どおり作図・選択へ届く(ここでは動きを返さない。1 本指の視点の操作は B-08h)。
 * - 2 本目の指が触れたら 2 本指の操作の始まり。呼び手は 1 本目の指の作図の押下を取り消す。
 * - 2 本指の間は、中点の移動(平行移動・回転に使う)と、指の間の距離の比(つまむ拡大に使う)を返す。
 * - 3 本目からの指は数えない。2 本のどちらかが離れたら、全部の指が離れるまで何も返さない(残った 1 本で作図を始めない)。
 */

/** 画面に触れている指(PointerEvent の pointerId と画面の座標)。 */
interface TouchContact {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** 2 本指の 1 回の動き。 */
export interface TwoFingerStep {
  /** 2 本の指の中点の移動(画素。右・下が正)。 */
  readonly dx: number;
  readonly dy: number;
  /** 指の間の距離の比(今 ÷ 前)。1 より大きいと広げた(拡大)。 */
  readonly scale: number;
  /** 今の 2 本の指の中点(画面の座標)。つまむ拡大の中心。 */
  readonly centerX: number;
  readonly centerY: number;
}

/** 指が触れた時の答え。second は 2 本指の操作の始まり(呼び手は 1 本目の押下を取り消す)。 */
type TouchDown = 'first' | 'second' | 'ignored';

interface TouchGestureTracker {
  down(contact: TouchContact): TouchDown;
  /** 2 本指の操作の間だけ動きを返す。それ以外は null。 */
  move(contact: TouchContact): TwoFingerStep | null;
  /** 指が離れた(取り消された)。 */
  up(id: number): void;
  /** 2 本指の操作の間か(呼び手は、この間の 1 本目の指の入力を作図へ渡さない)。 */
  active(): boolean;
}

/** 距離の比を求めない、指の間の最小の距離(画素)。指が重なった時に比が跳ねないようにする。 */
const MIN_FINGER_DISTANCE = 1;

type Phase = 'idle' | 'one' | 'two' | 'ended';

export function createTouchGestureTracker(): TouchGestureTracker {
  const contacts = new Map<number, TouchContact>();
  /** 数えている指(最初の 2 本)の id。 */
  const tracked: number[] = [];
  let phase: Phase = 'idle';

  const pair = (): readonly [TouchContact, TouchContact] | null => {
    const [a, b] = tracked.map(id => contacts.get(id));
    return a === undefined || b === undefined ? null : [a, b];
  };
  return {
    down(contact) {
      contacts.set(contact.id, contact);
      if (phase === 'idle') { tracked.push(contact.id); phase = 'one'; return 'first'; }
      if (phase === 'one') { tracked.push(contact.id); phase = 'two'; return 'second'; }
      return 'ignored';
    },
    move(contact) {
      if (!contacts.has(contact.id)) return null;
      const before = pair();
      contacts.set(contact.id, contact);
      const after = pair();
      if (phase !== 'two' || before === null || after === null || !tracked.includes(contact.id)) return null;
      return twoFingerStep(before, after);
    },
    up(id) {
      contacts.delete(id);
      if (tracked.includes(id) && phase === 'two') phase = 'ended';
      if (contacts.size === 0) { phase = 'idle'; tracked.length = 0; }
    },
    active() {
      return phase === 'two' || phase === 'ended';
    },
  };
}

/** 2 本の指の前と今の位置から、中点の移動と距離の比を求める。 */
function twoFingerStep(before: readonly [TouchContact, TouchContact], after: readonly [TouchContact, TouchContact]): TwoFingerStep {
  const [b0, b1] = before, [a0, a1] = after;
  const beforeX = (b0.x + b1.x) / 2, beforeY = (b0.y + b1.y) / 2;
  const centerX = (a0.x + a1.x) / 2, centerY = (a0.y + a1.y) / 2;
  const beforeDistance = Math.hypot(b1.x - b0.x, b1.y - b0.y), afterDistance = Math.hypot(a1.x - a0.x, a1.y - a0.y);
  const scale = beforeDistance < MIN_FINGER_DISTANCE || afterDistance < MIN_FINGER_DISTANCE ? 1 : afterDistance / beforeDistance;
  return { dx: centerX - beforeX, dy: centerY - beforeY, scale, centerX, centerY };
}
