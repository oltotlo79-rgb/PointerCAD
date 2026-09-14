/** 内部の実形状複製だけへ渡す、完了した三角形分割の条件。通信・保存形式へは出さない。 */
import { DEFAULT_ANGULAR_DEFLECTION, DEFAULT_LINEAR_DEFLECTION, type TessellationOptions } from '../types.js';
import type { SurfaceMesh } from './tessellate.js';

export interface KnownTriangulation {
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  readonly mesherDone: boolean;
  readonly mesherStatus: number;
}

export function rememberTriangulation(surface: SurfaceMesh, options: TessellationOptions): KnownTriangulation | undefined {
  if (!surface.mesherDone || surface.mesherStatus !== 0 || surface.faceCount === 0 || surface.missingTriangulationFaces !== 0) return undefined;
  const linearDeflection = options.linearDeflection ?? DEFAULT_LINEAR_DEFLECTION;
  const angularDeflection = options.angularDeflection ?? DEFAULT_ANGULAR_DEFLECTION;
  if (!Number.isFinite(linearDeflection) || linearDeflection <= 0 || !Number.isFinite(angularDeflection) || angularDeflection <= 0) return undefined;
  return { linearDeflection, angularDeflection, mesherDone: surface.mesherDone, mesherStatus: surface.mesherStatus };
}

export function matchesTriangulation(known: KnownTriangulation | undefined, linear: number, angular: number): known is KnownTriangulation {
  return known !== undefined && known.mesherDone && known.mesherStatus === 0
    && known.linearDeflection === linear && known.angularDeflection === angular;
}
