/** Explicit fixtures used by UI tests; kept outside the product barrel. */
export {
  WELDED_CHILD_REF,
  childOwnedWeldFixture,
} from '../analysis/cadWeldLayerChildOwned.testSupport.js';
export {
  nestedWeldFixture,
} from '../analysis/cadWeldLayerNested.testSupport.js';
export {
  type CircularWeldContactRequest,
} from '../assembly/welding/circularWeldContact.js';
export {
  weldTestBox,
  weldTestPlacement,
} from '../assembly/welding/filletWeld.testSupport.js';
export {
  buildEx18ExpressionBracket,
  buildEx18ExpressionFlange,
  buildEx18ExpressionOblique,
  buildEx18ExtrudedOblique,
  buildEx18RevolvedFlange,
  buildEx18RuledFlange,
  buildEx18SewnBracket,
  buildEx18SewnOblique,
  buildEx18SketchBracket,
  editEx18ExpressionDiameter,
  editEx18FlangeBore,
  editEx18ObliqueDepth,
  editEx18RevolvedFlangeRadius,
  editEx18SewnDiameter,
  editEx18SketchHoleDiameter,
  moveEx18ExpressionHole,
  routeExpression,
} from '../part/ex18RouteBuilders.testSupport.js';
export {
  appendEx18DirectEdit,
  buildEx18DirectSeed,
  directFaceReference,
  directPlanarFace,
  withEx18UnselectedBody,
} from '../part/ex18RouteBuildersDirect.testSupport.js';
export {
  ReferenceMeshScope,
} from '../part/readReferenceBodies.js';
export {
  CONNECTED_1000_FIXTURE_SHA256,
  CONNECTED_1000_POINT_COUNT,
  connected1000FixtureText,
  connected1000Original,
  connected1000PointId,
  connected1000Sketch,
} from '../sketch/constraints/connected1000Fixture.testSupport.js';

export { buildStandardPartFromSourceWithReason } from '../assembly/standard/buildStandardPart.js';
export { steelMessageRejectionSourcesForUi } from '../assembly/standard/steelRejection.testSupport.js';

export { zDegrees } from '../assembly/joints/jointAngles.testSupport.js';

export { placement } from '../assembly/fastening/boltedPlacement.testSupport.js';

export { finalMeshJsAccounting } from '@pointercad/kernel/testing/shape-cache';
export { readMeshJsFinalAccounting } from '../kernelBridge/solidConversions.js';
