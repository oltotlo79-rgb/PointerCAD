import { t } from '../i18n/t.js';

/* ---- P4 タスク11: 2 点+半径の円弧(FR-326、統括の決定 §0.a-0.18) ---- */

/** 断りの文へ長さを差し込むときの丸め(1μm 単位)。桁が伸びて読みにくくなるのを防ぐ。 */
function lengthText(millimetres: number): string {
  return String(Math.round(millimetres * 1000) / 1000);
}

/**
 * 2 点の中点から、2 点+半径の円弧の中心までの距離(FR-326)。
 *
 * 中心は 2 点を結ぶ線分の垂直二等分線上にあり、弦の半分を h とすると
 * 中点から √(半径² − h²) 進んだところにある(解は 2 つで、どちらを採るかは
 * 「ふくらむ向き」の選択肢が決める)。半径が弦の半分より小さいと 2 点を通る円が
 * 引けないので null を返す。
 *
 * 向きを持たない長さだけをここで受け持ち、作図面の中で実際の中心を組み立てるのは
 * タスク12 の `shapeCommands.ts`(`arcCenterFromTwoPointsAndRadius`)。
 */
export function twoPointArcCenterOffset(chordLength: number, radius: number): number | null {
  if (!Number.isFinite(chordLength) || !Number.isFinite(radius)) {
    return null;
  }
  const half = chordLength / 2;
  if (half <= 0 || radius < half) {
    return null;
  }
  return Math.sqrt(radius * radius - half * half);
}

/**
 * 2 点と半径で円弧が引けないときの断りの文(NFR-UX-5)。引けるなら null。
 * 限界値(弦の半分)を差し込んだ文になるので ja.json のキー1つでは組み立てられない
 * (`describeRange` と同じ事情)。見出しの語だけ ja.json から引く。
 */
export function twoPointArcRadiusRejection(chordLength: number, radius: number): string | null {
  if (twoPointArcCenterOffset(chordLength, radius) !== null) {
    return null;
  }
  if (!Number.isFinite(chordLength) || chordLength <= 0) {
    return '2 点が同じ位置にあるので円弧になりません。';
  }
  const label = t('numericInput.field.radius');
  return `${label}は 2 点の間の長さの半分(${lengthText(chordLength / 2)}mm)以上にしてください。`;
}
