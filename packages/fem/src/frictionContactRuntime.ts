import { sha256Hex } from './sha256.js';
import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { translateBeamFrictionContact } from './frictionContactTranslation.js';
import { decodeFrictionContact, type FrictionContactResult, type FrictionSolveOptions } from './frictionContactResults.js';

function solveOptions(value: FrictionSolveOptions): FrictionSolveOptions {
  if (value === null || typeof value !== 'object'
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== 2) throw new Error('friction-options: explicit solver and iterationLimit required');
  const solver = Object.getOwnPropertyDescriptor(value, 'solver');
  const limit = Object.getOwnPropertyDescriptor(value, 'iterationLimit');
  if (solver === undefined || limit === undefined || !solver.enumerable || !limit.enumerable
    || !('value' in solver) || !('value' in limit)) throw new Error('friction-options: invalid fields');
  const selectedSolver: unknown = solver.value, iterationLimit: unknown = limit.value;
  if ((selectedSolver !== 'newton' && selectedSolver !== 'nsgs') || typeof iterationLimit !== 'number'
    || !Number.isSafeInteger(iterationLimit) || iterationLimit < 1) throw new Error('friction-options: invalid solver or iterationLimit');
  return { solver: selectedSolver, iterationLimit };
}

/** Explicit integrity-admitted developer bytes only; no asset loader, fallback or Worker registration.
 * Compile the three fixed source files afresh in dependency order: sys.modules and an old .pyc must not
 * substitute a program from a previous analysis. This does not interpolate user data into Python. */
export async function analyzeBeamFrictionContact(runtime: PyodideRuntime, input: unknown, programs: {
  readonly contactWrapper: Uint8Array; readonly coreWrapper: Uint8Array; readonly runtimeWrapper: Uint8Array;
  readonly wheelLocation: string;
}, options: FrictionSolveOptions, onPhase: (phase: FemPhase) => void): Promise<FrictionContactResult> {
  const prepared = translateBeamFrictionContact(input), ownedOptions = solveOptions(options);
  if (!(programs.contactWrapper instanceof Uint8Array) || !(programs.coreWrapper instanceof Uint8Array)
    || !(programs.runtimeWrapper instanceof Uint8Array) || programs.contactWrapper.byteLength === 0
    || programs.coreWrapper.byteLength === 0 || programs.runtimeWrapper.byteLength === 0
    || typeof programs.wheelLocation !== 'string' || programs.wheelLocation.length === 0) throw new Error('friction-programs: explicit admitted bytes and wheel required');
  const contactWrapper = new Uint8Array(programs.contactWrapper), coreWrapper = new Uint8Array(programs.coreWrapper);
  const runtimeWrapper = new Uint8Array(programs.runtimeWrapper), wheelLocation = programs.wheelLocation;
  const json = JSON.stringify({ plan: prepared.plan, friction: prepared.friction, loads: prepared.loads,
    solver: ownedOptions.solver, max_iterations: ownedOptions.iterationLimit });
  const digestBytes = new TextEncoder().encode(JSON.stringify(prepared.input));
  const hash = await sha256Hex(digestBytes);
  onPhase('loading-packages');
  await runtime.loadPackage(wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/friction-contact-input.json', json);
  runtime.FS.writeFile('/pcad_fem/beamContact.py', contactWrapper);
  runtime.FS.writeFile('/pcad_fem/beamFrictionContact.py', coreWrapper);
  runtime.FS.writeFile('/pcad_fem/beamFrictionRuntime.py', runtimeWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import json
import sys
import types
sys.path.insert(0, '/pcad_fem')
for _name in ('beamContact', 'beamFrictionContact', 'beamFrictionRuntime'):
    _path = '/pcad_fem/' + _name + '.py'
    _module = types.ModuleType(_name)
    _module.__file__ = _path
    _module.__package__ = ''
    sys.modules[_name] = _module
    with open(_path, encoding='utf-8') as _source:
        exec(compile(_source.read(), _path, 'exec'), _module.__dict__)
from beamFrictionRuntime import run_beam_friction_contact
with open('/pcad_fem/friction-contact-input.json', encoding='utf-8') as _stream:
    _job = json.load(_stream)
run_beam_friction_contact(_job['plan'], _job['friction'], _job['loads'], solver=_job['solver'], max_iterations=_job['max_iterations'])
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000
    || new TextEncoder().encode(encoded).byteLength > 4_000_000) throw new Error('Invalid bounded friction-contact response');
  const raw: unknown = JSON.parse(encoded);
  return decodeFrictionContact(raw, prepared.input, hash, ownedOptions);
}

export { solveOptions as readFrictionSolveOptions };
