import type { FemPhase } from './protocol.js';
import type { PyodideRuntime } from './runtime.js';
import { SOLID_CONTACT_ASSETS } from './solidContactAssets.js';
import { decodeSolidContactResult, readSolidContactFailureDiagnostics, verifySolidContactInput,
  type SolidContactFailureDiagnostics, type SolidContactInput, type SolidContactResult } from './solidContactBinding.js';
import { sha256Hex } from './sha256.js';
import { isRecord } from './valueGuards.js';

export interface SolidContactPrograms {
  readonly normal: Uint8Array;
  readonly friction: Uint8Array;
  readonly solver: Uint8Array;
  readonly driver: Uint8Array;
  readonly wheelLocation: string;
}
export class SolidContactRuntimeError extends Error {
  constructor(readonly contactDiagnostics: SolidContactFailureDiagnostics) {
    super(contactDiagnostics.reason);
    this.name = 'SolidContactRuntimeError';
  }
}

/** Native execution accepts only pinned developer programs and owned JSON.
 * The caller owns a one-shot interpreter; cancellation terminates that Worker. */
export async function analyzeSolidContact(runtime: PyodideRuntime, value: SolidContactInput,
  programs: SolidContactPrograms, onPhase: (phase: FemPhase) => void): Promise<SolidContactResult> {
  const input = await verifySolidContactInput(value);
  const sources = [programs.normal.slice(), programs.friction.slice(), programs.solver.slice(), programs.driver.slice()];
  for (const [index, pin] of SOLID_CONTACT_ASSETS.entries()) {
    const bytes = sources[index];
    if (bytes.byteLength !== pin.bytes || await sha256Hex(bytes) !== pin.sha256) {
      throw new Error(`asset-corrupt: ${pin.file}`);
    }
  }
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  for (const [index, pin] of SOLID_CONTACT_ASSETS.entries()) runtime.FS.writeFile(`/pcad_fem/${pin.file}`, sources[index]);
  runtime.FS.writeFile('/pcad_fem/solid-contact-input.json', JSON.stringify(input));
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from solidContactDriver import run_from_file
run_from_file('/pcad_fem/solid-contact-input.json', '/pcad_fem/solid-contact')
`);
  if (typeof encoded !== 'string' || encoded.length > 64_000_000) throw new Error('Invalid bounded contact response');
  const decoded: unknown = JSON.parse(encoded);
  if (!isRecord(decoded) || Object.keys(decoded).length !== 2) throw new Error('Invalid contact response envelope');
  if (decoded.success === false) {
    const diagnostics = readSolidContactFailureDiagnostics(decoded.diagnostic);
    const actualInputHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(input)));
    if (diagnostics.inputSha256 !== actualInputHash || diagnostics.preparationSha256 !== input.preparationSha256
      || JSON.stringify(diagnostics.source) !== JSON.stringify(input.source) || diagnostics.iterationLimit !== input.maxIterations) {
      throw new Error('Contact failure belongs to a different input');
    }
    throw new SolidContactRuntimeError(diagnostics);
  }
  if (decoded.success !== true) throw new Error('Missing complete native contact history');
  return decodeSolidContactResult(decoded.result, input);
}
