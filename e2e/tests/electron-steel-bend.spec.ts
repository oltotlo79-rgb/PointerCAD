import { createElectronAppFixture } from './electronAppFixture.js';
import { registerSteelBendTest } from './steelBendFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerSteelBendTest(test, (page) => applicationFor(page));
