import { describe, expect, it } from 'vitest';
import { FunctionSurfacePlanCache } from './functionSurfacePlanCache.js';
import { cacheKeyFor, hash64 } from '../part/cacheKey.js';

function plan(inputSignature: string) {
  return { kind: 'functionSurface' as const, inputSignature, geometry: {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
    triangles: [[0, 1, 2]] as [number, number, number][],
    bounds: { minimum: [-2, -2, -2] as [number, number, number], maximum: [2, 2, 2] as [number, number, number] },
  } };
}

describe('関数曲面の再利用は原式と全入力で識別し、容量を制限する', () => {
  it('同じ原式でも旧三角形版の保存形状を現在の面構成として再利用しない', () => {
    const inputSignature='saved-formula-and-ranges';
    const legacyKey=hash64(`functionSurface{input=${JSON.stringify(inputSignature)}}`);
    const currentKey=cacheKeyFor({kind:'functionSurface',inputSignature});
    expect(currentKey).not.toBe(legacyKey);
    expect(cacheKeyFor({kind:'functionSurface',inputSignature})).toBe(currentKey);
    expect(cacheKeyFor({kind:'functionSurface',inputSignature:inputSignature+'-new-coefficient'})).not.toBe(currentKey);
  });
  it('呼び出し側の変更で控えの点・面・XYZ範囲を変えられない', () => {
    const cache = new FunctionSurfacePlanCache(), input = plan('source');
    cache.set(input);
    input.geometry.vertices[0][0] = 99;
    input.geometry.triangles[0][0] = 2;
    input.geometry.bounds.minimum[0] = -99;
    const saved = cache.get('source');
    if (saved === undefined || !('vertices' in saved.geometry)) throw new Error('The sample was not retained');
    expect(saved.geometry.vertices[0]).toEqual([0, 0, 0]);
    expect(saved.geometry.triangles[0]).toEqual([0, 1, 2]);
    expect(saved.geometry.bounds.minimum).toEqual([-2, -2, -2]);
    const savedVertex = saved.geometry.vertices[0];
    expect(() => Object.assign(savedVertex, { 0: 42 })).toThrow(TypeError);
  });

  it('最近使ったものを残し、項目数と保持する数値の両方を制限する', () => {
    const cache = new FunctionSurfacePlanCache(2, 36);
    cache.set(plan('a')); cache.set(plan('b')); cache.get('a'); cache.set(plan('c'));
    expect(cache.get('a')).toBeDefined(); expect(cache.get('b')).toBeUndefined(); expect(cache.get('c')).toBeDefined();
    expect(cache.size).toBe(2); expect(cache.retainedNumbers).toBe(36);
    const input = plan('large'); input.geometry.vertices.push([1, 1, 0]);
    cache.set(input);
    expect(cache.size).toBe(1); expect(cache.retainedNumbers).toBe(21); expect(cache.get('large')).toBeDefined();
  });

  it('上限より大きい面は保持せず、入力も変えない', () => {
    const cache = new FunctionSurfacePlanCache(2, 17), input = plan('large'), before = JSON.stringify(input);
    cache.set(input); expect(cache.size).toBe(0); expect(cache.get('large')).toBeUndefined();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('同じ入力の置換とclearで容量を二重に数えない', () => {
    const cache = new FunctionSurfacePlanCache();
    for (let index = 0; index < 50; index += 1) cache.set(plan('same'));
    expect(cache.size).toBe(1); expect(cache.retainedNumbers).toBe(18);
    cache.clear(); expect(cache.size).toBe(0); expect(cache.retainedNumbers).toBe(0);
    cache.set(plan('again')); expect(cache.retainedNumbers).toBe(18);
  });
});
