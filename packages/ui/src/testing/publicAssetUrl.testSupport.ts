import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const resolve = createRequire(import.meta.url).resolve;

/** Node test asset loading follows the package exports table, with no relative source fallback. */
export function publicAssetUrl(specifier: string): URL {
  if (!specifier.startsWith('@pointercad/') || /[?#]/u.test(specifier)) {
    throw new Error('Use an explicit package asset without a query');
  }
  return pathToFileURL(resolve(specifier));
}
