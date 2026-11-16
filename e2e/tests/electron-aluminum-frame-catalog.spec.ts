import { registerAluminumFrameCatalogTests } from './aluminumFrameCatalogFlow.js';
import { createElectronAppFixture } from './electronAppFixture.js';

const { test, applicationFor } = createElectronAppFixture();

registerAluminumFrameCatalogTests(test, (page) => applicationFor(page));
