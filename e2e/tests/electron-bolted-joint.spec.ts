import { createElectronAppFixture } from './electronAppFixture.js';
import { registerBoltedJointAcceptTests } from './boltedJointAcceptFlow.js';
import { registerBoltedJointTests } from './boltedJointFlow.js';
import { registerBoltedJointMultiTests } from './boltedJointMultiFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerBoltedJointTests(test, (page) => applicationFor(page));
registerBoltedJointAcceptTests(test, (page) => applicationFor(page));
registerBoltedJointMultiTests(test, (page) => applicationFor(page));
