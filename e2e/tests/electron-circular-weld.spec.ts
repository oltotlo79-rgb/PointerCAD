import { createElectronAppFixture } from './electronAppFixture.js';
import { registerCircularWeldTests } from './circularWeldFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerCircularWeldTests(test, page => applicationFor(page));
