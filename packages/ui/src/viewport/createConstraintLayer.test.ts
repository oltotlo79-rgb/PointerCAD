import { createEmptySketchDocument } from '@pointercad/model';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connected1000Sketch } from '../../../model/src/sketch/constraints/connected1000Fixture.testSupport.js';
import { constraintMarkAt, constraintMarksOf, type ConstraintMark } from '../sketch/constraintPicking.js';
import { summarizeConstraints } from '../sketch/constraintSummary.js';
import { createConstraintLayer, quadPixelsFor } from './createConstraintLayer.js';
import { cssColor, DEFAULT_THEME_COLORS } from './themeColors.js';

const canvases: { width: number; height: number; context: ReturnType<typeof contextOf> }[] = [];
function contextOf() {
  return { font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    lineWidth: 0, lineJoin: '', strokeText: vi.fn(), fillText: vi.fn() };
}
beforeEach(() => {
  canvases.length = 0;
  vi.stubGlobal('document', { createElement: () => {
    const context = contextOf();
    const canvas = { width: 0, height: 0, context, getContext: () => context };
    canvases.push(canvas);
    return canvas;
  } });
});
afterEach(() => { vi.unstubAllGlobals(); });

function mark(id: string, offset: readonly [number, number], changes: Partial<ConstraintMark> = {}): ConstraintMark {
  return { constraintId: id, symbol: 'H', state: 'ok', position: [2, 3, 0], offset, ...changes };
}
function isGeometry(value: unknown): value is THREE.BufferGeometry {
  return value instanceof THREE.BufferGeometry;
}
function batch(object: THREE.Object3D): { object: THREE.Object3D; material: THREE.PointsMaterial; geometry: THREE.BufferGeometry } {
  if (!(object instanceof THREE.Points)) throw new Error('Expected Points');
  const material: unknown = object.material;
  const geometry: unknown = object.geometry;
  if (!(material instanceof THREE.PointsMaterial) || !isGeometry(geometry)) {
    throw new Error('Expected point material and geometry');
  }
  return { object, material, geometry };
}
function compile(material: THREE.PointsMaterial) {
  const shader: { vertexShader: string; uniforms: Record<string, { value: unknown }> } = {
    vertexShader: THREE.ShaderLib.points.vertexShader, uniforms: {},
  };
  Reflect.apply(material.onBeforeCompile.bind(material), material, [shader, undefined]);
  const scale = shader.uniforms['markPixelToClip']?.value;
  if (!(scale instanceof THREE.Vector2)) throw new Error('Expected pixel conversion uniform');
  return { shader, scale };
}

describe('constraint mark batching without padded transparent quads', () => {
  it('keeps every anchor and pixel offset in one symbol/color batch, including offsets above 256px', () => {
    const layer = createConstraintLayer('F');
    const marks = [mark('a', [-9000, -14]), mark('b', [18, -14]), mark('c', [9000, 30])];
    layer.setMarks(marks);
    expect(layer.group.children).toHaveLength(1);
    const { material, geometry, object } = batch(layer.group.children[0]);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual([2, 3, 0, 2, 3, 0, 2, 3, 0]);
    expect(Array.from(geometry.getAttribute('markOffset').array)).toEqual([-9000, -14, 18, -14, 9000, 30]);
    expect(material.size).toBe(16);
    expect([material.sizeAttenuation, material.transparent, material.alphaTest, material.depthTest, material.depthWrite])
      .toEqual([false, true, 0.1, false, false]);
    expect(object.renderOrder).toBe(5);
    expect(object.frustumCulled).toBe(false);
    expect(canvases.map(c => [c.width, c.height])).toEqual([[32, 32]]);
    expect(canvases[0].context.fillText).toHaveBeenCalledWith('H', 16, 16);
    // Picking uses exactly the same CSS offsets, including the formerly clipped far marks.
    expect(constraintMarkAt(marks, () => [100, 200], [9118, 230])).toBeNull();
    expect(constraintMarkAt(marks, () => [100, 200], [9100, 230])).toBe('c');
    layer.dispose();
  });

  it('uses independent CSS pixel displacement under perspective/orthographic projection, DPR and viewport resize', () => {
    const layer = createConstraintLayer('F');
    layer.setMarks([mark('a', [18, -14])]);
    const { material, geometry, object } = batch(layer.group.children[0]);
    const { shader, scale } = compile(material);
    expect(shader.vertexShader).toContain('gl_Position.xy += markOffset * markPixelToClip * gl_Position.w;');
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(shader.vertexShader).toContain('gl_PointSize = size;');
    for (const camera of [new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100), new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100)]) {
      for (const [width, height, ratio] of [[800, 600, 1], [800, 600, 2], [1200, 900, 0.75]]) {
        const renderer = { getPixelRatio: () => ratio, getCurrentViewport: (v: THREE.Vector4) => v.set(0, 0, width * ratio, height * ratio) };
        Reflect.apply(object.onBeforeRender.bind(object), object, [renderer, new THREE.Scene(), camera, geometry, material, null]);
        const clip = new THREE.Vector4(1, 2, -5, 1).applyMatrix4(camera.projectionMatrix);
        const shifted = clip.clone();
        shifted.x += 18 * scale.x * clip.w;
        shifted.y += -14 * scale.y * clip.w;
        expect((shifted.x / shifted.w - clip.x / clip.w) * width / 2).toBeCloseTo(18, 10);
        expect(-(shifted.y / shifted.w - clip.y / clip.w) * height / 2).toBeCloseTo(-14, 10);
        expect(shifted.z).toBe(clip.z);
        expect(shifted.w).toBe(clip.w);
      }
    }
    layer.dispose();
  });

  it('rejects an incompatible upstream shader instead of silently losing the displacement', () => {
    const layer = createConstraintLayer('F'); layer.setMarks([mark('a', [18, 0])]);
    const { material } = batch(layer.group.children[0]);
    expect(() => { Reflect.apply(material.onBeforeCompile.bind(material), material, [{ vertexShader: '#include <common>', uniforms: {} }, undefined]); })
      .toThrow('Three.js constraint mark shader chunks changed');
    layer.dispose();
  });

  it('retains all 3996 marks of the real 1000-point fixture while reducing 1000 offset batches to 2', () => {
    const sketch = connected1000Sketch(createEmptySketchDocument());
    const marks = constraintMarksOf(summarizeConstraints(sketch));
    expect(sketch.features).toHaveLength(1000);
    expect(sketch.constraints).toHaveLength(1998);
    expect(marks).toHaveLength(3996); // two distinct anchors for each of 1998 constraints
    const oldBatches = new Map(marks.map(m => [`${m.symbol}|${m.state}|${m.offset.join(',')}`, m]));
    expect(oldBatches.size).toBe(1000);
    const oldTexturePixels = [...oldBatches.values()].reduce((sum, m) => sum + Math.round(2 * quadPixelsFor(16, m.offset)) ** 2, 0);
    const layer = createConstraintLayer('F'); layer.setMarks(marks);
    expect(layer.group.children).toHaveLength(2);
    const actual: string[] = [];
    for (const child of layer.group.children) {
      const { geometry } = batch(child);
      const positions = geometry.getAttribute('position'), offsets = geometry.getAttribute('markOffset');
      expect(offsets.count).toBe(positions.count);
      for (let i = 0; i < positions.count; i += 1) {
        actual.push(JSON.stringify([positions.getX(i), positions.getY(i), positions.getZ(i), offsets.getX(i), offsets.getY(i)]));
      }
    }
    expect(actual.sort()).toEqual(marks.map(m => JSON.stringify([...m.position, ...m.offset])).sort());
    const newTexturePixels = canvases.reduce((sum, c) => sum + c.width * c.height, 0);
    expect(newTexturePixels).toBe(2048);
    expect(oldTexturePixels).toBeGreaterThan(250000000);
    console.info(JSON.stringify({ fixtureMarks: marks.length, oldBatches: oldBatches.size, newBatches: layer.group.children.length, oldTexturePixels, newTexturePixels }));
    layer.dispose();
  });

  it('retains selected size and fixed/conflict/redundant/dangling colors, and refreshes the theme', () => {
    const layer = createConstraintLayer('F');
    layer.setMarks([mark('fixed', [0, 0], { symbol: 'F' }), mark('bad', [18, 0], { state: 'conflicting' }),
      mark('redundant', [36, 0], { state: 'redundant' }), mark('dangling', [54, 0], { state: 'dangling' })]);
    expect(canvases.map(c => c.context.fillStyle)).toEqual([
      cssColor(DEFAULT_THEME_COLORS.constraintFixed), cssColor(DEFAULT_THEME_COLORS.constraintConflict), cssColor(DEFAULT_THEME_COLORS.constraintRedundant),
    ]);
    layer.setSelected('bad');
    const selected = layer.group.children.map(batch).filter(b => b.material.size === 25.6);
    expect(selected).toHaveLength(1);
    expect(Array.from(selected[0].geometry.getAttribute('markOffset').array)).toEqual([18, 0]);
    const count = canvases.length;
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, constraintConflict: 0x123456 });
    expect(canvases.slice(count).filter(c => c.context.fillStyle === '#123456')).toHaveLength(2);
    layer.setSelected(null);
    expect(layer.group.children.map(batch).every(b => b.material.size === 16)).toBe(true);
    layer.dispose();
  });

  it('reuses material/texture across movements, releases superseded geometry and clears all owned resources once', () => {
    const layer = createConstraintLayer('F'); layer.setMarks([mark('a', [0, -14])]);
    const first = batch(layer.group.children[0]);
    const released = { geometry: 0, material: 0, texture: 0 };
    first.geometry.addEventListener('dispose', () => { released.geometry += 1; });
    first.material.addEventListener('dispose', () => { released.material += 1; });
    first.material.map?.addEventListener('dispose', () => { released.texture += 1; });
    layer.setMarks([mark('a', [18, -14], { position: [12, 13, 0] })]);
    const next = batch(layer.group.children[0]);
    expect(next.material).toBe(first.material);
    expect(canvases).toHaveLength(1);
    expect(Array.from(next.geometry.getAttribute('position').array)).toEqual([12, 13, 0]);
    expect(Array.from(next.geometry.getAttribute('markOffset').array)).toEqual([18, -14]);
    expect(released).toEqual({ geometry: 1, material: 0, texture: 0 });
    next.geometry.addEventListener('dispose', () => { released.geometry += 1; });
    layer.setMarks(null); // document switch removes old marks
    expect(layer.group.children).toHaveLength(0);
    layer.dispose();
    expect(released).toEqual({ geometry: 2, material: 1, texture: 1 });
  });

  it('retains the no-canvas-context fallback without partially installing a batch', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    const layer = createConstraintLayer('F'); layer.setMarks([mark('a', [0, 0])]);
    expect(layer.group.children).toHaveLength(0);
    layer.dispose();
  });
});
