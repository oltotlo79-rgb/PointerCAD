import { test } from '@playwright/test';
import { registerDialogFocusTests } from './dialogFocusFlow.js';

registerDialogFocusTests(test);
