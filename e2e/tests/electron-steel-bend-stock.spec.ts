import { createElectronAppFixture } from './electronAppFixture.js';
import { registerSteelBendStockTest } from './steelBendStockFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerSteelBendStockTest(test, (page) => applicationFor(page));
