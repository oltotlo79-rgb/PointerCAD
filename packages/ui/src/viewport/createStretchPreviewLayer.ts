/**
 * 伸縮(E-13 の後の段)の 3D の予告: 面(向きの軸に直交する半透明の四角)と、動く部品の外接箱(実線)・伸び縮みする部材の外接箱(破線)・
 * 断る理由の部品の外接箱(太い実線と濃い色)を重ねる層。形は作り直さない(接合チェックの層と同じ形)。色だけに頼らず、線の形でも分ける。
 * 色は 3D プリントの点検の「せり出し」と同じ橙の系統(注意の色)。
 */
import * as THREE from 'three';

import type { MemberStretchMarkers } from '../assembly/memberStretchDraft.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

export interface StretchPreviewLayer {
  readonly group: THREE.Group;
  update(markers: MemberStretchMarkers | null): void;
  setThemeColors(colors: ThemeColors): void;
  setSectionPlanes(planes: readonly THREE.Plane[]): void;
  dispose(): void;
}

/** 破線の 1 つの長さと間(画面の単位ではなく mm。資料のフレームの断面 20〜40 mm で見分けられる長さ)。 */
const DASH_MM = 8;
const GAP_MM = 5;

type Box = MemberStretchMarkers['moved'][number];

export function createStretchPreviewLayer(): StretchPreviewLayer {
  const group = new THREE.Group();
  group.name = 'assembly-stretch-preview';
  const unitBox = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const planeGeometry = new THREE.PlaneGeometry(1, 1);
  const color = DEFAULT_THEME_COLORS.printOverhang;
  const planeMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
  const movedMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const stretchedMaterial = new THREE.LineDashedMaterial({ color, dashSize: DASH_MM, gapSize: GAP_MM });
  const refusedMaterial = new THREE.LineBasicMaterial({ color, depthTest: false });
  const materials = [planeMaterial, movedMaterial, stretchedMaterial, refusedMaterial];
  let last: MemberStretchMarkers | null = null;
  // 破線は箱ごとに線の長さを数えるので、箱ごとの形を作る(消す時はこれだけを消し、共有の形は残す)。
  const dashedGeometries: THREE.EdgesGeometry[] = [];

  function clear(): void {
    for (const child of [...group.children]) group.remove(child);
    for (const geometry of dashedGeometries) geometry.dispose();
    dashedGeometries.length = 0;
  }

  function boxLines(box: Box, material: THREE.LineBasicMaterial | THREE.LineDashedMaterial, dashed: boolean, name: string): THREE.LineSegments {
    const size: readonly [number, number, number] = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    const geometry = dashed ? new THREE.EdgesGeometry(new THREE.BoxGeometry(...size)) : unitBox;
    if (dashed) dashedGeometries.push(geometry);
    const lines = new THREE.LineSegments(geometry, material);
    lines.position.set((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    if (!dashed) lines.scale.set(Math.max(size[0], 1e-6), Math.max(size[1], 1e-6), Math.max(size[2], 1e-6));
    if (dashed) lines.computeLineDistances();
    lines.renderOrder = material === refusedMaterial ? 4 : 2;
    lines.name = name;
    return lines;
  }

  function planeMesh(plane: NonNullable<MemberStretchMarkers['plane']>): THREE.Mesh {
    const mesh = new THREE.Mesh(planeGeometry, planeMaterial);
    const center: [number, number, number] = [(plane.min[0] + plane.max[0]) / 2, (plane.min[1] + plane.max[1]) / 2, (plane.min[2] + plane.max[2]) / 2];
    center[plane.axis] = plane.at;
    mesh.position.set(center[0], center[1], center[2]);
    // 四角は既定で XY の面(法線 +Z)。向きの軸に合わせて回し、残りの 2 つの向きの幅に広げる。
    if (plane.axis === 0) mesh.rotation.y = Math.PI / 2;
    if (plane.axis === 1) mesh.rotation.x = Math.PI / 2;
    const width = plane.axis === 0 ? plane.max[2] - plane.min[2] : plane.max[0] - plane.min[0];
    const height = plane.axis === 2 ? plane.max[1] - plane.min[1] : plane.axis === 0 ? plane.max[1] - plane.min[1] : plane.max[2] - plane.min[2];
    mesh.scale.set(Math.max(width, 1e-6), Math.max(height, 1e-6), 1);
    mesh.renderOrder = 1;
    mesh.name = 'stretch-preview:plane';
    return mesh;
  }

  return {
    group,
    update(markers): void {
      if (markers === last) return;
      last = markers;
      clear();
      if (markers === null) return;
      if (markers.plane !== null) group.add(planeMesh(markers.plane));
      markers.moved.forEach((box, index) => group.add(boxLines(box, movedMaterial, false, `stretch-preview:moved:${String(index)}`)));
      markers.stretched.forEach((box, index) => group.add(boxLines(box, stretchedMaterial, true, `stretch-preview:stretched:${String(index)}`)));
      markers.refused.forEach((box, index) => group.add(boxLines(box, refusedMaterial, false, `stretch-preview:refused:${String(index)}`)));
    },
    setThemeColors(colors): void {
      for (const material of materials) material.color.setHex(colors.printOverhang);
    },
    setSectionPlanes(planes): void {
      for (const material of materials) material.clippingPlanes = [...planes];
    },
    dispose(): void {
      clear();
      unitBox.dispose();
      planeGeometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
