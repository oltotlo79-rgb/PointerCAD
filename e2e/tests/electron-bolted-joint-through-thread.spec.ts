import { createElectronAppFixture } from './electronAppFixture.js';
import { registerBoltedJointThroughThreadTests } from './boltedJointThroughThreadFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerBoltedJointThroughThreadTests(test, (page) => applicationFor(page));
