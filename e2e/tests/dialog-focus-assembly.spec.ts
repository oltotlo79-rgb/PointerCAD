import { test } from '@playwright/test';
import { registerDialogFocusAssemblyTests } from './dialogFocusAssemblyFlow.js';

registerDialogFocusAssemblyTests(test);
