import { test } from '@playwright/test';
import { registerFilletWeldAcceptTests } from './filletWeldAcceptFlow.js';
import { registerFilletWeldTests } from './filletWeldFlow.js';

registerFilletWeldTests(test);
registerFilletWeldAcceptTests(test);
