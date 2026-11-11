/** Explicit fixtures used by UI tests; kept outside the product barrel. */
export {
  jointTestInput,
  jointTestRaw,
} from '../beamJointContact.testSupport.js';
export {
  initialStrainTestInput,
  initialStrainTestRaw,
} from '../beamJointInitialStrain.testSupport.js';
export {
  context,
  finiteSettings,
  kernel,
  ownedClient,
} from '../cadSolidFinite.testSupport.js';
export {
  modalFixture,
} from '../modal.testSupport.js';
export {
  prepareNativeBoltPreload,
} from '../nativeBoltPreload.js';
export {
  NATIVE_BOLT_KIND,
  decodeNativeBoltPreloadOwned,
} from '../nativeBoltPreloadBinding.js';
