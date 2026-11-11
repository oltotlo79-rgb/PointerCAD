import { test } from '@playwright/test';
import { registerBoltedJointAcceptTests } from './boltedJointAcceptFlow.js';
import { registerBoltedJointTests } from './boltedJointFlow.js';

registerBoltedJointTests(test);
registerBoltedJointAcceptTests(test);
