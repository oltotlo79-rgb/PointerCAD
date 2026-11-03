import { createElectronAppFixture } from './electronAppFixture.js';
import { registerFilletWeldAcceptTests } from './filletWeldAcceptFlow.js';
import { registerFilletWeldTests } from './filletWeldFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerFilletWeldTests(test, (page) => applicationFor(page));
registerFilletWeldAcceptTests(test, (page) => applicationFor(page));
