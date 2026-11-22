/**
 * 面の移動の矢印のつまみの表示(M-05 4-2a、`solidLayerFaceHandle.ts`)を、立体の層(`createSolidLayer`)の口から確かめる。
 * 出すまで部品を作らない事(層の部品の並びを変えない)、根もとと向き、長さが断面のつまみと同じ決め方である事、
 * 同じつまみの渡し直し・隠す・テーマ・破棄。
 */
import type { SolidBody, Vec3 } from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { bodyFor } from '../store/testing/createTestStore.js';
import { buildSolidGeometry } from './buildSolidGeometry.js';
import { createSolidLayer } from './createSolidLayer.js';
import { SUB_SHAPE_LINE_RENDER_ORDER } from './solidLayerRenderOrder.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';

/** 40×30×10 の板を包む三角形 1 枚(届く範囲を測るのに要るのは境界の球だけ)。 */
function board(): SolidBody {
  const body = bodyFor('extrude-1');
  return { ...body, mesh: { ...body.mesh, positions: new Float32Array([0, 0, 0, 40, 0, 0, 0, 30, 10]) } };
}

const HANDLE = { origin: [45, 15, 5] as Vec3, normal: [1, 0, 0] as Vec3 };

/** 渡す前の部品の並びに無かった部品(矢印の線)を 1 つだけ取り出す。 */
type ArrowLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/** 矢印の線か。材質まで確かめてから絞り込む(instanceof だけでは型の引数が any になる。createSolidLayer.test.ts の isSphereGridLines と同じ作り)。 */
function isArrowLines(object: THREE.Object3D): object is ArrowLines {
  if (!(object instanceof THREE.LineSegments)) return false;
  const material: unknown = object.material;
  return material instanceof THREE.LineBasicMaterial;
}

function addedArrow(before: readonly THREE.Object3D[], group: THREE.Group): {
  readonly lines: ArrowLines; readonly material: THREE.LineBasicMaterial;
} {
  const added = group.children.filter(child => !before.includes(child));
  expect(added).toHaveLength(1);
  const [lines] = added;
  if (lines === undefined || !isArrowLines(lines)) throw new Error('arrow lines expected');
  return { lines, material: lines.material };
}

function arrowTip(lines: THREE.LineSegments): readonly number[] {
  const position = lines.geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) throw new Error('missing arrow positions');
  return [...position.array.slice(3, 6)];
}

describe('面の移動のつまみの表示(M-05 4-2a)', () => {
  it('出すまでは部品を作らず、層の部品の並びは 1 つも変わらない', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([board()], null, []), 'shadedWithEdges');
    const children = [...layer.group.children];
    layer.updateFaceOffsetHandle(null);
    expect(layer.group.children).toEqual(children);
    layer.dispose();
  });

  it('根もとに置いた矢印は法線の向きで、長さは同じ根もとの断面のつまみの矢印と同じ', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([board()], null, []), 'shadedWithEdges');
    const before = [...layer.group.children];
    layer.updateFaceOffsetHandle(HANDLE);
    const { lines, material } = addedArrow(before, layer.group);
    expect(lines.visible).toBe(true);
    expect(lines.position.toArray()).toEqual([45, 15, 5]);
    expect(lines.renderOrder).toBe(SUB_SHAPE_LINE_RENDER_ORDER);
    expect(material.depthTest).toBe(false);
    expect(material.color.getHex()).toBe(DEFAULT_THEME_COLORS.track);
    const tip = arrowTip(lines);
    expect(tip[0]).toBeGreaterThan(0);
    expect([tip[1], tip[2]]).toEqual([0, 0]);

    const withSection = [...layer.group.children];
    layer.updateSectionHandle({ plane: { origin: [45, 15, 5], normal: [1, 0, 0], axisU: [0, 1, 0], axisV: [0, 0, 1] }, keep: 'positive' });
    expect(layer.group.children).toEqual(withSection);
    const sectionArrow = layer.group.children.find((child): child is THREE.LineSegments => child instanceof THREE.LineSegments
      && child.visible && child.material instanceof THREE.LineBasicMaterial && child.material.color.getHex() === 0x38bdf8);
    if (sectionArrow === undefined) throw new Error('missing section handle arrow');
    expect(arrowTip(sectionArrow)[0]).toBe(tip[0]);
    layer.dispose();
  });

  it('同じつまみの渡し直しでは並びを触らず、null で隠して同じ部品で出し直す', () => {
    const layer = createSolidLayer();
    const before = [...layer.group.children];
    layer.updateFaceOffsetHandle(HANDLE);
    const { lines } = addedArrow(before, layer.group);
    const attribute = lines.geometry.getAttribute('position');
    layer.updateFaceOffsetHandle(HANDLE);
    expect(lines.geometry.getAttribute('position')).toBe(attribute);
    // ボディが無い時も、断面のつまみと同じ代わりの大きさで出る(対角 40 の 0.18 倍)。
    expect(arrowTip(lines)[0]).toBeCloseTo(7.2, 5);
    layer.updateFaceOffsetHandle(null);
    expect(lines.visible).toBe(false);
    layer.updateFaceOffsetHandle({ origin: [0, 0, -2], normal: [0, 0, -1] });
    expect(layer.group.children.filter(child => !before.includes(child))).toEqual([lines]);
    expect(lines.visible).toBe(true);
    expect(lines.position.toArray()).toEqual([0, 0, -2]);
    const tip = arrowTip(lines);
    expect([tip[0], tip[1]]).toEqual([0, 0]);
    expect(tip[2]).toBeLessThan(0);
    layer.dispose();
  });

  it('色はテーマの track。作る前に変えたテーマでも、作った後に変えたテーマでも従う', () => {
    const layer = createSolidLayer();
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, track: 0x123456 });
    const before = [...layer.group.children];
    layer.updateFaceOffsetHandle(HANDLE);
    const { material } = addedArrow(before, layer.group);
    expect(material.color.getHex()).toBe(0x123456);
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, track: 0x654321 });
    expect(material.color.getHex()).toBe(0x654321);
    layer.dispose();
  });

  it('破棄で矢印の形と材質を返し、破棄の後の渡し直しでは何も作らない', () => {
    const layer = createSolidLayer();
    const before = [...layer.group.children];
    layer.updateFaceOffsetHandle(HANDLE);
    const { lines, material } = addedArrow(before, layer.group);
    const returned: string[] = [];
    lines.geometry.addEventListener('dispose', () => { returned.push('geometry'); });
    material.addEventListener('dispose', () => { returned.push('material'); });
    layer.dispose();
    expect(returned.sort()).toEqual(['geometry', 'material']);
    layer.updateFaceOffsetHandle({ origin: [1, 2, 3], normal: [0, 1, 0] });
    expect(layer.group.children).toHaveLength(0);
  });
});
