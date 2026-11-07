import { test } from '@playwright/test';
import { registerSteelEditableStockTests, registerSteelUiAcceptanceTests } from './steelEditableStockFlow.js';
import { registerSteelStockCsvTests } from './steelStockCsvFlow.js';

registerSteelEditableStockTests(test);

registerSteelUiAcceptanceTests(test);

registerSteelStockCsvTests(test);
