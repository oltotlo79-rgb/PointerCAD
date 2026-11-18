/**
 * ボルト締結の窓の当たり(J-02c)の 3D の印: 同じ穴フィーチャーのほかの穴を、穴の径より少し大きい破線の輪で示す層。選んだ物の光らせ方
 * (面の色)と違う形にして、色だけに頼らない。形は作り直さない(接合チェックの層と同じ形)。輪は奥でも見えるようにする。
 */
import * as THREE from 'three';

import type { BoltedJointHoleHint } from '../assembly/boltedJointHoleHints.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

export interface HoleHintLayer {
  readonly group: THREE.Group;
  update(hints: readonly BoltedJointHoleHint[]): void;
  setThemeColors(colors: ThemeColors): void;
  setSectionPlanes(planes: readonly THREE.Plane[]): void;
  dispose(): void;
}

/** 輪の半径(穴の径の何倍か)と、輪の円を分ける数。 */
const RING_SCALE = 1.35;
const RING_SEGMENTS = 48;
/** 破線の長さと間(輪の周の長さに対する比。穴の大きさに依らず同じ数の破線にする)。 */
const DASH_RATIO = 0.06;

export function createHoleHintLayer(): HoleHintLayer {
  const group = new THREE.Group();
  group.name = 'assembly-hole-hints';
  const material = new THREE.LineDashedMaterial({ color: DEFAULT_THEME_COLORS.printOverhang, dashSize: 1, gapSize: 1, depthTest: false,
    transparent: true, opacity: 0.9 });
  let last: readonly BoltedJointHoleHint[] = [];
  // 置いた輪(輪ごとに形を作る。材質は共有)。
  const rings: THREE.LineLoop[] = [];

  function clear(): void {
    for (const loop of rings) {
      group.remove(loop);
      loop.geometry.dispose();
    }
    rings.length = 0;
  }

  function ring(hint: BoltedJointHoleHint, index: number): THREE.LineLoop {
    const radius = hint.radius * RING_SCALE;
    const points = Array.from({ length: RING_SEGMENTS }, (_unused, step) => {
      const angle = (step / RING_SEGMENTS) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    });
    const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material);
    loop.computeLineDistances();
    // 輪は局所の XY の面。穴の軸(局所 +Z)を世界の軸へ向け、穴の面の重心へ置く。
    loop.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(hint.normal[0], hint.normal[1], hint.normal[2]).normalize());
    loop.position.set(hint.center[0], hint.center[1], hint.center[2]);
    loop.renderOrder = 4;
    loop.name = `hole-hint:${hint.side}:${String(index)}`;
    return loop;
  }

  return {
    group,
    update(hints): void {
      if (hints === last) return;
      last = hints;
      clear();
      const perimeter = hints.reduce((longest, hint) => Math.max(longest, 2 * Math.PI * hint.radius * RING_SCALE), 0);
      material.dashSize = Math.max(perimeter * DASH_RATIO, 1e-3);
      material.gapSize = material.dashSize;
      hints.forEach((hint, index) => {
        const loop = ring(hint, index);
        rings.push(loop);
        group.add(loop);
      });
    },
    setThemeColors(colors): void {
      material.color.setHex(colors.printOverhang);
    },
    setSectionPlanes(planes): void {
      material.clippingPlanes = [...planes];
    },
    dispose(): void {
      clear();
      material.dispose();
    },
  };
}
