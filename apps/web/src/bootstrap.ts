import { startApplicationWithSplash } from '../../../packages/ui/src/shell/startupPresentation.js';

// The static HTML remains usable even if this small entry itself cannot be fetched.
void startApplicationWithSplash(() => import('./main.js'));
