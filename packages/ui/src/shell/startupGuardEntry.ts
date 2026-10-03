import { browserStartupGuardHost, installStartupGuard } from './startupGuard.js';

// Built as its own import-free chunk and placed before the startup entry (scripts/vite/startupGuard.mjs).
installStartupGuard(browserStartupGuardHost(window));
