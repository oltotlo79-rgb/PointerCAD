import { startApplicationWithSplash } from '@pointercad/ui/startup-presentation';

// The static HTML remains usable even if this small entry itself cannot be fetched.
void startApplicationWithSplash(() => import('./main.js'));
