import { createSubShapeReference, type SolidBody, type SubShapeOrigin, type SubShapeRef } from '@pointercad/model';
import { readShellCadAnalysisInput, solidCadFaceKey } from '@pointercad/model/beam-analysis';
import { CadShellAnalysisRefusal, type CadShellSettings } from './cadShellAnalysis.js';
import type { CadTetraContext } from './cadTetraMesh.js';

function canonical(value: SubShapeOrigin): string {
  return JSON.stringify(value, (_key: string, row: unknown): unknown => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

/** Enumerate current topology; only the model's origin-proof constructor can produce a candidate. */
function uniqueReference(body: SolidBody, origin: SubShapeOrigin, code: 'support-unresolved' | 'load-unresolved'): SubShapeRef {
  const list = origin.shapeKind === 'edge' ? body.edges : origin.shapeKind === 'vertex' ? body.vertices : body.faces;
  const wanted = canonical(origin);
  const matches = list.flatMap(item => {
    const reference = createSubShapeReference(body, origin.shapeKind, item.index);
    return reference?.origin !== undefined && canonical(reference.origin) === wanted ? [reference] : [];
  });
  if (matches.length !== 1) throw new CadShellAnalysisRefusal(code, 'Saved origin is missing or ambiguous on the current body');
  return matches[0];
}

/** Bind saved semantic origins to current topology; no old topology indices or near-coordinate fallback. */
export function resolveSavedCadShellSettings(context: CadTetraContext, value: unknown): CadShellSettings {
  let saved: ReturnType<typeof readShellCadAnalysisInput>;
  try { saved = readShellCadAnalysisInput(value); }
  catch (error) { throw new CadShellAnalysisRefusal('invalid-settings', error instanceof Error ? error.message : String(error)); }
  const body = context.body;
  if (saved.source.documentId !== context.documentId || saved.geometry.bodyFeatureId !== body.featureId || !body.isValid
    || body.bodyKind !== 'shell') throw new CadShellAnalysisRefusal('invalid-settings', 'Saved shell owner or current shell body does not match');
  const currentFaces = body.faces.flatMap(face => {
    const reference = createSubShapeReference(body, 'face', face.index);
    return reference === null ? [] : [solidCadFaceKey(reference)];
  });
  for (const face of saved.geometry.midsurfaceFaces) {
    if (currentFaces.filter(key => key === face).length !== 1)
      throw new CadShellAnalysisRefusal('midsurface-unresolved', 'Saved midsurface origin is missing or ambiguous on the current body');
  }
  const supports: CadShellSettings['supports'] = saved.supports.map(support => {
    const reference = uniqueReference(body, support.origin, 'support-unresolved');
    return support.kind === 'edge' ? { kind: 'edge', edge: reference, fixed: support.fixed }
      : { kind: 'vertex', vertex: reference, fixed: support.fixed };
  });
  const edgeLoads = saved.edgeLoads.map(load => ({ edge: uniqueReference(body, load.origin, 'load-unresolved'),
    forceNPerMm: load.forceNPerMm, momentNmmPerMm: load.momentNmmPerMm }));
  return { saved: saved.geometry, material: { id: saved.material.id, youngMPa: saved.material.youngMPa,
    poisson: saved.material.poisson }, supports, edgeLoads, surface: saved.surface };
}
