import { test } from '@playwright/test';
import { registerFramePanelTests } from './framePanelFlow.js';

registerFramePanelTests(test);
