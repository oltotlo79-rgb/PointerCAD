/** 保存できるカメラ。形状の履歴とは独立した文書データ(FR-113)。 */
import type { Vec3 } from '../sketch/vec3.js';

export interface NamedView {
  readonly id: string;
  readonly name: string;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly projection: 'perspective' | 'orthographic';
  readonly zoom: number;
}

export type CameraSnapshot = Omit<NamedView, 'id' | 'name'>;
export type NamedViewRefusal = 'emptyName' | 'duplicateName' | 'invalidCamera' | 'notFound';
export type NamedViewChange =
  | { readonly ok: true; readonly views: readonly NamedView[]; readonly view: NamedView }
  | { readonly ok: false; readonly reason: NamedViewRefusal };

function normalized(vector: Vec3): Vec3 | null {
  if (!vector.every(Number.isFinite)) return null;
  const maximum = Math.max(...vector.map(Math.abs));
  if (maximum === 0) return null;
  const scaled = vector.map((value) => value / maximum);
  const length = Math.hypot(...scaled);
  return [scaled[0] / length, scaled[1] / length, scaled[2] / length];
}

/** 無限大・視点と注視点の一致・視線と上方向の平行は保存前と読込時に断る。 */
export function isValidNamedViewCamera(camera: CameraSnapshot): boolean {
  if (!camera.position.every(Number.isFinite) || !camera.target.every(Number.isFinite)
    || !Number.isFinite(camera.zoom) || camera.zoom <= 0
    || (camera.projection !== 'perspective' && camera.projection !== 'orthographic')) return false;
  const direction = normalized([
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ]);
  const up = normalized(camera.up);
  if (direction === null || up === null) return false;
  return Math.hypot(
    direction[1] * up[2] - direction[2] * up[1],
    direction[2] * up[0] - direction[0] * up[2],
    direction[0] * up[1] - direction[1] * up[0],
  ) > 1e-10;
}

function copyCamera(camera: CameraSnapshot): CameraSnapshot {
  return { position: [...camera.position], target: [...camera.target], up: [...camera.up],
    projection: camera.projection, zoom: camera.zoom };
}

export function createDefaultNamedViews(): readonly NamedView[] {
  const distance = 200;
  const diagonal = distance / Math.sqrt(3);
  const make = (id: string, name: string, position: Vec3, up: Vec3): NamedView => ({
    id, name, position, target: [0, 0, 0], up, projection: 'orthographic', zoom: 1,
  });
  return [
    make('namedView-front', '正面', [0, -distance, 0], [0, 0, 1]),
    make('namedView-top', '平面', [0, 0, distance], [0, 1, 0]),
    make('namedView-right', '右側面', [distance, 0, 0], [0, 0, 1]),
    { ...make('namedView-isometric', '等角', [diagonal, -diagonal, diagonal], [0, 0, 1]),
      projection: 'perspective' },
  ];
}

export function saveNamedView(
  views: readonly NamedView[], name: string, camera: CameraSnapshot,
): NamedViewChange {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'emptyName' };
  if (views.some((view) => view.name === trimmed)) return { ok: false, reason: 'duplicateName' };
  if (!isValidNamedViewCamera(camera)) return { ok: false, reason: 'invalidCamera' };
  let serial = 1;
  for (const entry of views) {
    const match = /^namedView-(\d+)$/.exec(entry.id);
    if (match !== null && Number.isSafeInteger(Number(match[1]))) serial = Math.max(serial, Number(match[1]) + 1);
  }
  const view: NamedView = { id: `namedView-${String(serial)}`, name: trimmed, ...copyCamera(camera) };
  return { ok: true, views: [...views, view], view };
}

export function findNamedView(views: readonly NamedView[], id: string): NamedView | undefined {
  return views.find((view) => view.id === id);
}

export function renameNamedView(views: readonly NamedView[], id: string, name: string): NamedViewChange {
  const previous = findNamedView(views, id);
  if (previous === undefined) return { ok: false, reason: 'notFound' };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'emptyName' };
  if (views.some((view) => view.id !== id && view.name === trimmed)) {
    return { ok: false, reason: 'duplicateName' };
  }
  if (previous.name === trimmed) return { ok: true, views, view: previous };
  const view = { ...previous, name: trimmed };
  return { ok: true, views: views.map((entry) => entry.id === id ? view : entry), view };
}

export function deleteNamedView(views: readonly NamedView[], id: string): readonly NamedView[] {
  return views.some((view) => view.id === id) ? views.filter((view) => view.id !== id) : views;
}
