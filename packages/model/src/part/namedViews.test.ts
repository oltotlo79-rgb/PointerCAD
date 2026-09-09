import { describe, expect, it } from 'vitest';
import { createDefaultNamedViews, deleteNamedView, findNamedView, isValidNamedViewCamera,
  renameNamedView, saveNamedView, type CameraSnapshot } from './namedViews.js';

const camera: CameraSnapshot = {
  position: [30, -40, 50], target: [1, 2, 3], up: [0, 0, 1], projection: 'orthographic', zoom: 2,
};

describe('名前付きビュー(FR-113、P8-60)', () => {
  it('三面図と等角を決まった順で用意し、前・上・右から見る', () => {
    const views = createDefaultNamedViews();
    expect(views.map((view) => view.name)).toEqual(['正面', '平面', '右側面', '等角']);
    expect(views[0].position).toEqual([0, -200, 0]);
    expect(views[1].position).toEqual([0, 0, 200]);
    expect(views[2].position).toEqual([200, 0, 0]);
    expect(views[3].position[0]).toBeGreaterThan(0);
    expect(views[3].position[1]).toBeLessThan(0);
    expect(views[3].position[2]).toBeGreaterThan(0);
    expect(views.every(isValidNamedViewCamera)).toBe(true);
  });
  it('同じ入力で同じ既定値を返し、書換えられる配列を共有しない', () => {
    const first = createDefaultNamedViews();
    const second = createDefaultNamedViews();
    expect(first).toEqual(second);
    expect(first[0].position).not.toBe(second[0].position);
  });
  it('カメラの全項目を保存してIDで呼び出せる', () => {
    const result = saveNamedView([], '  組立確認  ', camera);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(findNamedView(result.views, result.view.id)).toEqual({ ...camera, id: 'namedView-1', name: '組立確認' });
    expect(result.view.position).not.toBe(camera.position);
  });
  it('同じ名前は空白を除いた後で断り、元の配列を変更しない', () => {
    const views = createDefaultNamedViews();
    expect(saveNamedView(views, ' 正面 ', camera)).toEqual({ ok: false, reason: 'duplicateName' });
    expect(views).toHaveLength(4);
  });
  it('空白だけの名前は断る', () => {
    expect(saveNamedView([], '　 ', camera)).toEqual({ ok: false, reason: 'emptyName' });
  });
  it.each([0, -1, NaN, Infinity])('不正な拡大率 %s を断る', (zoom) => {
    expect(saveNamedView([], 'test', { ...camera, zoom })).toEqual({ ok: false, reason: 'invalidCamera' });
  });
  it('同じ位置と注視点を断る', () => {
    expect(isValidNamedViewCamera({ ...camera, position: camera.target })).toBe(false);
  });
  it('上方向ゼロ・視線に平行・無限座標を断る', () => {
    expect(isValidNamedViewCamera({ ...camera, up: [0, 0, 0] })).toBe(false);
    expect(isValidNamedViewCamera({ ...camera, position: [1, 2, 30] })).toBe(false);
    expect(isValidNamedViewCamera({ ...camera, target: [Infinity, 0, 0] })).toBe(false);
  });
  it('任意の上方向と透視投影もそのまま保存する', () => {
    const result = saveNamedView([], 'ロール', { ...camera, up: [1, 2, 0], projection: 'perspective' });
    expect(result.ok && result.view.up).toEqual([1, 2, 0]);
    expect(result.ok && result.view.projection).toBe('perspective');
  });
  it('既存IDと衝突せず、同じ入力から同じIDを作る', () => {
    const first = saveNamedView([], 'first', camera);
    if (!first.ok) throw new Error(first.reason);
    const next = saveNamedView(first.views, 'next', camera);
    expect(next).toEqual(saveNamedView(first.views, 'next', camera));
    expect(next.ok && next.view.id).toBe('namedView-2');
  });
  it('改名は重複を断り、同じ名前なら配列を保つ', () => {
    const views = createDefaultNamedViews();
    expect(renameNamedView(views, views[0].id, '平面')).toEqual({ ok: false, reason: 'duplicateName' });
    const unchanged = renameNamedView(views, views[0].id, '正面');
    expect(unchanged.ok && unchanged.views).toBe(views);
    const renamed = renameNamedView(views, views[0].id, '作業正面');
    expect(renamed.ok && renamed.view.position).toEqual(views[0].position);
  });
  it('削除は対象だけを消し、無いIDなら配列を保つ', () => {
    const views = createDefaultNamedViews();
    expect(deleteNamedView(views, views[1].id).map((view) => view.name)).toEqual(['正面', '右側面', '等角']);
    expect(deleteNamedView(views, 'missing')).toBe(views);
    expect(findNamedView(views, 'missing')).toBeUndefined();
  });
});
