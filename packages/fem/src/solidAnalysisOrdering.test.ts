import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLID_ASSETS } from './assets.js';
import { analyzeSolid, isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';
import { solidResultMatches } from './solidAnalysisResults.js';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';

const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
let runtime: PyodideRuntime;
let deniedRequests = 0;
const originalFetch = globalThis.fetch;
function verified(name: string): Uint8Array {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
    || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Missing manifest');
  const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error('Missing asset pin');
  const bytes = new Uint8Array(readFileSync(join(assets, name)));
  expect({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    .toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
  return bytes;
}
function pythonChecks(source: string): void {
  const value = runtime.runPython(source);
  if (typeof value !== 'string') throw new Error('Expected JSON check result');
  const result: unknown = JSON.parse(value);
  expect(result).toEqual({ checks: 'passed' });
}
beforeAll(async () => {
  globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) verified(name);
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged loader');
  const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
    lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
    packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged runtime');
  runtime = loaded;
  const wrapper = verified('solidAnalysis.py');
  expect(SOLID_ASSETS).toEqual([{ file: 'solidAnalysis.py', bytes: wrapper.byteLength,
    sha256: createHash('sha256').update(wrapper).digest('hex') }]);
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/solid_analysis.py', wrapper);
  await runtime.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
  runtime.runPython("import sys\nsys.path.insert(0, '/pcad_fem')\nimport solid_analysis as ordering\n");
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = originalFetch; });

describe('shipped solid node ordering contract', () => {
  it('keeps isolated and disconnected identities, per-axis restraints, loads and local vertex order', () => {
    pythonChecks(`
import json
# Two interleaved K4 components and isolated node8. Each K4 degree3;
# the isolated root comes first, then reverse ascending BFS within each K4.
p = {'input': {'nodes': [[i, i+10, i+20] for i in range(9)],
    'elements': [{'nodes': [0,2,4,6], 'materialId':'m'}, {'nodes':[1,3,5,7], 'materialId':'m'}],
    'materials':[{'id':'m','youngMPa':210000,'poisson':0}],
    'nodalLoads':[], 'surfaceLoads':[]},
    'fixed': [[False,False,False] for _ in range(8)] + [[True,True,True]],
    'forcesN': [[i,-i,2*i] for i in range(9)]}
order, inverse = ordering._node_order(p)
assert order == [8,6,4,2,0,7,5,3,1]
assert inverse == [5,9,4,8,3,7,2,6,1]
assert sorted(order) == list(range(9))
assert all(order[inverse[i]-1] == i for i in range(9))
# Add mixed-axis restraints AFTER the graph expectation, independently checking
# every returned deck row rather than assuming a second traversal's order.
p['fixed'][2] = [True,False,True]
p['fixed'][5] = [False,True,False]
order,inverse = ordering._node_order(p)
deck = ordering._deck(p,order,inverse)
nodes, cells = {}, []
for line in deck.splitlines():
    t=line.split()
    if t and t[0]=='node': nodes[int(t[1])]=([float(x) for x in t[4:7]], [bool(int(x)) for x in t[9:12]])
    if t and t[0]=='ltrspace': cells.append([int(x) for x in t[4:8]])
for i,num in enumerate(inverse): assert nodes[num] == (p['input']['nodes'][i],p['fixed'][i])
for e,cell in zip(p['input']['elements'],cells,strict=True):
    assert [order[num-1] for num in cell] == e['nodes']
native_forces = [p['forcesN'][original] for original in order]
assert [native_forces[inverse[i]-1] for i in range(9)] == p['forcesN']
bad=inverse[:];bad[0],bad[1]=bad[1],bad[0]
assert any(nodes[bad[i]][0] != p['input']['nodes'][i] for i in range(9))
badcell=cells[0][:];badcell[0],badcell[1]=badcell[1],badcell[0]
assert [order[num-1] for num in badcell] != p['input']['elements'][0]['nodes']
json.dumps({'checks':'passed'})
`);
  });
  it('retains natural order when the complete tetrahedron profile is equal or every DOF is fixed', () => {
    pythonChecks(`
import json
p={'input':{'nodes':[[i,0,0] for i in range(4)],'elements':[{'nodes':[0,1,2,3]}]},'fixed':[[False]*3 for _ in range(4)]}
# Complete 12-DOF graph has column heights1..12 in any order: 78+one sentinel.
assert sum(range(1,13))+1 == 79
assert ordering._node_order(p) == ([0,1,2,3],[1,2,3,4])
p['fixed']=[[True]*3 for _ in range(4)]
assert ordering._node_order(p) == ([0,1,2,3],[1,2,3,4])
# Seven-node graph degrees [3,3,3,6,6,4,3]. Starting at node0 gives
# ascending BFS [0,1,3,4,2,6,5], reverse [5,6,2,4,3,1,0].
# Independent column heights below come from each tet's complete DOF clique,
# not from _node_order/profile. One extra number is the skyline sentinel.
natural_heights=[1,2,3,4,5,6,1,2,3,10,11,12,13,14,15,10,11,12,10,11,12]
reverse_heights=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,8,9,10,11,12]
assert 1+sum(natural_heights)==169 < 178==1+sum(reverse_heights)
p={'input':{'nodes':[[i,0,0] for i in range(7)],'elements':[
    {'nodes':[0,1,3,4]},{'nodes':[2,3,4,5]},{'nodes':[3,4,5,6]}]},
    'fixed':[[False]*3 for _ in range(7)]}
assert ordering._node_order(p) == (list(range(7)),list(range(1,8)))
json.dumps({'checks':'passed'})
`);
  });
  it('refuses workspace below its exact boundary before native model or global matrix allocation', () => {
    pythonChecks(`
import json, oofem
p={'schema':'pointercad-solid-tet4-plan/1', 'input':{'schema':'pointercad-solid-tet4/1','units':'N-mm-MPa',
    'nodes':[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],
    'elements':[{'nodes':[0,1,2,3],'materialId':'m'}],
    'materials':[{'id':'m','youngMPa':210000,'poisson':0}], 'nodalLoads':[], 'surfaceLoads':[]},
    'forcesN':[[0,0,0] for _ in range(4)],'fixed':[[True]*3 for _ in range(4)]}
# Four nodes, one tet, one material, no loads: independently counted payload.
B=4*96+96+12+4096
workspace=8*(B+12+4*32)
calls=[]
old=oofem.InstanciateProblem
class ReachedModel(Exception): pass
def forbidden(*a,**kw): calls.append('model'); raise ReachedModel()
oofem.InstanciateProblem=forbidden
try:
    for budget, message in [(8*B-1,'input/native/result'),(workspace-1,'node ordering workspace')]:
        p['input']['numericBudgetBytes']=budget
        with open('/pcad_fem/solid-input.json','w') as f:json.dump(p,f)
        try: ordering.run_solid_analysis(); raise AssertionError('budget accepted')
        except ValueError as e: assert message in str(e)
        assert calls == []
    p['input']['numericBudgetBytes']=workspace
    with open('/pcad_fem/solid-input.json','w') as f:json.dump(p,f)
    try: ordering.run_solid_analysis(); raise AssertionError('missing model marker')
    except ReachedModel: pass
    assert calls == ['model']
finally: oofem.InstanciateProblem=old
json.dumps({'checks':'passed'})
`);
  });
  it('solves one relabelled unit-tet by the independent E L/6 stiffness and restores original result identity', async () => {
    const length = 2, young = 120000, force = 3;
    const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1',
      source: { documentId: 'ordering-closed-form', revision: 1, meshKey: 'one-tet' }, units: 'N-mm-MPa',
      numericBudgetBytes: 128 * 1024 * 1024,
      nodes: [[0, length, 0], [0, 0, length], [0, 0, 0], [length, 0, 0]],
      elements: [{ nodes: [2, 3, 0, 1], materialId: 'm' }], materials: [{ id: 'm', youngMPa: young, poisson: 0 }],
      constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [true, true, true] },
        { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [false, true, true] }],
      nodalLoads: [{ node: 3, forceN: [force, 0, 0] }], surfaceLoads: [] };
    const before = structuredClone(input);
    const result = await analyzeSolid(runtime, input, { wrapper: verified('solidAnalysis.py'),
      wheelLocation: join(assets, wheel).split(sep).join('/') }, () => undefined);
    expect(input).toEqual(before);
    expect(result.displacementMm[3][0]).toBeCloseTo(6 * force / (young * length), 13);
    expect(result.displacementMm.slice(0, 3)).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(result.reactionN[2][0]).toBeCloseTo(-force, 12);
    expect(result.elements[0].stressMPa[0]).toBeCloseTo(6 * force / length ** 2, 12);
    expect(result.strainEnergyNmm).toBeCloseTo(3 * force ** 2 / (young * length), 13);
    const localForces = [-force, 0, 0, force, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(result.nativeElementForcesN[0]).toHaveLength(localForces.length);
    localForces.forEach((value, i) => expect(result.nativeElementForcesN[0][i]).toBeCloseTo(value, 12));
    expect(solidResultMatches(result, input, await solidInputSha256(input))).toBe(true);
    expect(result.reservedNumericBytes).toBeLessThanOrEqual(input.numericBudgetBytes);
    expect(deniedRequests).toBe(0);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
