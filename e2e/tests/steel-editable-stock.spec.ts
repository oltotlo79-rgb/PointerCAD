import { test } from '@playwright/test';
import { registerSteelEditableStockTests, registerSteelUiAcceptanceTests } from './steelEditableStockFlow.js';

registerSteelEditableStockTests(test);

registerSteelUiAcceptanceTests(test);
