import { createElectronAppFixture } from './electronAppFixture.js';
import { registerFrameSlotFasteningTests } from './frameSlotFasteningFlow.js';

const { test, applicationFor } = createElectronAppFixture();

registerFrameSlotFasteningTests(test, (page) => applicationFor(page));
