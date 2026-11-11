"""Independent beam-formula benchmark of the ACTUAL native OOFEM Beam3d K and M used by run_beam_impact.

Runs inside the pinned Pyodide with the pinned OOFEM wheel, after beamImpactNativeMatrices.test.mjs has executed the
exact runtime snippet of beamImpactRuntime.ts (so /pcad_fem holds beam_analysis.py, beam_impact.py and the plan).
The matrices come from beam_analysis._native_beam3d_matrices, exactly as run_beam_impact obtains them. Every expected
value is a closed-form beam formula of the constants passed by the TypeScript test (the user's input numbers, not the
translated plan): cantilever end compliance (Timoshenko: bending + shear, exact for end loads), rigid-body kinetic
energies of a consistent mass, and the Euler-Bernoulli cantilever first frequency (beta1 L = 1.87510406871196, the
first root of 1 + cos x cosh x = 0). Units: N, m, kg, s, rad. No rate, friction, plasticity or certification claim.
"""
import json
import math
import sys

import numpy as np
import oofem as fem
from oofem import util

sys.path.insert(0, '/pcad_fem')
from beam_analysis import _native_beam3d_matrices, _native_beam3d_problem  # noqa: E402
from beam_impact import solve_impact_plan  # noqa: E402

BETA1_L = 1.87510406871196
with open('/pcad_fem/benchmark.json', encoding='utf-8') as stream:
    BENCH = json.load(stream)
C = BENCH['constants']
E, G, RHO = C['youngPa'], C['shearPa'], C['densityKgM3']
A, IY, IZ, J, KAPPA = C['areaM2'], C['iyM4'], C['izM4'], C['torsionM4'], C['shearFactor']
START, END = np.array(C['startM'], dtype=float), np.array(C['endM'], dtype=float)
LENGTH = math.dist(C['startM'], C['endM'])
EX = (END - START) / LENGTH
EY = np.array(C['localYHint'], dtype=float)
EY = EY / np.linalg.norm(EY)
EZ = np.cross(EX, EY)
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


def matrices(plan):
    problem = _native_beam3d_problem(fem, '/pcad_fem/benchmark-matrices.out')
    try:
        return _native_beam3d_matrices(np, fem, util, problem, plan, 'OOFEM rejected the benchmark plan')
    finally:
        problem.terminateAnalysis()


ONE, EIGHT = BENCH['plans']['one'], BENCH['plans']['eight']
# Orientation of the translated frame: x along the member, y the supplied hint (exactly perpendicular), z = x cross y.
frame = ONE['members'][0]['frame']
near([frame['x'], frame['y'], frame['z']], [EX, EY, EZ], 1e-12, 'translated member frame equals the independent axes')
near(frame['lengthM'], LENGTH, 1e-12, 'translated member length')
stiffness, mass = matrices(ONE)
check(stiffness.shape == (12, 12) and mass.shape == (12, 12), 'two nodes, six global DOFs each')

# 1. Cantilever end compliance: node 1 clamped (plan restraint), node 2 free; global DOFs 6..11 of node 2.
compliance = np.linalg.inv(stiffness[6:, 6:])
bend_y = LENGTH ** 3 / (3 * E * IZ) + LENGTH / (G * KAPPA * A)   # tip force along local y bends about local z
bend_z = LENGTH ** 3 / (3 * E * IY) + LENGTH / (G * KAPPA * A)
cases = [
    ('end force along local x (axial)', np.r_[EX, 0, 0, 0], np.r_[LENGTH / (E * A) * EX, 0, 0, 0]),
    ('end force along local y', np.r_[EY, 0, 0, 0], np.r_[bend_y * EY, LENGTH ** 2 / (2 * E * IZ) * EZ]),
    ('end force along local z', np.r_[EZ, 0, 0, 0], np.r_[bend_z * EZ, -LENGTH ** 2 / (2 * E * IY) * EY]),
    ('end torque about local x', np.r_[0, 0, 0, EX], np.r_[0, 0, 0, LENGTH / (G * J) * EX]),
    ('end moment about local y', np.r_[0, 0, 0, EY], np.r_[-LENGTH ** 2 / (2 * E * IY) * EZ, LENGTH / (E * IY) * EY]),
    ('end moment about local z', np.r_[0, 0, 0, EZ], np.r_[LENGTH ** 2 / (2 * E * IZ) * EY, LENGTH / (E * IZ) * EZ]),
]
for label, load, expected in cases:
    response = compliance @ load
    # Translations (m per N) and rotations (rad per N) are compared separately: they differ in units.
    near(response[:3], expected[:3], 1e-9, f'{label}: end translation') if np.any(expected[:3]) else \
        check(float(np.max(np.abs(response[:3]))) <= 1e-9 * float(np.max(np.abs(compliance[:3, :3]))), f'{label}: no translation')
    near(response[3:], expected[3:], 1e-9, f'{label}: end rotation') if np.any(expected[3:]) else \
        check(float(np.max(np.abs(response[3:]))) <= 1e-9 * float(np.max(np.abs(compliance[3:, 3:]))), f'{label}: no rotation')

# 2. Consistent mass (native + rotary correction), full unrestrained 12 x 12 global matrix: rigid-body energies.
for direction in (np.array([1.0, 2.0, 3.0]) / math.sqrt(14), EY, EZ):
    rigid = np.r_[direction, 0, 0, 0, direction, 0, 0, 0]
    near(rigid @ mass @ rigid, RHO * A * LENGTH, 1e-12, 'rigid translation carries the member mass rho A L')
for axis, inertia, label in ((EZ, IZ, 'local z'), (EY, IY, 'local y')):
    # Rotation omega = axis about node 1: node 2 moves with omega x (L ex); both sections rotate with omega.
    rigid = np.r_[0, 0, 0, axis, np.cross(axis, LENGTH * EX), axis]
    expected = RHO * A * LENGTH ** 3 / 3 + RHO * inertia * LENGTH
    near(rigid @ mass @ rigid, expected, 1e-12, f'rigid rotation about {label} through the clamped end: rho A L^3/3 + rho I L')

# 3. Euler-Bernoulli cantilever first frequencies with eight segments: lowest mode bends towards local z (Iy < Iz),
#    the first in-plane mode towards local y; their ratio is sqrt(Iy / Iz).
k8, m8 = matrices(EIGHT)
free = [6 * index + axis for index, node in enumerate(EIGHT['nodes']) for axis in range(6) if not node['restrained'][axis]]
kf, mf = k8[np.ix_(free, free)], m8[np.ix_(free, free)]
lower = np.linalg.cholesky((mf + mf.T) / 2)
inverse = np.linalg.inv(lower)
values, vectors = np.linalg.eigh(inverse @ ((kf + kf.T) / 2) @ inverse.T)
modes = inverse.T @ vectors
tip = [free.index(6 + axis) for axis in range(3)]   # node 2 (the free original end) translations


def first_frequency(direction):
    for index in range(len(values)):
        motion = modes[tip, index]
        size = float(np.linalg.norm(motion))
        # A torsion mode has (almost) no end translation: it must not pass the direction test on rounding noise.
        if size > 1e-6 * float(np.linalg.norm(modes[:, index])) and abs(float(motion @ direction)) >= (1 - 1e-6) * size:
            return math.sqrt(values[index]), index
    raise AssertionError('no mode bends towards the expected axis')


omega_z, index_z = first_frequency(EZ)
omega_y, _ = first_frequency(EY)
check(index_z == 0, 'the lowest native mode bends towards local z (weaker Iy)')
for omega, inertia, label in ((omega_z, IY, 'local z'), (omega_y, IZ, 'local y')):
    analytic = BETA1_L ** 2 * math.sqrt(E * inertia / (RHO * A * LENGTH ** 4))
    # Discretization raises, shear and rotary inertia lower the frequency; both are far below 1e-3 here.
    near(omega, analytic, 1e-3, f'first bending frequency towards {label} equals the Euler-Bernoulli cantilever value')
near(omega_z / omega_y, math.sqrt(IY / IZ), 1e-3, 'frequency ratio sqrt(Iy / Iz)')

# 4. Impact path on the same native matrices: velocity along local y only, a plane facing local z.
impact = ONE['impact']
v0 = np.array(impact['initialVelocity'], dtype=float).ravel()
near(v0[6:9], np.array(C['tipVelocityMPerS'], dtype=float), 0, 'translated initial velocity of the free end (m/s)')
result = solve_impact_plan(np, ONE, stiffness, mass)
near(result['initialEnergyJ'], 0.5 * v0 @ mass @ v0, 1e-12, 'initial energy in joules from the unscaled native mass')
displacements = np.array([sample['nodes'][1]['displacementM'] for sample in result['samples']])
rotations = np.array([sample['nodes'][1]['rotationRad'] for sample in result['samples']])
scale_u, scale_r = float(np.max(np.abs(displacements))), float(np.max(np.abs(rotations)))
check(scale_u > 0 and scale_r > 0, 'the free end moves and rotates')
check(float(np.max(np.abs(displacements @ EZ))) <= 1e-10 * scale_u, 'no displacement out of the local x-y plane')
check(float(np.max(np.abs(rotations @ EX))) <= 1e-10 * scale_r and float(np.max(np.abs(rotations @ EY))) <= 1e-10 * scale_r,
      'rotation only about local z')
check(all(sample['contacts'][0]['gapM'] == impact['contacts'][0]['gapM'] or
          abs(sample['contacts'][0]['gapM'] - impact['contacts'][0]['gapM']) <= 1e-12 for sample in result['samples']),
      'the out-of-plane gap never changes')
check(result['contactPeaks'][0]['totalImpulseNs'] == 0, 'no contact impulse')
near([sample['energyJ'] for sample in result['samples']], [result['initialEnergyJ']] * len(result['samples']), 1e-10,
     'undamped elastic energy is conserved')

# 5. Step convergence of the midpoint rule (second order): halving the step quarters the end-displacement change.
ends = []
for divisor in (1, 2, 4):
    plan = json.loads(json.dumps(ONE))
    plan['impact']['timeStepS'] = impact['timeStepS'] / divisor
    plan['impact']['stepCount'] = impact['stepCount'] * divisor
    plan['impact']['outputEvery'] = impact['outputEvery'] * divisor
    final = solve_impact_plan(np, plan, stiffness, mass)['samples'][-1]
    check(abs(final['timeS'] - impact['timeStepS'] * impact['stepCount']) <= 1e-12, f'same final time for step / {divisor}')
    ends.append(np.array(final['nodes'][1]['displacementM']))
first, second = float(np.linalg.norm(ends[0] - ends[1])), float(np.linalg.norm(ends[1] - ends[2]))
check(second > 0 and 3.5 <= first / second <= 4.5, f'second-order step convergence (ratio {first / max(second, 1e-300):.3f})')

print(f'beam-impact-native-matrices: {len(CHECKS)} independent checks passed')

# Exclusive completion transport, separate from all native stdout above. A second completion is an error.
with open('/pcad_fem/benchmark-completion.jsonl', 'x', encoding='utf-8') as stream:
    json.dump({'schema': 'pcad-impact-native-completion/1', 'status': 'passed', 'checks': len(CHECKS),
               'report': f'beam-impact-native-matrices: {len(CHECKS)} independent checks passed'}, stream, separators=(',', ':'))
    stream.write('\n')
