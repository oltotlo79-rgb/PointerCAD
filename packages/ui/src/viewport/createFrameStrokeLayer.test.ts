import type { Vec3 } from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createFrameStrokeLayer, type FrameStrokeLayer } from './createFrameStrokeLayer.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

const SQUARE: readonly Vec3[] = [[0, 0, 0], [600, 0, 0], [600, 400, 0], [0, 400, 0]];

function objectOf<T extends THREE.Object3D>(layer: FrameStrokeLayer, name: string, type: new (...args: never[]) => T): T {
  const object = layer.group.getObjectByName(name);
  if (!(object instanceof type)) throw new Error(`${name} がありません`);
  return object;
}

/** 線分の両端の座標を、[x, y, z] の並びで読む。 */
function positionsOf(object: THREE.LineSegments | THREE.Points): number[][] {
  const attribute = object.geometry.getAttribute('position');
  return Array.from({ length: attribute.count }, (_, index) => [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]);
}

/* E-08 第 2 段: 3D の画面で打った点と、点を結ぶ一時の線。 */
describe('打った点と一時の線の層', () => {
  it('開いた点の列は続く 2 点ごとに結び、点の印を置く。閉じると最後の点から最初の点へも結ぶ', () => {
    const layer = createFrameStrokeLayer();
    const lines = (): THREE.LineSegments => objectOf(layer, 'frame-stroke:lines', THREE.LineSegments);
    const dots = (): THREE.Points => objectOf(layer, 'frame-stroke:points', THREE.Points);
    expect(layer.group.visible).toBe(false);
    expect(layer.view()).toEqual({ points: 0, segments: 0, closed: false });
    layer.update({ points: SQUARE.slice(0, 3), closed: false });
    expect(layer.group.visible).toBe(true);
    expect(positionsOf(lines())).toEqual([[0, 0, 0], [600, 0, 0], [600, 0, 0], [600, 400, 0]]);
    expect(positionsOf(dots())).toEqual([[0, 0, 0], [600, 0, 0], [600, 400, 0]]);
    expect(layer.view()).toEqual({ points: 3, segments: 2, closed: false });
    layer.update({ points: SQUARE, closed: true });
    expect(positionsOf(lines())).toHaveLength(8);
    expect(positionsOf(lines()).slice(6)).toEqual([[0, 400, 0], [0, 0, 0]]);
    expect(layer.view()).toEqual({ points: 4, segments: 4, closed: true });
    layer.dispose();
  });

  it('点が 1 つの時は線を引かず点だけ。2 点で閉じても往復の線を足さない。null と空の列は隠す', () => {
    const layer = createFrameStrokeLayer();
    layer.update({ points: SQUARE.slice(0, 1), closed: false });
    expect(positionsOf(objectOf(layer, 'frame-stroke:lines', THREE.LineSegments))).toEqual([]);
    expect(positionsOf(objectOf(layer, 'frame-stroke:points', THREE.Points))).toEqual([[0, 0, 0]]);
    layer.update({ points: SQUARE.slice(0, 2), closed: true });
    expect(positionsOf(objectOf(layer, 'frame-stroke:lines', THREE.LineSegments))).toHaveLength(2);
    layer.update(null);
    expect(layer.group.visible).toBe(false);
    expect(layer.view()).toEqual({ points: 0, segments: 0, closed: false });
    layer.update({ points: [], closed: false });
    expect(layer.group.visible).toBe(false);
    layer.dispose();
  });

  it('同じ点の列と閉じるの組では形を作り直さず、閉じるだけ変わった時は作り直す', () => {
    const layer = createFrameStrokeLayer();
    const stroke = { points: SQUARE, closed: false };
    layer.update(stroke);
    const geometry = objectOf(layer, 'frame-stroke:lines', THREE.LineSegments).geometry;
    layer.update({ ...stroke });
    expect(objectOf(layer, 'frame-stroke:lines', THREE.LineSegments).geometry).toBe(geometry);
    layer.update({ ...stroke, closed: true });
    expect(objectOf(layer, 'frame-stroke:lines', THREE.LineSegments).geometry).not.toBe(geometry);
    layer.dispose();
  });

  it('深度を見ずに部品の後ろでも見え、色は案内線の色(テーマに従う)', () => {
    const layer = createFrameStrokeLayer();
    const lineMaterial: unknown = objectOf(layer, 'frame-stroke:lines', THREE.LineSegments).material;
    const pointMaterial: unknown = objectOf(layer, 'frame-stroke:points', THREE.Points).material;
    if (!(lineMaterial instanceof THREE.LineBasicMaterial) || !(pointMaterial instanceof THREE.PointsMaterial)) throw new Error('材質');
    expect([lineMaterial.depthTest, pointMaterial.depthTest, pointMaterial.sizeAttenuation]).toEqual([false, false, false]);
    expect(lineMaterial.color.getHex()).toBe(DEFAULT_THEME_COLORS.track);
    const track = DEFAULT_THEME_COLORS.track === 0x123456 ? 0x654321 : 0x123456;
    const colors: ThemeColors = { ...DEFAULT_THEME_COLORS, track };
    layer.setThemeColors(colors);
    expect([lineMaterial.color.getHex(), pointMaterial.color.getHex()]).toEqual([track, track]);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
  });
});
