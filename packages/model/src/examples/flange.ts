import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid } from '../part/createPartDocument.js';
import type { ChamferFeature, PartDocument, RevolveFeature } from '../part/types.js';
import { drillTop, rectangularProfile, solidIdentity } from './exampleGeometry.js';
import type { PartExample } from './partExample.js';

const radius = 40;
const height = 20;
const boreRadius = 12;
const boltRadius = 4;
const boltCount = 4;
const chamfer = 1;
const diskArea = Math.PI * radius ** 2;

function createFlange(): PartDocument {
  const { part, profile } = rectangularProfile('xz', [0, 0, 0], [radius, 0, height]);
  const disk: RevolveFeature = {
    ...solidIdentity(part, 'revolve'), kind: 'revolve', profile,
    axis: { kind: 'world', axis: 'z' }, angle: expressionValueFromNumber(360), reversed: false,
  };
  const turned = appendSolid(part, disk);
  // The first radial segment at z=0 sweeps the bottom disk. Its rim is a full circle.
  const rim: ChamferFeature = {
    ...solidIdentity(turned, 'chamfer'), kind: 'chamfer', targetFeatureId: disk.id,
    targets: [{ bodyFeatureId: disk.id, index: 0, fingerprint: {
      kind: 'edge', curveKind: 'circle', length: 2 * Math.PI * radius,
      position: [0, 0, 0], axis: [0, 0, 1], radius,
    } }],
    size: { kind: 'equal', distance: expressionValueFromNumber(chamfer) }, swapReferenceFace: false,
  };
  const bored = drillTop(appendSolid(turned, rim), {
    targetId: rim.id, faceIndex: 3, height, faceArea: diskArea, centerX: 0, diameter: 2 * boreRadius,
  });
  const seed = drillTop(bored.part, {
    targetId: bored.holeId, faceIndex: 4, height, faceArea: diskArea - Math.PI * boreRadius ** 2,
    centerX: 28, diameter: 2 * boltRadius,
  });
  return appendSolid(seed.part, {
    ...solidIdentity(seed.part, 'circularPattern'), kind: 'pattern', sourceFeatureId: seed.holeId,
    placement: { kind: 'circular', axis: { kind: 'world', axis: 'z' }, fullCircle: true,
      angle: expressionValueFromNumber(360), count: expressionValueFromNumber(boltCount) },
  });
}

export const flangeExample: PartExample = { id: 'flange', create: createFlange };
