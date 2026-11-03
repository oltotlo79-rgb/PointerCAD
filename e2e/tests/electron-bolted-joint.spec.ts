import { createElectronAppFixture } from './electronAppFixture.js';
import { registerBoltedJointAcceptTests } from './boltedJointAcceptFlow.js';
import { registerBoltedJointTests } from './boltedJointFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerBoltedJointTests(test, (page) => applicationFor(page));
registerBoltedJointAcceptTests(test, (page) => applicationFor(page));
