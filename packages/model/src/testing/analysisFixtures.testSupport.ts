/** Shared analysis fixtures for tests; never part of the product barrel. */
export { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from '../analysis/beamInputs.testSupport.js';
export { bucklingCadFixture } from '../analysis/beamBuckling.testSupport.js';
export { cadJointContactFixture } from '../analysis/cadJointContact.testSupport.js';
export { cadWeldSpanFixture } from '../analysis/cadWeldSpanLayer.testSupport.js';
export { weldTestBody } from '../assembly/welding/filletWeld.testSupport.js';
export { densityGPerCm3ToKgM3, findDensityMaterial } from '../appearance/densityMaterials.js';
export { cadAxialBoltFixture } from '../analysis/cadAxialBolt.testSupport.js';
export { savedBoltFixture } from '../analysis/cadNativeBoltPreloadInput.testSupport.js';
export { cadWeldLayerFixture } from '../analysis/cadWeldLayer.testSupport.js';
