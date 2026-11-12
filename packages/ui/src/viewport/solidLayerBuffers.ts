/**
 * 立体の表示層が形(BufferGeometry)へ並びを渡し、解放するときの決まり。
 *
 * 渡す並び(Float32Array・Uint32Array)は組み立ての結果・控え・Undo と共有されうる**借り物**なので
 * 書き換えない。同じ参照なら何もせず、同じ長さなら属性と GPU の入れ物を使い回して参照だけを替える。
 * 解放は GPU への通知(`dispose`)と、借り物の CPU の並びへの参照を外すことの 2 つを必ず行う。
 */
import * as THREE from 'three';

/** Attribute and index bytes currently attached to one geometry. */
export function geometryAttributeBytes(geometry: THREE.BufferGeometry): number {
  let bytes = geometry.getIndex()?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    if (attribute instanceof THREE.BufferAttribute) bytes += attribute.array.byteLength;
  }
  return bytes;
}

/**
 * 借用した並びを差し替える。入力配列は Source/Cache/Undo と共有されうるため書き換えない。
 * 同じ参照なら何もせず、同長なら attribute と GPU buffer を再利用して array 参照だけ更新する。
 * サイズが変わる場合は、旧属性がまだ付いている間に GPU 解放を一度通知する。
 */
export function setGeometryAttributes(
  geometry: THREE.BufferGeometry,
  attributes: readonly { readonly name: string; readonly values: Float32Array; readonly itemSize?: number }[],
  indices?: Uint32Array,
): void {
  const index = geometry.getIndex();
  const replacesAttribute = attributes.some(({ name, values, itemSize = 3 }) => {
    const existing = geometry.getAttribute(name);
    return existing !== undefined && (!(existing instanceof THREE.BufferAttribute)
      || !(existing.array instanceof Float32Array)
      || existing.array.length !== values.length || existing.itemSize !== itemSize);
  });
  const replacesIndex = indices !== undefined && index !== null
    && (!(index.array instanceof Uint32Array) || index.array.length !== indices.length);
  if (replacesAttribute || replacesIndex) {
    // Dispose before replacing any attribute: renderer still sees every old GPU buffer.
    // Same-length updates retain those buffers and only upload the new borrowed array.
    geometry.dispose();
  }
  for (const { name, values, itemSize = 3 } of attributes) {
    const existing = geometry.getAttribute(name);
    if (existing instanceof THREE.BufferAttribute && existing.array instanceof Float32Array
      && existing.array.length === values.length && existing.itemSize === itemSize) {
      if (existing.array !== values) {
        existing.array = values;
        existing.needsUpdate = true;
      }
    } else {
      geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
    }
  }
  if (indices !== undefined) {
    if (index !== null && index.array instanceof Uint32Array && index.array.length === indices.length) {
      if (index.array !== indices) {
        index.array = indices;
        index.needsUpdate = true;
      }
    } else {
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }
  }
}

export function setVectorAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  values: Float32Array,
  itemSize = 3,
): void {
  setGeometryAttributes(geometry, [{ name, values, itemSize }]);
}

/** GPU 解放通知の後で、geometry が保持する借用 CPU 配列への参照も外す。 */
export function disposeBorrowedGeometry(geometry: THREE.BufferGeometry): void {
  geometry.dispose();
  for (const name of Object.keys(geometry.attributes)) {
    geometry.deleteAttribute(name);
  }
  geometry.setIndex(null);
  geometry.boundingBox = null;
  geometry.boundingSphere = null;
}

/** A later host-reference detach failure must not repeat a successful GPU release. */
export function borrowedGeometryRelease(geometry: THREE.BufferGeometry): () => void {
  let notified = false;
  return () => {
    if (!notified) { geometry.dispose(); notified = true; }
    for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
    geometry.setIndex(null); geometry.boundingBox = null; geometry.boundingSphere = null;
  };
}
