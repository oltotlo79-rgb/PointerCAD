import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { SolidAnalysisInput, SolidVector3 } from './solidAnalysisModel.js';

/** W14 independent linear-static oracles. Constants are fixed here and every expectation is an elementary closed
 * form; nothing is read back from a translator, plan or native result. */

/** Cantilever in N, m, Pa; the same numbers analysisCases.testSupport cantilever() builds, restated as the oracle. */
export const BEAM = { lengthM: 2, forceN: 4000, youngPa: 208e9, shearPa: 80e9, areaM2: 0.003, izM4: 5e-6,
  shearFactor: 5 / 6 } as const;
/** Timoshenko tip deflection under a tip force P along local y (bending about z): P L^3 / (3 E Iz) + P L / (k G A). */
export function cantileverTipDeflectionM(forceN: number): number {
  const { lengthM: L, youngPa: E, shearPa: G, areaM2: A, izM4: I, shearFactor: k } = BEAM;
  return forceN * L ** 3 / (3 * E * I) + forceN * L / (k * G * A);
}
/** Legacy Euler-Bernoulli formula without the shear term; only used as a negative oracle. */
export function cantileverTipDeflectionWithoutShearM(forceN: number): number {
  const { lengthM: L, youngPa: E, izM4: I } = BEAM;
  return forceN * L ** 3 / (3 * E * I);
}
/** Axial tip elongation P L / (E A). */
export function axialElongationM(forceN: number): number {
  return forceN * BEAM.lengthM / (BEAM.youngPa * BEAM.areaM2);
}

/** Prismatic bar in N-mm-MPa: x in [0, 30], y in [0, 4], z in [0, 6], nu = 0.3, end stress 10 MPa. */
export const BAR = { lengthMm: 30, widthMm: 4, heightMm: 6, youngMPa: 210000, poisson: 0.3, stressMPa: 10 } as const;
export const barForceN = (): number => BAR.stressMPa * BAR.widthMm * BAR.heightMm;
/** Uniaxial stress sigma_xx = P / A: u = (s x / E, -nu s y / E, -nu s z / E). Free lateral contraction. */
export function uniaxialDisplacementMm(point: SolidVector3): SolidVector3 {
  const strain = BAR.stressMPa / BAR.youngMPa;
  return [strain * point[0], -BAR.poisson * strain * point[1], -BAR.poisson * strain * point[2]];
}
/**
 * Level n: 5n x n x n Cartesian cells, each split into the six Kuhn tetrahedra about its main diagonal (conforming).
 * Supports remove only the six rigid modes and never restrain Poisson contraction: every x = 0 node is held in x,
 * the origin also in y and z, and (0, width, 0) also in z. The exact uniaxial field satisfies all of them exactly.
 * The x = L end carries the uniform traction (stress, 0, 0) on its exterior element faces.
 */
export function tensionBar(level: number): SolidAnalysisInput {
  const nx = 5 * level, ny = level, nz = level;
  const id = (i: number, j: number, k: number): number => (i * (ny + 1) + j) * (nz + 1) + k;
  const nodes: SolidVector3[] = [];
  for (let i = 0; i <= nx; i += 1) for (let j = 0; j <= ny; j += 1) for (let k = 0; k <= nz; k += 1)
    nodes.push([BAR.lengthMm * i / nx, BAR.widthMm * j / ny, BAR.heightMm * k / nz]);
  const elements: SolidAnalysisInput['elements'][number][] = [];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const;
  const signedVolume = (a: number, b: number, c: number, d: number): number => {
    const [p, q, r, s] = [nodes[a], nodes[b], nodes[c], nodes[d]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const w = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };
  for (let i = 0; i < nx; i += 1) for (let j = 0; j < ny; j += 1) for (let k = 0; k < nz; k += 1) {
    const corner = (bits: readonly [number, number, number]): number => id(i + bits[0], j + bits[1], k + bits[2]);
    for (const [a0, a1] of permutations) {
      const first: [number, number, number] = [0, 0, 0], second: [number, number, number] = [0, 0, 0];
      first[a0] = 1; second[a0] = 1; second[a1] = 1;
      const tet: [number, number, number, number] = [corner([0, 0, 0]), corner(first), corner(second), corner([1, 1, 1])];
      if (signedVolume(...tet) < 0) [tet[1], tet[2]] = [tet[2], tet[1]];
      elements.push({ materialId: 'bar', nodes: tet });
    }
  }
  const faces = new Map<string, { readonly nodes: [number, number, number]; count: number }>();
  for (const { nodes: [a, b, c, d] } of elements) for (const face of [[b, c, d], [a, d, c], [a, b, d], [a, c, b]] as const) {
    const key = [...face].sort((x, y) => x - y).join(','), found = faces.get(key);
    if (found) found.count += 1; else faces.set(key, { nodes: [face[0], face[1], face[2]], count: 1 });
  }
  const surfaceLoads = [...faces.values()].filter(face => face.count === 1
    && face.nodes.every(node => nodes[node][0] === BAR.lengthMm))
    .map(face => ({ nodes: face.nodes, tractionMPa: [BAR.stressMPa, 0, 0] as const }));
  const constraints: SolidAnalysisInput['constraints'][number][] = [];
  for (let j = 0; j <= ny; j += 1) for (let k = 0; k <= nz; k += 1)
    constraints.push({ node: id(0, j, k), fixed: [true, j === 0 && k === 0, k === 0 && (j === 0 || j === ny)] });
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'W14-tension-bar', revision: 1, meshKey: `tension-${level}` },
    units: 'N-mm-MPa', numericBudgetBytes: 128 * 1024 * 1024, nodes, elements,
    materials: [{ id: 'bar', youngMPa: BAR.youngMPa, poisson: BAR.poisson }], constraints, nodalLoads: [], surfaceLoads };
}

/** Packaged offline Pyodide + OOFEM, exactly the existing pinned-asset pattern (size + SHA-256 from the manifest). */
export const FEM_ASSETS = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
export const OOFEM_WHEEL = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
export function verifiedAsset(name: string): Uint8Array {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
    || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Missing asset manifest');
  const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error(`Missing pin: ${name}`);
  const bytes = new Uint8Array(readFileSync(join(FEM_ASSETS, name)));
  const actual = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256) throw new Error(`Asset pin mismatch: ${name}`);
  return bytes;
}
export const wheelLocation = (): string => join(FEM_ASSETS, OOFEM_WHEEL).split(sep).join('/');
export async function loadPackagedRuntime(): Promise<PyodideRuntime> {
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', OOFEM_WHEEL]) verifiedAsset(name);
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(FEM_ASSETS, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged Pyodide loader');
  const loaded = await loader.loadPyodide({ indexURL: FEM_ASSETS + sep, packageBaseUrl: FEM_ASSETS + sep,
    packageCacheDir: FEM_ASSETS, lockFileContents: readFileSync(join(FEM_ASSETS, 'pyodide-lock.json'), 'utf8'),
    stdLibURL: join(FEM_ASSETS, 'python_stdlib.zip'), packages: ['numpy'], fullStdLib: false,
    stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged Pyodide runtime');
  return loaded;
}
export const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
