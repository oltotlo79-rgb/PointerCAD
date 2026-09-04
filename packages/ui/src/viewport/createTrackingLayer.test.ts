/**
 * 案内線の表示層(計画書 docs/plans/P4b-スケッチの仕上げ.md タスク16、§0.14)。
 *
 * 座標を作る純関数を中心に検査する。three.js の入れ物そのものは DOM にも WebGL にも
 * 触れないので、**本数が増えないこと**(NFR-PF-1 の落とし穴「毎フレーム作り直さない」)
 * だけはここで固定し、実際の見え方は撮影と目視で確かめる(`createSolidLayer.test.ts` と
 * 同じ決め方)。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { TrackCandidate } from '../sketch/trackMath.js';
import {
  createTrackingLayer,
  MAX_TRACK_LINES,
  trackLineCount,
  trackLineEndpoints,
  trackLinePositions,
} from './createTrackingLayer.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';

function polarLine(): TrackCandidate {
  return {
    kind: 'polar',
    origin: [0, 0, 0],
    direction: [1, 0, 0],
    sourceFeatureId: null,
    angleDegrees: 0,
  };
}

function extensionLine(): TrackCandidate {
  return {
    kind: 'extension',
    origin: [5, 0, 0],
    direction: [0, 1, 0],
    sourceFeatureId: 'l1',
    angleDegrees: null,
  };
}

describe('案内線の座標(FR-110、§0.14)', () => {
  it('通る点の両側へ同じ長さだけ伸ばす(画面いっぱい)', () => {
    const [from, to] = trackLineEndpoints(polarLine(), 100);
    expect(from).toEqual([-100, 0, 0]);
    expect(to).toEqual([100, 0, 0]);
  });

  it('起点が原点でなくても、その点を挟んで両側へ伸びる', () => {
    const [from, to] = trackLineEndpoints(extensionLine(), 50);
    expect(from).toEqual([5, -50, 0]);
    expect(to).toEqual([5, 50, 0]);
  });

  it('同時に出すのは最大 2 本(§0.14)', () => {
    expect(MAX_TRACK_LINES).toBe(2);
    expect(trackLineCount([])).toBe(0);
    expect(trackLineCount([polarLine()])).toBe(1);
    expect(trackLineCount([polarLine(), extensionLine()])).toBe(2);
    // 3 本目以降は捨てる。
    expect(trackLineCount([polarLine(), extensionLine(), polarLine()])).toBe(2);
  });

  it('座標の並びの長さは本数によらず一定(入れ物を作り直さない、NFR-PF-1)', () => {
    expect(trackLinePositions([], 100)).toHaveLength(12);
    expect(trackLinePositions([polarLine()], 100)).toHaveLength(12);
    expect(trackLinePositions([polarLine(), extensionLine()], 100)).toHaveLength(12);
    expect(
      trackLinePositions([polarLine(), extensionLine(), polarLine()], 100),
    ).toHaveLength(12);
  });

  it('1 本目・2 本目の順に並び、余りは 0 のまま残る', () => {
    const values = trackLinePositions([polarLine(), extensionLine()], 10);
    expect(Array.from(values)).toEqual([-10, 0, 0, 10, 0, 0, 5, -10, 0, 5, 10, 0]);

    const single = trackLinePositions([polarLine()], 10);
    expect(Array.from(single.slice(6))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

/**
 * 案内線の材質(破線)を取り出す。three.js の `Line` の型引数には既定が入っていて
 * `material` が `any` に広がるため、いったん `unknown` で受けてから種類で絞る
 * (`as` を使わずに型を確かめる、rules/02-禁止事項.md)。
 */
function dashedMaterialOf(object: THREE.Object3D): THREE.LineDashedMaterial | null {
  if (!(object instanceof THREE.Line)) {
    return null;
  }
  const material: unknown = object.material;
  return material instanceof THREE.LineDashedMaterial ? material : null;
}

describe('案内線の層(NFR-PF-1)', () => {
  it('線の部品は 1 つだけで、本数が変わっても増えない', () => {
    const layer = createTrackingLayer();
    expect(layer.group.children).toHaveLength(1);

    layer.setLines([polarLine()]);
    layer.setLines([polarLine(), extensionLine()]);
    layer.setLines(null);
    expect(layer.group.children).toHaveLength(1);

    layer.dispose();
  });

  it('案内線が無いときは描かない', () => {
    const layer = createTrackingLayer();
    layer.setLines([polarLine()]);
    expect(layer.group.children[0].visible).toBe(true);

    layer.setLines([]);
    expect(layer.group.children[0].visible).toBe(false);

    layer.setLines(null);
    expect(layer.group.children[0].visible).toBe(false);

    layer.dispose();
  });

  it('破線で引き、テーマの色をそのまま材質へ写す(固定色を焼き込まない)', () => {
    const layer = createTrackingLayer();
    const material = dashedMaterialOf(layer.group.children[0]);
    // 破線(FR-110 の案内線、§0.14)であることを材質の種類で固定する。
    expect(material).not.toBeNull();
    if (material === null) {
      return;
    }
    // 既定はダークのアクセント色。テーマを変えるとその場で塗り替わる(FR-908)。
    expect(material.color.getHex()).toBe(DEFAULT_THEME_COLORS.track);
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, track: 0x123456 });
    expect(material.color.getHex()).toBe(0x123456);

    // 破線の刻みは長さに比例して変わる(拡大率が変わっても画面上の見え方を保つ)。
    layer.setLines([polarLine()]);
    layer.setHalfLength(1000);
    expect(material.dashSize).toBeCloseTo(4, 9);
    expect(material.gapSize).toBeCloseTo(3, 9);

    layer.dispose();
  });
});
