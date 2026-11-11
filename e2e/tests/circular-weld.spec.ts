import { test } from '@playwright/test';
import { registerCircularWeldTests } from './circularWeldFlow.js';

registerCircularWeldTests(test);
