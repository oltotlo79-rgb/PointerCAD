import { createElectronAppFixture } from './electronAppFixture.js';
import { registerBoltedJointTappedTests } from './boltedJointTappedFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerBoltedJointTappedTests(test, (page) => applicationFor(page));
