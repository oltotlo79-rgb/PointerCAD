import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { describe, expect, it } from 'vitest';
import { assertEnvironmentTarget, environmentReservation } from './environmentReservation.js';

function isGeometry(value: unknown): value is THREE.BufferGeometry {
  return value instanceof THREE.BufferGeometry;
}

function target(): THREE.WebGLRenderTarget {
  const result = new THREE.WebGLRenderTarget(768, 1024, { type: THREE.HalfFloatType,
    format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    colorSpace: THREE.LinearSRGBColorSpace, generateMipmaps: false });
  result.texture.name = 'PMREM.cubeUv';
  result.texture.mapping = THREE.CubeUVReflectionMapping;
  return result;
}

describe('audited environment payload reservations (not GPU measurements)', () => {
  it('pins the dependency source governing dimensions, formats, mips and disposal', () => {
    const hashes = {
      'src/extras/PMREMGenerator.js': '9ca266e7d718cd3c7b22f4b77950b7442d5f95376aab4bb5e04f1cd331f8d83d',
      'src/core/RenderTarget.js': '4d40b09380a7fe9148f2949dbec9d1ab5cfc6270e22c96ff5f2f6e8c3d22a8fc',
      'src/renderers/webgl/WebGLTextures.js': '241557c9b4a4cbbc76f4328329f6a26db2f27162e327ac2bb9eb4f851744184a',
      'src/renderers/webgl/WebGLObjects.js': '60829abba98579b02a84177ce86b3eea127a7decac487b69c70f0e3e83a1d923',
      'src/renderers/webgl/WebGLGeometries.js': 'd04c0ef5e4ccf862867be3a00d5c4a12de1f0939f81e7d5c50c5c4dcb3bc0eff',
      'examples/jsm/environments/RoomEnvironment.js': '55f466192cc84298755a424c5e040345006b2ee1455589b3b54126c2ea4123f4',
    };
    const base = new URL('../../node_modules/three/', import.meta.url);
    expect(JSON.parse(readFileSync(new URL('package.json', base), 'utf8'))).toMatchObject({ version: '0.185.1' });
    for (const [path, hash] of Object.entries(hashes)) {
      expect(createHash('sha256').update(readFileSync(new URL(path, base))).digest('hex'), path).toBe(hash);
    }
  });

  it('counts actual room/index/instance attributes and retains depth after PMREM disposal', () => {
    const room = new RoomEnvironment(), geometries = new Set<THREE.BufferGeometry>();
    let instanceBytes = 0;
    room.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const geometry: unknown = object.geometry;
        if (isGeometry(geometry)) geometries.add(geometry);
      }
      if (object instanceof THREE.InstancedMesh) { instanceBytes += object.instanceMatrix.array.byteLength; object.dispose(); }
    });
    const bytes = (geometry: THREE.BufferGeometry): number => Object.values(geometry.attributes)
      .reduce((sum, attribute) => sum + attribute.array.byteLength, geometry.index?.array.byteLength ?? 0);
    expect([...geometries].reduce((sum, geometry) => sum + bytes(geometry), 0)).toBe(648);
    expect(instanceBytes).toBe(384);
    const background = new THREE.BoxGeometry();
    expect(bytes(background)).toBe(840);
    expect(environmentReservation()).toEqual({ peakBytes: 15740016, retainedBytes: 9437184 });
    expect(environmentReservation('184')).toBeNull();
    expect(environmentReservation('unknown')).toBeNull();
    background.dispose(); room.dispose();
  });

  it('accepts the real output and depthless ping-pong metadata', () => {
    const output = target();
    expect(() => assertEnvironmentTarget(output)).not.toThrow();
    output.depthBuffer = false;
    expect(() => assertEnvironmentTarget(output)).not.toThrow();
    output.dispose();
  });

  it('rejects multiple render attachments accepted by the renderer public target type', () => {
    const multiple = new THREE.WebGLRenderTarget<THREE.Texture[]>(768, 1024, { count: 2 });
    expect(() => assertEnvironmentTarget(multiple)).toThrow(/reservation is unknown/);
    multiple.dispose();
  });

  it.each<(value: THREE.WebGLRenderTarget) => void>([
    value => { value.texture.type = THREE.FloatType; },
    value => { value.texture.format = THREE.RedFormat; },
    value => { value.texture.internalFormat = 'RGBA32F'; },
    value => { value.texture.generateMipmaps = true; },
    value => { value.samples = 4; },
    value => { value.stencilBuffer = true; },
    value => { value.width = 769; },
    value => { value.depthTexture = new THREE.DepthTexture(768, 1024); },
  ])('rejects unaudited storage before upload (%#)', change => {
    const output = target(); change(output);
    expect(() => assertEnvironmentTarget(output)).toThrow(/reservation is unknown/);
    output.depthTexture?.dispose(); output.dispose();
  });
});
