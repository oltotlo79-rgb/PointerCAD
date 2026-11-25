import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const LEGACY_GLUE_SHA256 = '81cf6d926fefd75a700bd59f518750ff265ba7275886a25397505184f371f946';
const LEGACY_WASM_SHA256 = '0839d9bcc8ac4677e346dee92c7b428b91ea9c646110fcdeee8a8701424472a7';
const resolveInstalled = createRequire(import.meta.url).resolve;

function materializationPath(): string {
  return join(dirname(resolveInstalled('opencascade.js/package.json')), 'materialization.json');
}

/** Absence of IGES is valid only with the unchanged, pre-IGES package. */
export function isLegacyIgesKernel(): boolean {
  if (existsSync(materializationPath())) return false;
  const glue = readFileSync(resolveInstalled('opencascade.js/dist/opencascade.full.js'));
  const wasm = readFileSync(resolveInstalled('opencascade.js/dist/opencascade.full.wasm'));
  return createHash('sha256').update(glue).digest('hex') === LEGACY_GLUE_SHA256
    && createHash('sha256').update(wasm).digest('hex') === LEGACY_WASM_SHA256;
}

/** Expected full glue hash from the adopted hosted materialization, or the exact legacy hash. */
export function installedGlueFingerprint(): string {
  const path = materializationPath();
  if (!existsSync(path)) return LEGACY_GLUE_SHA256;
  const receipt: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (receipt !== null && typeof receipt === 'object' && 'vendor' in receipt) {
    const vendor = receipt.vendor;
    if (vendor !== null && typeof vendor === 'object' && 'opencascade.full.js' in vendor) {
      const glue = vendor['opencascade.full.js'];
      if (glue !== null && typeof glue === 'object' && 'sha256' in glue
        && typeof glue.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(glue.sha256)) return glue.sha256;
    }
  }
  throw new Error('Missing full glue fingerprint in the installed OCCT materialization');
}
