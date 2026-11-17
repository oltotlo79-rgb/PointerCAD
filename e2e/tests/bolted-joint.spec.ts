import { test } from '@playwright/test';
import { registerBoltedJointAcceptTests } from './boltedJointAcceptFlow.js';
import { registerBoltedJointTests } from './boltedJointFlow.js';
import { registerBoltedJointMultiTests } from './boltedJointMultiFlow.js';

registerBoltedJointTests(test);
registerBoltedJointAcceptTests(test);
registerBoltedJointMultiTests(test);
