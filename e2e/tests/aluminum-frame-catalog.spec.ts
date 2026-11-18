import { test } from '@playwright/test';
import { registerAluminumFrameCatalogTests } from './aluminumFrameCatalogFlow.js';
import { registerFrameScribeMarksTests } from './frameScribeMarksFlow.js';
import { registerFrameSplitMergeTests } from './frameSplitMergeFlow.js';
import { registerFrameStrokeTests } from './frameStrokeFlow.js';
import { registerSafetyFenceTests } from './safetyFenceFlow.js';

registerAluminumFrameCatalogTests(test);
registerFrameStrokeTests(test);
registerFrameSplitMergeTests(test);
registerFrameScribeMarksTests(test);
registerSafetyFenceTests(test);
