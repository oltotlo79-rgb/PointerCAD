import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import {
  absoluteCoordinate, appendSolid, createPrimitiveFeature, createDirectKernelBridge,
  createSubShapeReference, recomputePart, resolveSubShapeReference, type PartDocument,
} from '../../packages/model/src/index.js';
import { AMBIGUITY_BODY_ID, buildReferenceAmbiguityScenario, type ReferenceAmbiguityScenario } from './referenceAmbiguityFixture.js';

/** Same U dimensions and legacy ambiguous saved reference, with native Box/union lineage. */
export async function referenceRepairAppearanceFixture() {
  const original = await buildReferenceAmbiguityScenario();
  let part: PartDocument = { ...original.part, solids: original.part.solids.filter(solid => solid.id !== AMBIGUITY_BODY_ID) };
  const box = (id: string, x: number, y: number, width: number, height: number) => {
    const primitive = createPrimitiveFeature(part, 'box', { kind: 'coordinate', value: absoluteCoordinate(x, y, 150) });
    const feature = { ...primitive, id, name: id,
      shape: { kind: 'box' as const, sizeX: number(width), sizeY: number(height), sizeZ: number(300) } };
    part = appendSolid(part, feature);
  };
  box('repair-base', 50, 5, 100, 10);
  box('repair-short-arm', 5, 25, 10, 30);
  box('repair-long-arm', 80, 25, 40, 30);
  part = appendSolid(part, { id: 'repair-first-union', name: '修復用の結合', kind: 'boolean', operation: 'union',
    suppressed: false, targetFeatureId: 'repair-base', toolFeatureId: 'repair-short-arm' });
  part = appendSolid(part, { id: AMBIGUITY_BODY_ID, name: 'U字の柱', kind: 'boolean', operation: 'union',
    suppressed: false, targetFeatureId: 'repair-first-union', toolFeatureId: 'repair-long-arm' });
  const api = createKernelApi(loadOcctForNode), partId = 'r17-appearance-semantic-u';
  try {
    const result = await recomputePart(part, createDirectKernelBridge(api), { partId, generation: 1 });
    if (result.cancelled || result.errors.length !== 0) throw new Error(`OCCT appearance: ${JSON.stringify(result.errors)}`);
    const bodies = result.bodies.filter(body => body.featureId === AMBIGUITY_BODY_ID);
    const body = bodies[0];
    if (bodies.length !== 1 || body === undefined || !body.isValid || body.origins?.state !== 'tracked') {
      throw new Error('Actual Box/union maker did not issue native origins');
    }
    // Independent dimensions/normal select the narrow arm, never candidate order or UI text.
    const faces = body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
      && Math.abs(face.axis[1] - 1) < 1e-6 && Math.abs(face.centroid[1] - 40) < 1e-6
      && Math.abs(face.area - 3000) < 1e-6);
    const face = faces[0];
    if (faces.length !== 1 || face === undefined) throw new Error('Independent narrow arm face missing');
    const chosen = createSubShapeReference(body, 'face', face.index);
    if (chosen === null || chosen.origin === undefined || chosen.fingerprint.kind !== 'face'
      || resolveSubShapeReference(body, chosen).status !== 'matched') throw new Error('Native semantic repair face missing');
    for (const [reference, status] of [[original.refs.ambiguousFace, 'ambiguous'],
      [original.refs.missingFace, 'missing'], [original.refs.uniqueFace, 'matched']] as const) {
      const resolution = resolveSubShapeReference(body, reference);
      if (resolution.status !== status) throw new Error(`Original saved face: expected ${status}, actual ${resolution.status}`);
      if (status === 'ambiguous' && (resolution.candidates.length < 2
        || !resolution.candidates.some(candidate => candidate.reference.index === chosen.index))) {
        throw new Error('Original ambiguous reference lost its multiple candidates or independent choice');
      }
    }
    const scenario: ReferenceAmbiguityScenario = { ...original, part, body };
    return { scenario, chosen };
  } finally { await api.releasePart(partId); }
}
