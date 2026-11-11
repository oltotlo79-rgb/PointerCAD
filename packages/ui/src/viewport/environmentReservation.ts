import * as THREE from 'three';

export interface EnvironmentReservation {
  readonly peakBytes: number;
  readonly retainedBytes: number;
}

/**
 * Audited Three 0.185.1 PMREMGenerator.fromScene(size=256): two 768x1024 RGBA16F
 * atlases, output DEPTH_COMPONENT24 (charged as 4 bytes/pixel), no hardware mips,
 * stencil or MSAA. Eleven LOD planes: 11*36*(3+2+1)*4; room box/index 648,
 * six instance matrices 384, background box/index 840. LODs live in the atlas.
 * Known payload reservations, NOT driver/native/shader/OS GPU memory measurements.
 * The dependency-source regression test pins the audited patch and implementation.
 */
const RESERVATION: EnvironmentReservation = Object.freeze({
  peakBytes: 768 * 1024 * (8 + 4 + 8) + 11 * 36 * 6 * 4 + 648 + 384 + 840,
  retainedBytes: 768 * 1024 * (8 + 4),
});

export const UNKNOWN_ENVIRONMENT_MESSAGE = 'Local display needs an environment map whose GPU reservation is unknown';
export const ENVIRONMENT_BUDGET_MESSAGE = 'Environment allocations exceed the shared GPU budget';

export function environmentReservation(revision = THREE.REVISION): EnvironmentReservation | null {
  return revision === '185' ? RESERVATION : null;
}

export type EnvironmentRenderTarget = NonNullable<Parameters<THREE.WebGLRenderer['setRenderTarget']>[0]>;

/** Checked before the renderer can allocate storage, not after a GPU upload. */
export function assertEnvironmentTarget(target: EnvironmentRenderTarget): void {
  const texture = target.texture;
  if (Array.isArray(texture) || target.width !== 768 || target.height !== 1024 || target.depth !== 1
    || target.textures.length !== 1 || target.samples !== 0 || target.stencilBuffer
    || target.depthTexture !== null || texture.type !== THREE.HalfFloatType
    || texture.format !== THREE.RGBAFormat || texture.internalFormat !== null
    || texture.generateMipmaps || texture.mipmaps.length !== 0
    || texture.minFilter !== THREE.LinearFilter || texture.magFilter !== THREE.LinearFilter
    || texture.colorSpace !== THREE.LinearSRGBColorSpace || texture.mapping !== THREE.CubeUVReflectionMapping
    || texture.name !== 'PMREM.cubeUv') throw new RangeError(UNKNOWN_ENVIRONMENT_MESSAGE);
}
