import type { SolidBody } from '@pointercad/model';
import * as THREE from 'three';

import type { AssemblyGeometryBundle } from './createAssemblyLayer.js';
import { buildSubShapeGeometry, type SubShapeEmphasis } from './buildSubShapeGeometry.js';
import type { ThemeColors } from './themeColors.js';

export interface AssemblyHighlight {
  readonly object: THREE.Group;
  readonly geometries: THREE.BufferGeometry[];
  readonly materials: { readonly material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial | THREE.PointsMaterial; readonly emphasis: SubShapeEmphasis }[];
  readonly bodies: readonly SolidBody[];
  readonly key: string;
}
interface HighlightContext {
  readonly highlights: Map<string, AssemblyHighlight>;
  readonly group: THREE.Group;
  readonly removeHighlight: (id: string) => void;
  readonly bodiesFor: (key: string) => readonly SolidBody[] | undefined;
  readonly limitBytes: number;
  readonly reservedBytes: () => number;
  readonly allocated: (buffer: ArrayBufferLike) => void;
  readonly backingBytes: (buffers: Iterable<ArrayBufferLike>) => number;
  readonly admitCpu: (bytes: number) => void;
  readonly keepGeometry: (geometry: THREE.BufferGeometry) => THREE.BufferGeometry;
  readonly attribute: (array: Float32Array | Uint32Array, itemSize: number) => THREE.BufferAttribute;
  readonly colors: ThemeColors;
  readonly sectionPlanes: THREE.Plane[];
  readonly trackMaterial: (material: THREE.Material) => void;
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  readonly scale: THREE.Vector3;
  readonly renderOrder: number;
}

/** 局所座標の強調だけを小さな独立overlayへ作る。共有形・batchを組み替えない。 */
export function syncAssemblyHighlights(bundle: AssemblyGeometryBundle, context: HighlightContext): void {
  const { highlights, group, removeHighlight, bodiesFor, limitBytes, reservedBytes,
    allocated, backingBytes, admitCpu, keepGeometry, attribute, colors, sectionPlanes,
    trackMaterial, position, rotation, scale, renderOrder } = context;
  const alive = new Set<string>();
  for (const draw of bundle.instances) {
    if (!draw.visible || draw.subShapes === undefined) continue;
    const bodies = bodiesFor(draw.partKey);
    if (bodies === undefined) continue;
    alive.add(draw.componentId);
    const key = JSON.stringify(draw.subShapes);
    let overlay = highlights.get(draw.componentId);
    if (overlay?.key !== key || overlay.bodies !== bodies) {
      removeHighlight(draw.componentId);
      const object = new THREE.Group();
      object.name = `assembly-mate-highlight:${draw.componentId}`;
      object.matrixAutoUpdate = false;
      const geometries: THREE.BufferGeometry[] = [];
      const materials: { material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial | THREE.PointsMaterial; emphasis: SubShapeEmphasis }[] = [];
      const built = buildSubShapeGeometry(bodies, draw.subShapes.hovered, draw.subShapes.selected,
        { limitBytes, reservedBytes: reservedBytes() },
        allocated);
      const overlayBuffers = [...built.hovered.batches, ...built.selected.batches].flatMap(batch =>
        [batch.facePositions.buffer, batch.faceNormals.buffer, batch.faceIndices.buffer,
          batch.edgePositions.buffer, batch.vertexPositions.buffer]);
      admitCpu(backingBytes(overlayBuffers));
      for (const highlight of [built.hovered, built.selected]) {
        for (const batch of highlight.batches) {
          const bodyGroup = new THREE.Group();
          bodyGroup.name = `assembly-mate-body:${batch.featureId}`;
          bodyGroup.position.set(batch.origin[0], batch.origin[1], batch.origin[2]);
          object.add(bodyGroup);
          for (const kind of ['face', 'edge', 'vertex'] as const) {
            const positions = kind === 'face' ? batch.facePositions : kind === 'edge' ? batch.edgePositions : batch.vertexPositions;
            if (positions.length === 0) continue;
            const geometry = keepGeometry(new THREE.BufferGeometry());
            geometry.setAttribute('position', attribute(positions, 3));
            geometries.push(geometry);
            const color = colors[highlight.emphasis];
            if (kind === 'face') {
              geometry.setIndex(attribute(batch.faceIndices, 1));
              const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false });
              material.clippingPlanes = sectionPlanes;
              trackMaterial(material);
              const mesh = new THREE.Mesh(geometry, material);
              mesh.renderOrder = renderOrder;
              bodyGroup.add(mesh); materials.push({ material, emphasis: highlight.emphasis }); trackMaterial(material);
            } else if (kind === 'edge') {
              const material = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false });
              material.clippingPlanes = sectionPlanes;
              trackMaterial(material);
              const lines = new THREE.LineSegments(geometry, material);
              lines.renderOrder = renderOrder;
              bodyGroup.add(lines); materials.push({ material, emphasis: highlight.emphasis }); trackMaterial(material);
            } else {
              const material = new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false, depthWrite: false });
              material.clippingPlanes = sectionPlanes;
              trackMaterial(material);
              const points = new THREE.Points(geometry, material);
              points.renderOrder = renderOrder;
              bodyGroup.add(points); materials.push({ material, emphasis: highlight.emphasis }); trackMaterial(material);
            }
          }
        }
      }
      overlay = { object, geometries, materials, bodies, key };
      highlights.set(draw.componentId, overlay);
      group.add(object);
    }
    // modelView行列でカメラからの差をdoubleで求める、個別描画と同じ精度契約。
    overlay.object.matrix.compose(position.fromArray(draw.placement.position), rotation.fromArray(draw.placement.rotation), scale);
    overlay.object.matrixWorldNeedsUpdate = true;
    for (const { material, emphasis } of overlay.materials) material.color.setHex(colors[emphasis]);
  }
  for (const id of highlights.keys()) if (!alive.has(id)) removeHighlight(id);
}
