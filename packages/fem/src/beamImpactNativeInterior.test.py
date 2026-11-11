"""Independent Timoshenko closed-form check of the ACTUAL native run_beam_impact mesh fields (task183 producer).

Runs inside the pinned Pyodide after beamImpactNativeInterior.test.mjs has executed the exact runtime snippet of
beamImpactRuntime.ts on the translated plan; /pcad_fem/impact-raw.json holds that actual reply. Every expected value is
a closed-form formula of the constants passed by the TypeScript test (the user's input numbers): the two-node
Timoshenko element stiffness with Phi = 12 E I / (kappa G A Le^2), rotated by the independently built frame. No
function of beam_impact or beam_analysis computes an expectation here. Units: N, m, rad.
"""
import json
import math

import numpy as np

with open('/pcad_fem/benchmark.json', encoding='utf-8') as stream:
    BENCH = json.load(stream)
with open('/pcad_fem/impact-raw.json', encoding='utf-8') as stream:
    RAW = json.load(stream)
C = BENCH['constants']
PLAN = BENCH['plans']['interior']
E, G = C['youngPa'], C['shearPa']
A, IY, IZ, J, KAPPA = C['areaM2'], C['iyM4'], C['izM4'], C['torsionM4'], C['shearFactor']
START, END = np.array(C['startM'], dtype=float), np.array(C['endM'], dtype=float)
SEGMENTS = C['segments']
LENGTH = float(np.linalg.norm(END - START))
LE = LENGTH / SEGMENTS
EX = (END - START) / LENGTH
HINT = np.array(C['localYHint'], dtype=float)
EY = HINT - EX * float(EX @ HINT)
EY = EY / np.linalg.norm(EY)
EZ = np.cross(EX, EY)
R = np.array([EX, EY, EZ])
T = np.kron(np.eye(4), R)
CHECKS = []


def check(condition, label):
    if not condition:
        raise AssertionError(label)
    CHECKS.append(label)


def near(actual, expected, tolerance, label):
    actual, expected = np.asarray(actual, dtype=float), np.asarray(expected, dtype=float)
    scale = max(float(np.max(np.abs(expected))), 1e-300)
    error = float(np.max(np.abs(actual - expected))) / scale
    check(error <= tolerance, f'{label}: relative error {error:.3e} > {tolerance:.1e}')


def timoshenko_local(length):
    """Closed-form local 12 x 12, DOFs [u v w tx ty tz] per end; bending in x-y uses Iz, in x-z uses Iy."""
    k = np.zeros((12, 12))
    axial, torsion = E * A / length, G * J / length
    for i, j, value in ((0, 0, axial), (6, 6, axial), (0, 6, -axial), (3, 3, torsion), (9, 9, torsion), (3, 9, -torsion)):
        k[i, j] = k[j, i] = value
    for v, t, inertia, sign in ((1, 5, IZ, 1.0), (2, 4, IY, -1.0)):
        phi = 12 * E * inertia / (KAPPA * G * A * length ** 2)
        c = E * inertia / ((1 + phi) * length ** 3)
        entries = [(v, v, 12 * c), (v + 6, v + 6, 12 * c), (v, v + 6, -12 * c),
                   (t, t, (4 + phi) * c * length ** 2), (t + 6, t + 6, (4 + phi) * c * length ** 2),
                   (t, t + 6, (2 - phi) * c * length ** 2),
                   (v, t, sign * 6 * c * length), (v, t + 6, sign * 6 * c * length),
                   (v + 6, t, -sign * 6 * c * length), (v + 6, t + 6, -sign * 6 * c * length)]
        for i, j, value in entries:
            k[i, j] = k[j, i] = value
    return k


K_LOCAL = timoshenko_local(LE)
K_GLOBAL = T.T @ K_LOCAL @ T

# 1. Producer fields: one block per plan member with its identity, every plan node in every sample.
elements = RAW['elements']
check(len(elements) == len(PLAN['members']) == SEGMENTS, 'one element block per plan member')
for row, member in zip(elements, PLAN['members']):
    check(row['number'] == member['number'] and row['nodes'] == member['nodes'], f'element {row["number"]} identity')
    # 2. Native element block = independent Timoshenko closed form in the independent frame (rotated member).
    near(row['globalStiffness'], K_GLOBAL, 1e-9, f'element {row["number"]} native block equals T^T k_Timoshenko T')
size = 6 * len(PLAN['nodes'])
assembled, closed = np.zeros((size, size)), np.zeros((size, size))
for row, member in zip(elements, PLAN['members']):
    indices = [6 * (number - 1) + axis for number in member['nodes'] for axis in range(6)]
    assembled[np.ix_(indices, indices)] += np.array(row['globalStiffness'], dtype=float)
    closed[np.ix_(indices, indices)] += K_GLOBAL
near(assembled, closed, 1e-9, 'assembled native blocks equal the assembled closed-form K')
samples = RAW['samples']
check(all(len(sample['mesh']) == len(PLAN['nodes']) for sample in samples), 'every mesh node in every sample')
original = PLAN['originalNodeCount']
for sample in samples:
    for index in range(original):
        node, mesh = sample['nodes'][index], sample['mesh'][index]
        check(mesh['displacementM'] == node['displacementM'] and mesh['rotationRad'] == node['rotationRad'],
              f'step {sample["step"]} mesh row {index + 1} equals the original-node row')
supported = [index for index, node in enumerate(PLAN['nodes']) if all(node['restrained'])]
check(supported == [0], 'the start node is the only fully supported node')
check(all(value == 0 for sample in samples for value in sample['mesh'][0]['displacementM'] + sample['mesh'][0]['rotationRad']),
      'the supported endpoint never moves')
interior = list(range(original, len(PLAN['nodes'])))
check(len(interior) == SEGMENTS - 1, 'the interior mesh nodes of the subdivided member are present')
check(max(abs(value) for sample in samples for index in interior for value in sample['mesh'][index]['displacementM']) > 0,
      'an interior mesh node moves')

# 3. Static force oracle on the native block: guided end (double curvature) and cantilever tip load, exact for
#    Timoshenko end loads. Expected local end forces are closed-form numbers, not K_e u_e of the block under test.
native = np.array(elements[0]['globalStiffness'], dtype=float)
delta = 1e-3
guided = np.r_[0, 0, 0, 0, 0, 0, delta * EY, 0, 0, 0]
phi_z = 12 * E * IZ / (KAPPA * G * A * LE ** 2)
shear = 12 * E * IZ * delta / ((1 + phi_z) * LE ** 3)
moment = 6 * E * IZ * delta / ((1 + phi_z) * LE ** 2)
forces = T @ (native @ guided)
near(forces[[1, 5, 7, 11]], [-shear, -moment, shear, -moment], 1e-9,
     'double curvature: end shear 12EI delta/((1+Phi)L^3), end moments of equal sign, member mean section moment zero')
load = 3.0
tip = np.r_[0, 0, 0, 0, 0, 0, load * (LE ** 3 / (3 * E * IZ) + LE / (KAPPA * G * A)) * EY, load * LE ** 2 / (2 * E * IZ) * EZ]
forces = T @ (native @ tip)
near(forces[[1, 5, 7, 11]], [-load, -load * LE, load, 0.0], 1e-9,
     'cantilever tip load: reaction -P and -P L at the supported start, P and no moment at the loaded end')

# 4. Dynamic samples: section resultants from the actual mesh with the CLOSED-FORM block, reported for the TypeScript
#    side to compare with impactElementEndForces (the function under test runs only there).
oracle = []
for sample in samples:
    rows = []
    for member in PLAN['members']:
        a, b = (sample['mesh'][number - 1] for number in member['nodes'])
        u = np.r_[a['displacementM'], a['rotationRad'], b['displacementM'], b['rotationRad']]
        f = T @ (K_GLOBAL @ u)
        rows.append({'start': (-f[:6]).tolist(), 'end': f[6:].tolist()})
    oracle.append(rows)
peak = max(abs(value) for rows in oracle for row in rows for value in row['start'] + row['end'])
check(peak > 0, 'the impact produces nonzero element end forces at emitted samples')

print(f'beam-impact-native-interior: {len(CHECKS)} independent checks passed')
with open('/pcad_fem/interior-oracle.json', 'x', encoding='utf-8') as stream:
    json.dump(oracle, stream)
with open('/pcad_fem/benchmark-completion.jsonl', 'x', encoding='utf-8') as stream:
    json.dump({'schema': 'pcad-impact-native-interior-completion/1', 'status': 'passed', 'checks': len(CHECKS),
               'report': f'beam-impact-native-interior: {len(CHECKS)} independent checks passed'}, stream, separators=(',', ':'))
    stream.write('\n')
