/**
 * The application version for the user interface, from the root package.json only (never a literal).
 * The Web build, the desktop renderer build and the ui unit-test configuration use this one define,
 * so every place that compiles the ui sees the same name and the same value.
 */
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const ROOT_MANIFEST = new URL('../../package.json', import.meta.url);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Read the root package.json version and fail the build if it is missing or not a semantic version. */
function rootAppVersion(manifestUrl) {
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const version = manifest !== null && typeof manifest === 'object' ? manifest.version : undefined;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error('The root package.json version must be a semantic version');
  }
  return version;
}

/** The Vite define entry. Workers inherit define, so their bundles see the same value. */
export function appVersionDefine(manifestUrl = ROOT_MANIFEST) {
  return { __PCAD_APP_VERSION__: JSON.stringify(rootAppVersion(manifestUrl)) };
}
