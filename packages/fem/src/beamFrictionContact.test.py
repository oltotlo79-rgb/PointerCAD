"""Independent Coulomb friction tests for beamFrictionContact (pure NumPy, no native runtime).

Expected values are written from the closed-form spring solutions in the comments, or checked against the contact
laws by the independent checker below; none is produced by the solver under test.
"""
import copy
import math
import unittest

import numpy as np

from beamContact import _solve_contact_system
from beamFrictionContact import (
    FrictionProblem,
    check_step,
    solve_friction_contact_system,
    solve_friction_steps,
    tangent_basis,
)

SOLVERS = ('newton', 'nsgs')


def check_step_for(problem, force, displacement, previous, p, force_scale=10.0):
    """check_step with a fixed force scale, F = 10 N by default (the unit spring fixture's load size; there its
    normal and tangential scales W F are the 10 m of the former single displacement scale)."""
    return check_step(np, problem, force, displacement, previous, p, force_scale)


def node(number, position, free_translations):
    return {'number': number, 'positionM': position, 'restrained': [not free_translations] * 3 + [True] * 3,
            'load': [0.0] * 6}


def load_on(count, entries):
    """Full nodal load vector: entries maps node number -> [Fx, Fy, Fz]."""
    vector = [0.0] * (6 * count)
    for number, force in entries.items():
        vector[6 * (number - 1):6 * (number - 1) + 3] = [float(value) for value in force]
    return vector


def spring_fixture(normal=(0.0, 0.0, 1.0), kn=1.0, kt=1.0, block=None, gap=0.0):
    """Node 2 on translational springs to ground (normal kn, tangential kt, or a given 3x3 block), touching a fixed
    plane with the given outward normal. Node 1 is a fully restrained dummy."""
    n = np.array(normal, dtype=float)
    if block is None:
        block = kn * np.outer(n, n) + kt * (np.eye(3) - np.outer(n, n))
    stiffness = np.zeros((12, 12))
    stiffness[6:9, 6:9] = block
    plan = {'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 2,
            'nodes': [node(1, [0.0, 0.0, 0.0], False), node(2, [1.0, 0.0, 0.0], True)],
            'contacts': [{'id': 'plane', 'kind': 'node-plane', 'node': 2, 'normal': list(normal), 'gapM': gap}],
            'loadFactors': [1.0], 'members': []}
    return plan, stiffness


def pressed(normal, shear, pressure=10.0):
    """Load on node 2: pressure against the plane (along -n) plus a tangential shear vector."""
    return load_on(2, {2: (-pressure * np.array(normal) + np.array(shear)).tolist()})


def coupled_fixture(mu_plane=0.4, mu_pair=0.25, swapped=False):
    """Nodes 2 and 3 with coupled translational stiffness (normal and tangential DOFs coupled), a plane under node 2
    and a pair between nodes 2 and 3."""
    rng = np.random.default_rng(20261029)
    a = rng.normal(size=(6, 6))
    block = a @ a.T + 3.0 * np.eye(6)
    stiffness = np.zeros((18, 18))
    index = [6, 7, 8, 12, 13, 14]
    stiffness[np.ix_(index, index)] = block
    pair = ({'id': 'pair', 'kind': 'node-pair', 'nodeA': 3, 'nodeB': 2, 'normal': [-1.0, 0.0, 0.0], 'gapM': 0.05}
            if swapped else
            {'id': 'pair', 'kind': 'node-pair', 'nodeA': 2, 'nodeB': 3, 'normal': [1.0, 0.0, 0.0], 'gapM': 0.05})
    plan = {'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 3,
            'nodes': [node(1, [0.0, 0.0, 0.0], False), node(2, [1.0, 0.0, 0.0], True), node(3, [2.0, 0.0, 0.0], True)],
            'contacts': [{'id': 'plane', 'kind': 'node-plane', 'node': 2, 'normal': [0.0, 0.0, 1.0], 'gapM': 0.02},
                         pair],
            # members is only counted by beamContact's result (meshElements); K is given directly here.
            'loadFactors': [1.0], 'members': []}
    return plan, stiffness, {'plane': mu_plane, 'pair': mu_pair}


COUPLED_LOADS = [
    load_on(3, {2: [1.0, 0.5, -20.0], 3: [-12.0, 0.3, 0.2]}),
    load_on(3, {2: [9.0, 4.0, -20.0], 3: [-12.0, 2.0, 1.0]}),
    load_on(3, {2: [9.5, 4.2, -20.0], 3: [-12.0, 2.1, 1.0]}),
    load_on(3, {2: [-9.0, -4.0, -20.0], 3: [-12.0, -3.0, -1.0]}),
    load_on(3, {2: [-9.0, -4.0, 8.0], 3: [5.0, -3.0, -1.0]}),
    load_on(3, {2: [2.0, 1.0, -25.0], 3: [-15.0, 0.0, 0.0]}),
]


def rotation(axis, angle):
    k = np.array(axis, dtype=float) / np.linalg.norm(axis)
    cross = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(angle) * cross + (1 - math.cos(angle)) * cross @ cross


def check_laws(test, plan, stiffness, friction, loads, result):
    """Independent check of every step from the reported displacements and contact forces only."""
    count = len(plan['nodes'])
    free = np.array([6 * i + a for i, row in enumerate(plan['nodes']) for a in range(6) if not row['restrained'][a]])
    previous = np.zeros(6 * count)
    states = set()
    for load, state in zip(loads, result['states'], strict=True):
        u = np.zeros(6 * count)
        for row in state['nodes']:
            u[6 * (row['number'] - 1):6 * (row['number'] - 1) + 3] = row['displacementM']
            u[6 * (row['number'] - 1) + 3:6 * (row['number'] - 1) + 6] = row['rotationRad']
        contact_force = np.zeros(6 * count)
        for contact, reported in zip(plan['contacts'], state['contacts'], strict=True):
            n = np.array(contact['normal'])
            lam = reported['normalReactionN']
            friction_force = np.array(reported['frictionForceN'])
            total = lam * n + friction_force
            if contact['kind'] == 'node-plane':
                start = 6 * (contact['node'] - 1)
                contact_force[start:start + 3] += total
                relative, before = u[start:start + 3], previous[start:start + 3]
            else:
                a, b = 6 * (contact['nodeA'] - 1), 6 * (contact['nodeB'] - 1)
                contact_force[a:a + 3] -= total
                contact_force[b:b + 3] += total
                relative, before = u[b:b + 3] - u[a:a + 3], previous[b:b + 3] - previous[a:a + 3]
            gap = contact['gapM'] + float(n @ relative)
            mu = friction[contact['id']]
            scale = max(1.0, abs(lam))
            test.assertGreaterEqual(gap, -1e-10)
            test.assertGreaterEqual(lam, -1e-9 * scale)
            test.assertLessEqual(abs(lam * gap), 1e-9 * scale)
            test.assertAlmostEqual(reported['gapM'], gap, delta=1e-10)
            test.assertLessEqual(abs(float(friction_force @ n)), 1e-10 * scale)
            test.assertLessEqual(np.linalg.norm(friction_force), mu * max(lam, 0.0) + 1e-9 * scale)
            increment = (np.eye(3) - np.outer(n, n)) @ (relative - before)
            if np.linalg.norm(increment) > 1e-9 and lam > 1e-9:
                expected = -mu * lam * increment / np.linalg.norm(increment)
                np.testing.assert_allclose(friction_force, expected, atol=1e-8 * scale, rtol=0)
                states.add('slip' if mu > 0 else 'closed')
            elif lam > 1e-9:
                states.add('stick' if mu > 0 else 'closed')
            else:
                states.add('open')
            test.assertGreaterEqual(-float(friction_force @ increment), -1e-10 * scale)
        residual = (stiffness @ u - np.array(load) - contact_force)[free]
        test.assertLessEqual(np.linalg.norm(residual), 1e-9 * (np.linalg.norm(load) + np.linalg.norm(contact_force)))
        previous = u
    return states


class CoulombSpringTests(unittest.TestCase):
    """Criterion (2): normalized orthogonal springs, N = 10, mu = 0.3."""

    def test_stick_and_slip_values(self):
        for solver in SOLVERS:
            for kt in (1.0, 4.0):
                plan, stiffness = spring_fixture(kt=kt)
                # Shear 2 <= mu N = 3: stick. Friction carries all of it, no tangential displacement.
                result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3},
                                              [pressed((0, 0, 1), (2, 0, 0))], solver=solver)
                contact = result['states'][0]['contacts'][0]
                self.assertEqual(contact['state'], 'stick')
                self.assertAlmostEqual(contact['normalReactionN'], 10.0, delta=1e-10)
                np.testing.assert_allclose(contact['frictionForceN'], [-2.0, 0.0, 0.0], atol=1e-10)
                np.testing.assert_allclose(result['states'][0]['nodes'][1]['displacementM'], [0, 0, 0], atol=1e-12)
                np.testing.assert_allclose(contact['slipIncrementM'], [0, 0, 0], atol=1e-12)
                # Shear 5 > 3: slip, friction mu N = 3 against the slip, displacement (5 - 3) / kt.
                result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3},
                                              [pressed((0, 0, 1), (5, 0, 0))], solver=solver)
                contact = result['states'][0]['contacts'][0]
                self.assertEqual(contact['state'], 'slip')
                self.assertAlmostEqual(contact['normalReactionN'], 10.0, delta=1e-10)
                np.testing.assert_allclose(contact['frictionForceN'], [-3.0, 0.0, 0.0], atol=1e-10)
                np.testing.assert_allclose(result['states'][0]['nodes'][1]['displacementM'], [(5 - 3) / kt, 0, 0],
                                           atol=1e-10)
                self.assertAlmostEqual(contact['dissipatedWorkJ'], 3.0 * (5 - 3) / kt, delta=1e-10)

    def test_two_tangential_components(self):
        for solver in SOLVERS:
            plan, stiffness = spring_fixture(kt=2.0)
            # |(3, 4)| = 5 > 3: slip along (0.6, 0.8), friction -3 (0.6, 0.8), displacement 2 / 2 (0.6, 0.8).
            result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3},
                                          [pressed((0, 0, 1), (3, 4, 0))], solver=solver)
            contact = result['states'][0]['contacts'][0]
            np.testing.assert_allclose(contact['frictionForceN'], [-1.8, -2.4, 0.0], atol=1e-10)
            np.testing.assert_allclose(result['states'][0]['nodes'][1]['displacementM'], [0.6, 0.8, 0.0], atol=1e-10)

    def test_slip_does_not_open_the_contact(self):
        """An associated cone flow would open the gap by mu |slip| = 0.6 here; Coulomb keeps it closed."""
        for solver in SOLVERS:
            plan, stiffness = spring_fixture()
            result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3},
                                          [pressed((0, 0, 1), (5, 0, 0))], solver=solver)
            contact = result['states'][0]['contacts'][0]
            self.assertEqual(contact['state'], 'slip')
            self.assertAlmostEqual(contact['gapM'], 0.0, delta=1e-12)
            self.assertAlmostEqual(result['states'][0]['nodes'][1]['displacementM'][2], 0.0, delta=1e-12)


class HistoryTests(unittest.TestCase):
    def test_separation_and_recontact(self):
        """Criterion (3). kt = kn = 1, mu = 0.3.
        1 shear 5, press 10: slip to x = 2.  2 pull 4 away: open, x = 5, z = 4, no forces.
        3 press 10 again with shear 5: closes, sticks at x = 5 (spring 5 = load 5, friction 0).
        4 shear removed: spring 5 > 3, slips back to x = 3 with friction +3."""
        loads = [pressed((0, 0, 1), (5, 0, 0)), pressed((0, 0, 1), (5, 0, 0), pressure=-4.0),
                 pressed((0, 0, 1), (5, 0, 0)), pressed((0, 0, 1), (0, 0, 0))]
        expected = [('slip', 10.0, -3.0, [2, 0, 0]), ('open', 0.0, 0.0, [5, 0, 4]),
                    ('stick', 10.0, 0.0, [5, 0, 0]), ('slip', 10.0, 3.0, [3, 0, 0])]
        for solver in SOLVERS:
            plan, stiffness = spring_fixture()
            result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, loads, solver=solver)
            for state, (name, lam, friction_x, position) in zip(result['states'], expected, strict=True):
                contact = state['contacts'][0]
                self.assertEqual(contact['state'], name)
                self.assertAlmostEqual(contact['normalReactionN'], lam, delta=1e-10)
                np.testing.assert_allclose(contact['frictionForceN'], [friction_x, 0, 0], atol=1e-10)
                np.testing.assert_allclose(state['nodes'][1]['displacementM'], position, atol=1e-10)
            self.assertAlmostEqual(result['states'][1]['contacts'][0]['gapM'], 4.0, delta=1e-10)
            last = result['states'][-1]['contacts'][0]
            self.assertAlmostEqual(last['dissipatedWorkJ'], 6.0 + 6.0, delta=1e-10)
            self.assertAlmostEqual(last['slipPathLengthM'], 4.0, delta=1e-10)
            np.testing.assert_allclose(last['accumulatedSlipM'], [0, 0, 0], atol=1e-10)
            check_laws(self, plan, stiffness, {'plane': 0.3}, loads, result)

    def test_reversal_keeps_history_and_dissipates(self):
        """Criterion (4). kt = 1, mu N = 3.
        +5: slip to 2.  0: sticks at 2 (friction +2 holds the spring).  -5: 2 + 5 = 7 > 3, slips to -2.
        +5: -2 - 5 = -7, slips to +2. Work 6, 0, 12, 12 (mu N |slip|)."""
        loads = [pressed((0, 0, 1), (shear, 0, 0)) for shear in (5, 0, -5, 5)]
        expected = [('slip', -3.0, 2.0, 6.0), ('stick', 2.0, 2.0, 6.0), ('slip', 3.0, -2.0, 18.0),
                    ('slip', -3.0, 2.0, 30.0)]
        for solver in SOLVERS:
            plan, stiffness = spring_fixture()
            result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, loads, solver=solver)
            previous_work = 0.0
            for state, (name, friction_x, x, work) in zip(result['states'], expected, strict=True):
                contact = state['contacts'][0]
                self.assertEqual(contact['state'], name)
                np.testing.assert_allclose(contact['frictionForceN'], [friction_x, 0, 0], atol=1e-10)
                self.assertAlmostEqual(state['nodes'][1]['displacementM'][0], x, delta=1e-10)
                self.assertAlmostEqual(contact['dissipatedWorkJ'], work, delta=1e-9)
                self.assertGreaterEqual(contact['dissipatedWorkJ'] - previous_work, -1e-12)
                previous_work = contact['dissipatedWorkJ']
            check_laws(self, plan, stiffness, {'plane': 0.3}, loads, result)


class InvarianceTests(unittest.TestCase):
    def test_rotated_frame_gives_the_same_physics(self):
        """Criterion (5): rotate the whole problem (normal, stiffness block, loads) by Q."""
        block = np.array([[3.0, 0.4, 0.7], [0.4, 2.0, -0.3], [0.7, -0.3, 5.0]])
        shears = [(4.0, 1.0, 0.0), (0.5, -0.2, 0.0), (-4.0, -2.0, 0.0), (1.0, 3.0, 0.0)]
        q = rotation((1.0, 2.0, 3.0), 0.7)
        normal = (0.0, 0.0, 1.0)
        rotated_normal = (q @ np.array(normal)).tolist()
        for solver in SOLVERS:
            plan, stiffness = spring_fixture(normal=normal, block=block)
            loads = [pressed(normal, shear) for shear in shears]
            base = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.35}, loads, solver=solver)
            plan_r, stiffness_r = spring_fixture(normal=rotated_normal, block=q @ block @ q.T)
            loads_r = [pressed(rotated_normal, (q @ np.array(shear)).tolist()) for shear in shears]
            turned = solve_friction_steps(np, plan_r, stiffness_r, 1.0, {'plane': 0.35}, loads_r, solver=solver)
            seen = set()
            for one, other in zip(base['states'], turned['states'], strict=True):
                a, b = one['contacts'][0], other['contacts'][0]
                seen.add(a['state'])
                self.assertEqual(a['state'], b['state'])
                self.assertAlmostEqual(a['normalReactionN'], b['normalReactionN'], delta=1e-9)
                np.testing.assert_allclose(q @ np.array(a['frictionForceN']), b['frictionForceN'], atol=1e-9)
                np.testing.assert_allclose(q @ np.array(one['nodes'][1]['displacementM']),
                                           other['nodes'][1]['displacementM'], atol=1e-9)
                self.assertAlmostEqual(a['dissipatedWorkJ'], b['dissipatedWorkJ'], delta=1e-9)
            self.assertEqual(seen, {'stick', 'slip'})
            check_laws(self, plan_r, stiffness_r, {'plane': 0.35}, loads_r, turned)

    def test_pair_swapped_with_reversed_normal(self):
        """Criterion (6): (A, B, n) and (B, A, -n) are the same contact; the force on B changes side."""
        for solver in SOLVERS:
            plan, stiffness, friction = coupled_fixture()
            swapped_plan, _, _ = coupled_fixture(swapped=True)
            one = solve_friction_steps(np, plan, stiffness, 1.0, friction, COUPLED_LOADS, solver=solver)
            other = solve_friction_steps(np, swapped_plan, stiffness, 1.0, friction, COUPLED_LOADS, solver=solver)
            for a_state, b_state in zip(one['states'], other['states'], strict=True):
                for a_node, b_node in zip(a_state['nodes'], b_state['nodes'], strict=True):
                    np.testing.assert_allclose(a_node['displacementM'], b_node['displacementM'], atol=1e-9)
                for a, b in zip(a_state['contacts'], b_state['contacts'], strict=True):
                    sign = -1.0 if a['id'] == 'pair' else 1.0
                    self.assertEqual(a['state'], b['state'])
                    self.assertAlmostEqual(a['normalReactionN'], b['normalReactionN'], delta=1e-9)
                    self.assertAlmostEqual(a['gapM'], b['gapM'], delta=1e-12)
                    np.testing.assert_allclose(sign * np.array(a['frictionForceN']), b['frictionForceN'], atol=1e-9)
                    np.testing.assert_allclose(sign * np.array(a['slipIncrementM']), b['slipIncrementM'], atol=1e-12)
                    self.assertAlmostEqual(a['dissipatedWorkJ'], b['dissipatedWorkJ'], delta=1e-9)

    def test_pair_on_a_fixed_node_equals_the_plane(self):
        """A pair whose node A is fully restrained is the plane contact of node B (criterion (2) values)."""
        for solver in SOLVERS:
            plan, stiffness = spring_fixture()
            plan['contacts'] = [{'id': 'plane', 'kind': 'node-pair', 'nodeA': 1, 'nodeB': 2,
                                 'normal': [1.0, 0.0, 0.0], 'gapM': 0.0}]
            loads = [load_on(2, {2: [-10.0, 0.0, 5.0]})]
            result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, loads, solver=solver)
            contact = result['states'][0]['contacts'][0]
            self.assertAlmostEqual(contact['normalReactionN'], 10.0, delta=1e-10)
            np.testing.assert_allclose(contact['frictionForceN'], [0.0, 0.0, -3.0], atol=1e-10)
            np.testing.assert_allclose(result['states'][0]['nodes'][1]['displacementM'], [0.0, 0.0, 2.0], atol=1e-10)

    def test_tangent_basis(self):
        for normal in ([0, 0, 1], [0, 0, -1], [1, 0, 0], [0.6, 0.8, 0], [1 / math.sqrt(3)] * 3, [0.0, -1.0, 0.0]):
            n = np.array(normal, dtype=float)
            t1, t2 = (np.array(vector) for vector in tangent_basis(normal))
            frame = np.array([n / np.linalg.norm(n), t1, t2])
            np.testing.assert_allclose(frame @ frame.T, np.eye(3), atol=1e-14)
            self.assertAlmostEqual(np.linalg.det(frame), 1.0, delta=1e-14)


class CoupledTests(unittest.TestCase):
    def test_coupled_matrix_laws_and_solver_agreement(self):
        """Criterion (7): coupled stiffness, plane + pair, non-proportional path with stick, slip and opening."""
        plan, stiffness, friction = coupled_fixture()
        results = {}
        for solver in SOLVERS:
            before = copy.deepcopy(plan)
            results[solver] = solve_friction_steps(np, plan, stiffness, 1.0, friction, COUPLED_LOADS, solver=solver)
            self.assertEqual(plan, before)
            states = check_laws(self, plan, stiffness, friction, COUPLED_LOADS, results[solver])
            self.assertEqual(states, {'stick', 'slip', 'open'})
        for a_state, b_state in zip(results['newton']['states'], results['nsgs']['states'], strict=True):
            for a, b in zip(a_state['contacts'], b_state['contacts'], strict=True):
                self.assertEqual(a['state'], b['state'])
                self.assertAlmostEqual(a['normalReactionN'], b['normalReactionN'], delta=1e-8)
                np.testing.assert_allclose(a['frictionForceN'], b['frictionForceN'], atol=1e-8)

    def test_zero_friction_equals_the_frictionless_solver(self):
        """Criterion (1): mu = 0 reproduces beamContact._solve_contact_system (unchanged module)."""
        plan, stiffness, _ = coupled_fixture()
        plan['nodes'][1]['load'] = [3.0, 1.0, -20.0, 0.0, 0.0, 0.0]
        plan['nodes'][2]['load'] = [-12.0, 0.5, 0.4, 0.0, 0.0, 0.0]
        plan['loadFactors'] = [0.0, 0.3, 1.0, -0.5, 2.0]
        frictionless = _solve_contact_system(np, plan, stiffness, 1.0)
        for solver in SOLVERS:
            result = solve_friction_contact_system(np, plan, stiffness, 1.0, {'plane': 0.0, 'pair': 0.0}, solver=solver)
            closed = set()
            for a, b in zip(frictionless['states'], result['states'], strict=True):
                self.assertEqual(a['loadFactor'], b['loadFactor'])
                for a_node, b_node in zip(a['nodes'], b['nodes'], strict=True):
                    np.testing.assert_allclose(a_node['displacementM'], b_node['displacementM'], atol=1e-12, rtol=0)
                for a_contact, b_contact in zip(a['contacts'], b['contacts'], strict=True):
                    self.assertAlmostEqual(a_contact['normalReactionN'], b_contact['normalReactionN'], delta=1e-10)
                    self.assertAlmostEqual(a_contact['gapM'], b_contact['gapM'], delta=1e-12)
                    self.assertEqual(a_contact['state'] == 'closed', b_contact['state'] == 'closed')
                    np.testing.assert_allclose(b_contact['frictionForceN'], [0, 0, 0], atol=0)
                    closed.add(a_contact['state'])
            self.assertEqual(closed, {'open', 'closed'})


class RejectionTests(unittest.TestCase):
    def test_invalid_friction_coefficients(self):
        plan, stiffness = spring_fixture()
        loads = [pressed((0, 0, 1), (2, 0, 0))]
        for friction in ({}, {'plane': -0.1}, {'plane': math.nan}, {'plane': math.inf}, {'plane': True},
                         {'plane': '0.3'}, {'plane': None}, {'plane': 0.3, 'other': 0.3}, None, [0.3]):
            with self.assertRaisesRegex(ValueError, 'friction-coefficient'):
                solve_friction_steps(np, plan, stiffness, 1.0, friction, loads)

    def test_invalid_matrices(self):
        plan, stiffness = spring_fixture()
        loads = [pressed((0, 0, 1), (2, 0, 0))]
        asymmetric = stiffness.copy()
        asymmetric[6, 7] = 0.5
        non_finite = stiffness.copy()
        non_finite[6, 6] = math.nan
        mechanism = stiffness.copy()
        mechanism[7, 7] = 0.0
        indefinite = stiffness.copy()
        indefinite[6:8, 6:8] = [[1.0, 2.0], [2.0, 1.0]]
        cases = ((asymmetric, 'contact-symmetry'), (non_finite, 'contact-numeric'), (mechanism, 'contact-mechanism'),
                 (indefinite, 'contact-mechanism'), (np.zeros((11, 11)), 'friction-stiffness'))
        for matrix, code in cases:
            with self.assertRaisesRegex(ValueError, code):
                solve_friction_steps(np, plan, matrix, 1.0, {'plane': 0.3}, loads)

    def test_dependent_frictional_rows(self):
        plan, stiffness = spring_fixture()
        plan['contacts'].append({'id': 'side', 'kind': 'node-plane', 'node': 2, 'normal': [1.0, 0.0, 0.0],
                                 'gapM': 0.0})
        with self.assertRaisesRegex(ValueError, 'friction-degenerate'):
            solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3, 'side': 0.3}, [pressed((0, 0, 1), (0, 0, 0))])

    def test_restrained_tangent(self):
        plan, stiffness = spring_fixture()
        plan['nodes'][1]['restrained'] = [True, False, False, True, True, True]
        with self.assertRaisesRegex(ValueError, 'friction-restrained'):
            solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, [pressed((0, 0, 1), (0, 0, 0))])

    def test_iteration_limit_is_a_failure(self):
        plan, stiffness, friction = coupled_fixture()
        for solver in SOLVERS:
            with self.assertRaisesRegex(ValueError, 'friction-iteration-limit'):
                solve_friction_steps(np, plan, stiffness, 1.0, friction, COUPLED_LOADS, solver=solver,
                                     max_iterations=1)
        for limit in (0, -1, 1.5, True):
            with self.assertRaisesRegex(ValueError, 'friction-limit'):
                solve_friction_steps(np, plan, stiffness, 1.0, friction, COUPLED_LOADS, max_iterations=limit)

    def test_invalid_loads_and_solver(self):
        plan, stiffness = spring_fixture()
        for loads in ([], [[0.0] * 11], [[math.nan] * 12], [[1e31] + [0.0] * 11], [[0.0] * 12] * 33):
            with self.assertRaisesRegex(ValueError, 'friction-loads'):
                solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, loads)
        with self.assertRaisesRegex(ValueError, 'friction-solver'):
            solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, [[0.0] * 12], solver='penalty')

    def test_acceptance_check_rejects_wrong_states(self):
        """check_step judges a state from the displacement alone, whatever produced it. Spring fixture, kt = kn = 1,
        load (5, 0, -10); each displacement below is the exact equilibrium u = f + p of the given contact force p,
        so only the contact law is wrong."""
        plan, stiffness = spring_fixture()
        problem = FrictionProblem(np, plan, stiffness, 1.0, {'plane': 0.3})
        force = np.array(pressed((0, 0, 1), (5, 0, 0)))[problem.free]
        previous = np.zeros(3)
        cases = (((10.0, -3.0, 0.0), None),                        # the Coulomb solution: slip to x = 2
                 ((10.0, -3.5, 0.0), 'friction-cone'),             # |t| = 3.5 > mu N = 3
                 ((10.0, -2.0, 0.0), 'friction-slip-law'),         # moves (x = 3) with |t| < mu N
                 ((10.0, -1.8, -2.4), 'friction-slip-law'),        # |t| = 3 but not against the slip (3.2, -2.4)
                 ((10.0, 3.0, 0.0), 'friction-slip-law'),          # t along the slip (x = 8)
                 ((8.0, -2.4, 0.0), 'contact-penetration'),        # z = -2
                 ((12.0, -3.6, 0.0), 'contact-complementarity'))   # z = 2 with 12 N
        for p, code in cases:
            p = np.array(p)
            # Rows for this fixture: n = z, t1 = x, t2 = y; K = I, so u = f + R^T p.
            displacement = force + np.array([p[1], p[2], p[0]])
            if code is None:
                residuals = check_step_for(problem, force, displacement, previous, p)
                self.assertLessEqual(residuals['slipLawResidual'], 1e-12)
            else:
                with self.assertRaisesRegex(ValueError, code):
                    check_step_for(problem, force, displacement, previous, p)
        with self.assertRaisesRegex(ValueError, 'contact-equilibrium'):
            check_step_for(problem, force, force + np.array([-3.0, 0.0, 10.0]) + 1e-3, previous,
                           np.array([10.0, -3.0, 0.0]))

    def test_problem_does_not_mutate_inputs(self):
        plan, stiffness = spring_fixture()
        before, matrix = copy.deepcopy(plan), stiffness.copy()
        FrictionProblem(np, plan, stiffness, 1.0, {'plane': 0.3})
        self.assertEqual(plan, before)
        np.testing.assert_array_equal(stiffness, matrix)


class DirectionalScaleRegressionTests(unittest.TestCase):
    """Review counterexamples of 2026-10-29 (Astra, friction-review/counterexamples.py). The expected values are the
    independent spring solutions written in each docstring, not solver output."""

    def test_soft_unloaded_tangent_keeps_the_normal_solution(self):
        """kn = 1e6 N/m, kt = 1e-6 N/m, gap 0, press 10 N, no shear, mu = 0.3. Spring: lambda = 10 N, u = 0, stick.
        The previous Newton stopped at iteration 0 with lambda = 0 and u_z = -1e-5 m (a 10 N penetration) because
        one radius 3 / trace W ~ 1.5e-6 N/m shrank the 10 N normal residual to 1.5e-11 N."""
        plan, stiffness = spring_fixture(kn=1e6, kt=1e-6)
        loads = [pressed((0, 0, 1), (0, 0, 0))]
        for solver in SOLVERS:
            result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, loads, solver=solver)
            contact = result['states'][0]['contacts'][0]
            self.assertEqual(contact['state'], 'stick')
            self.assertAlmostEqual(contact['normalReactionN'], 10.0, delta=1e-10)
            # 1e-14 m at 1e6 N/m is 1e-8 N, the 1e-9 x 10 N acceptance.
            self.assertLessEqual(abs(contact['gapM']), 1e-14)
            np.testing.assert_allclose(contact['frictionForceN'], [0.0, 0.0, 0.0], atol=1e-10)
            np.testing.assert_allclose(result['states'][0]['nodes'][1]['displacementM'], [0, 0, 0], atol=1e-14)
            check_laws(self, plan, stiffness, {'plane': 0.3}, loads, result)

    def test_acceptance_rejects_a_penetration_hidden_by_a_soft_tangent(self):
        """The previous Newton state of the same fixture: lambda = 0, u_z = -1e-5 m. Equilibrium holds exactly
        (K u = f), the gap is -1e-5 m, i.e. the 10 N that kn = 1e6 N/m needs to close it. With the former single
        scale L = max diag W x F = 1e6 m/N x 10 N = 1e7 m the penetration read 1e-12 and passed."""
        plan, stiffness = spring_fixture(kn=1e6, kt=1e-6)
        problem = FrictionProblem(np, plan, stiffness, 1.0, {'plane': 0.3})
        force = np.array(pressed((0, 0, 1), (0, 0, 0)))[problem.free]
        with self.assertRaisesRegex(ValueError, 'contact-penetration'):
            check_step_for(problem, force, np.array([0.0, 0.0, -1e-5]), np.zeros(3), np.zeros(3))
        residuals = check_step_for(problem, force, np.zeros(3), np.zeros(3), np.array([10.0, 0.0, 0.0]))
        self.assertEqual(residuals['penetration'], 0.0)
        self.assertEqual(residuals['slipLawResidual'], 0.0)

    def test_soft_unloaded_tangent_gets_the_coulomb_sliding_force(self):
        """K = diag(1e6, 1e-6, 1e6) N/m (x, y, z), plane z, f = (5, 0, -10) N, mu = 0.3. Springs: lambda = 10 N,
        shear 5 > mu lambda = 3, so slip in +x with friction -3 N and u_x = (5 - 3) / 1e6 = 2e-6 m; y is unloaded."""
        plan, stiffness = spring_fixture(block=np.diag([1e6, 1e-6, 1e6]))
        loads = [load_on(2, {2: [5.0, 0.0, -10.0]})]
        for solver in SOLVERS:
            result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, loads, solver=solver)
            contact = result['states'][0]['contacts'][0]
            self.assertEqual(contact['state'], 'slip')
            self.assertAlmostEqual(contact['normalReactionN'], 10.0, delta=1e-10)
            np.testing.assert_allclose(contact['frictionForceN'], [-3.0, 0.0, 0.0], atol=1e-10)
            # 1e-15 m at 1e6 N/m is 1e-9 N.
            np.testing.assert_allclose(result['states'][0]['nodes'][1]['displacementM'], [2e-6, 0.0, 0.0],
                                       atol=1e-15, rtol=0)
            self.assertAlmostEqual(contact['dissipatedWorkJ'], 3.0 * 2e-6, delta=1e-15)
            check_laws(self, plan, stiffness, {'plane': 0.3}, loads, result)

    def test_in_plane_rotation_of_the_anisotropic_tangent(self):
        """Springs turned by Q = 30 deg about z, K = Q diag(k, 1 / k, k) Q^T N/m, so the tangential block is not
        diagonal in t1, t2; f = Q (5, 0, 0) + (0, 0, -10) N, mu = 0.3. Springs: lambda = 10 N, slip along Q e_x,
        friction Q (-3, 0, 0) N, u = Q (2 / k, 0, 0) m; the state u = Q (3 / k, 0, 0), friction Q (-2, 0, 0) is
        refused. Any returned state must be that spring answer; otherwise the solver must raise ValueError.
        k = 1e3 (cond K = 1e6): NSGS (exact local Coulomb solution) must solve it. Newton stops on |Phi| <= 1e-11 F,
        and with r_t = 2 / trace M ~ 2e-3 N/m the slip-branch Phi barely depends on the direction of a 2e-3 m soft
        slip (r_t |y_t| ~ 4e-6 N against |t| = 3 N), so it may stop about 1e-6 rad off; the independent acceptance
        then refuses it (friction-slip-law) instead of returning it. k = 1e6 (cond K = 1e12): K^-1 itself loses
        about 3e-5 of R^T in double precision, so either solver may be refused (contact-equilibrium)."""
        q = rotation((0.0, 0.0, 1.0), math.pi / 6)
        load = (q @ np.array([5.0, 0.0, 0.0]) + np.array([0.0, 0.0, -10.0])).tolist()
        loads = [load_on(2, {2: load})]
        t1, t2 = (np.array(vector) for vector in tangent_basis([0.0, 0.0, 1.0]))
        for k in (1e3, 1e6):
            plan, stiffness = spring_fixture(block=q @ np.diag([k, 1 / k, k]) @ q.T)
            for solver in SOLVERS:
                try:
                    result = solve_friction_steps(np, plan, stiffness, 1.0, {'plane': 0.3}, loads, solver=solver)
                except ValueError:
                    if k == 1e3 and solver == 'nsgs':
                        raise
                    continue
                contact = result['states'][0]['contacts'][0]
                self.assertEqual(contact['state'], 'slip')
                self.assertAlmostEqual(contact['normalReactionN'], 10.0, delta=1e-10)
                np.testing.assert_allclose(contact['frictionForceN'], q @ np.array([-3.0, 0.0, 0.0]), atol=1e-10)
                # 1e-9 N at k N/m.
                np.testing.assert_allclose(result['states'][0]['nodes'][1]['displacementM'],
                                           q @ np.array([2 / k, 0.0, 0.0]), atol=1e-9 / k, rtol=0)
                check_laws(self, plan, stiffness, {'plane': 0.3}, loads, result)
            problem = FrictionProblem(np, plan, stiffness, 1.0, {'plane': 0.3})
            wrong = q @ np.array([-2.0, 0.0, 0.0])
            # K u is formed from K itself (no inverse), so the equilibrium of this state is exact to rounding.
            with self.assertRaisesRegex(ValueError, 'friction-slip-law'):
                check_step_for(problem, np.array(load), q @ np.array([3 / k, 0.0, 0.0]), np.zeros(3),
                               np.array([10.0, wrong @ t1, wrong @ t2]), math.sqrt(125.0))

    def test_acceptance_rejects_wrong_sliding_friction(self):
        """Same springs. u = (3e-6, 0, 0) m with p = (lambda, t1, t2) = (10, -2, 0) N is an exact equilibrium
        (1e6 x 3e-6 = 5 - 2), but the contact moved while |t| = 2 < mu lambda = 3: not Coulomb. The 3 N solution
        u = (2e-6, 0, 0) m passes. With the former L = 1e6 x 11.18 m the 3e-6 m slip counted as zero and the 1 N
        friction error (0.089 F) passed."""
        plan, stiffness = spring_fixture(block=np.diag([1e6, 1e-6, 1e6]))
        problem = FrictionProblem(np, plan, stiffness, 1.0, {'plane': 0.3})
        force = np.array(load_on(2, {2: [5.0, 0.0, -10.0]}))[problem.free]
        scale = math.sqrt(125.0)  # |f|
        with self.assertRaisesRegex(ValueError, 'friction-slip-law'):
            check_step_for(problem, force, np.array([3e-6, 0.0, 0.0]), np.zeros(3), np.array([10.0, -2.0, 0.0]),
                           scale)
        residuals = check_step_for(problem, force, np.array([2e-6, 0.0, 0.0]), np.zeros(3),
                                   np.array([10.0, -3.0, 0.0]), scale)
        self.assertLessEqual(residuals['slipLawResidual'], 1e-12)
        self.assertLessEqual(residuals['equilibriumResidual'], 1e-12)

    def test_non_finite_inputs_are_rejected(self):
        """K = I, f = (5, 0, -10), u = (3, 0, 0), p = (10, -2, 0) with previous = (NaN, 0, 0) used to return all
        residuals 0 and dissipation [NaN] (NaN > threshold is false and max(0.0, nan) is 0.0)."""
        plan, stiffness = spring_fixture()
        problem = FrictionProblem(np, plan, stiffness, 1.0, {'plane': 0.3})
        force, displacement = np.array([5.0, 0.0, -10.0]), np.array([3.0, 0.0, 0.0])
        previous, p = np.zeros(3), np.array([10.0, -2.0, 0.0])
        nan_previous = np.array([math.nan, 0.0, 0.0])
        cases = ((force, displacement, nan_previous, p, 10.0),
                 (force, displacement, np.array([math.inf, 0.0, 0.0]), p, 10.0),
                 (force, np.array([3.0, math.nan, 0.0]), previous, p, 10.0),
                 (np.array([5.0, 0.0, -math.inf]), displacement, previous, p, 10.0),
                 (force, displacement, previous, np.array([10.0, math.nan, 0.0]), 10.0),
                 (force, displacement, previous[:2], p, 10.0),
                 (force, displacement, [0.0, 0.0, 0.0], p, 10.0),
                 (force, displacement, np.array([False, False, False]), p, 10.0),
                 (force, displacement, previous, p, math.nan),
                 (force, displacement, previous, p, math.inf),
                 (force, displacement, previous, p, 0.0),
                 (force, displacement, previous, p, -10.0),
                 (force, displacement, previous, p, True))
        for case in cases:
            with self.assertRaisesRegex(ValueError, 'contact-numeric'):
                check_step(np, problem, *case)

    def test_non_finite_dissipation_is_rejected(self):
        """Finite inputs whose increment overflows: delta_s = (+inf, -inf), t = (-3, -3), so -t . delta_s is
        -inf + inf = NaN. It must be refused, not hidden behind max(0.0, nan)."""
        plan, stiffness = spring_fixture()
        problem = FrictionProblem(np, plan, stiffness, 1.0, {'plane': 0.3})
        with np.errstate(over='ignore', invalid='ignore'):
            with self.assertRaisesRegex(ValueError, 'friction-dissipation'):
                check_step_for(problem, np.array([5.0, 0.0, -10.0]), np.array([1e308, -1e308, 0.0]),
                               np.array([-1e308, 1e308, 0.0]), np.array([10.0, -3.0, -3.0]))


class IndependentContactScaleTests(unittest.TestCase):
    """Uncoupled springs: fixed hand solutions, not values derived from either solver."""

    @staticmethod
    def fixture(gap_b):
        plan, _ = spring_fixture(kn=1e6, kt=1e6)
        plan['originalNodeCount'] = 3
        plan['nodes'].append(node(3, [2.0, 0.0, 0.0], True))
        plan['contacts'].append({'id': 'other', 'kind': 'node-plane', 'node': 3,
                                 'normal': [0.0, 0.0, 1.0], 'gapM': gap_b})
        stiffness = np.zeros((18, 18))
        stiffness[6:9, 6:9] = 1e6 * np.eye(3)
        stiffness[12:15, 12:15] = 1e13 * np.eye(3)
        return plan, stiffness, {'plane': 0.3, 'other': 0.3}

    def test_open_unloaded_contact_does_not_change_the_ten_newton_solution(self):
        """A: K=1e6 I, gap=0, fz=-10 N. B: K=1e13 I, gap=1 m, f=0.
        Exact A lambda=10 N/u=0, B lambda=0/u=0. B's gap is not a 1e13 N applied load.
        Both solvers MUST return these values; an exception is not a passing outcome."""
        plan, stiffness, friction = self.fixture(1.0)
        load = load_on(3, {2: [0.0, 0.0, -10.0]})
        single, single_k = spring_fixture(kn=1e6, kt=1e6)
        for solver in SOLVERS:
            with self.subTest(solver=solver):
                result = solve_friction_steps(np, plan, stiffness, 1.0, friction, [load], solver=solver)
                state = result['states'][0]
                a, b = state['contacts']
                self.assertEqual(a['state'], 'stick')
                self.assertAlmostEqual(a['normalReactionN'], 10.0, delta=1e-10)
                self.assertLessEqual(abs(a['gapM']), 1e-14)
                self.assertEqual(b['state'], 'open')
                self.assertEqual(b['normalReactionN'], 0.0)
                self.assertEqual(b['gapM'], 1.0)
                self.assertAlmostEqual(state['forceScaleN'], 10.0, delta=1e-10)
                for row in state['nodes']:
                    np.testing.assert_allclose(row['displacementM'], [0.0, 0.0, 0.0], atol=1e-14, rtol=0)
                reference = solve_friction_steps(np, single, single_k, 1.0, {'plane': 0.3},
                                                 [load_on(2, {2: [0.0, 0.0, -10.0]})], solver=solver)
                self.assertAlmostEqual(a['normalReactionN'],
                                       reference['states'][0]['contacts'][0]['normalReactionN'], delta=1e-10)

    def test_open_unloaded_contact_cannot_relax_independent_acceptance(self):
        """The old false success p_A=0, u_Az=-1e-5 m balances the load but penetrates by 10 N / 1e6 N/m.
        Adding B or passing the old large reporting F cannot make this state acceptable."""
        plan, stiffness, friction = self.fixture(1.0)
        problem = FrictionProblem(np, plan, stiffness, 1.0, friction)
        force = np.array([0.0, 0.0, -10.0, 0.0, 0.0, 0.0])
        bad = np.array([0.0, 0.0, -1e-5, 0.0, 0.0, 0.0])
        for reporting_scale in (10.0, 1e13):
            with self.assertRaisesRegex(ValueError, 'contact-penetration'):
                check_step(np, problem, force, bad, np.zeros(6), np.zeros(6), reporting_scale)
            accepted = check_step(np, problem, force, np.zeros(6), np.zeros(6),
                                  np.array([10.0, 0.0, 0.0, 0.0, 0.0, 0.0]), reporting_scale)
            self.assertEqual(accepted['penetration'], 0.0)

    def test_independent_large_load_cannot_hide_small_contact_slip(self):
        """The one additional scale contrast: B gap=0, fz=-1e13 N, K=1e13 I.
        A f=(5,0,-10), K=1e6 I: lambda=10, t_x=-3, u_x=(5-3)/1e6=2e-6, work=6e-6 J.
        B: lambda=1e13 N, u=0. No force, motion or tolerance transfers between the two blocks."""
        plan, stiffness, friction = self.fixture(0.0)
        load = load_on(3, {2: [5.0, 0.0, -10.0], 3: [0.0, 0.0, -1e13]})
        for solver in SOLVERS:
            with self.subTest(solver=solver):
                result = solve_friction_steps(np, plan, stiffness, 1.0, friction, [load], solver=solver)
                state = result['states'][0]
                a, b = state['contacts']
                self.assertEqual(a['state'], 'slip')
                self.assertAlmostEqual(a['normalReactionN'], 10.0, delta=1e-10)
                np.testing.assert_allclose(a['frictionForceN'], [-3.0, 0.0, 0.0], atol=1e-10, rtol=0)
                np.testing.assert_allclose(state['nodes'][1]['displacementM'], [2e-6, 0.0, 0.0],
                                           atol=1e-14, rtol=0)
                self.assertAlmostEqual(a['dissipatedWorkJ'], 6e-6, delta=1e-15)
                self.assertEqual(b['state'], 'stick')
                self.assertAlmostEqual(b['normalReactionN'] / 1e13, 1.0, delta=1e-12)
                np.testing.assert_allclose(state['nodes'][2]['displacementM'], [0.0, 0.0, 0.0],
                                           atol=1e-12, rtol=0)

    def test_large_load_cannot_mask_local_law_or_force_balance_errors(self):
        """Same extra fixture, exact B solution. A's 10 N penetration, 1 N slip-law error, 1 N cone excess and
        1 N equilibrium error are rejected independently, despite the reporting F=1e13 N."""
        plan, stiffness, friction = self.fixture(0.0)
        problem = FrictionProblem(np, plan, stiffness, 1.0, friction)
        force = np.array([5.0, 0.0, -10.0, 0.0, 0.0, -1e13])
        cases = (
            ('contact-penetration', [5e-6, 0.0, -1e-5], [0.0, 0.0, 0.0]),
            ('friction-slip-law', [3e-6, 0.0, 0.0], [10.0, -2.0, 0.0]),
            ('friction-cone', [1e-6, 0.0, 0.0], [10.0, -4.0, 0.0]),
            ('contact-equilibrium', [3e-6, 0.0, 0.0], [10.0, -3.0, 0.0]),
        )
        for reason, motion_a, force_a in cases:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(ValueError, reason):
                    check_step(np, problem, force, np.array(motion_a + [0.0, 0.0, 0.0]), np.zeros(6),
                               np.array(force_a + [1e13, 0.0, 0.0]), 1e13)
        accepted = check_step(np, problem, force, np.array([2e-6, 0.0, 0.0, 0.0, 0.0, 0.0]), np.zeros(6),
                              np.array([10.0, -3.0, 0.0, 1e13, 0.0, 0.0]), 1e13)
        self.assertLessEqual(accepted['slipLawResidual'], 1e-12)
        self.assertLessEqual(accepted['equilibriumResidual'], 1e-12)


class CancellationEquilibriumTests(unittest.TestCase):
    """Two identical translational springs in series, k = 1e6 N/m, with a tip plane.
    K_free = k [[2 I, -I], [-I, I]] follows directly from their elastic energies.
    Tip pressure 10 N is fully balanced by contact, so both Y displacements are zero.
    A net tip X force T gives u_mid = T/k and u_tip = 2T/k, independently of the solver.
    """

    @staticmethod
    def fixture():
        plan = {'originalNodeCount': 3,
                'nodes': [node(1, [0.0, 0.0, 0.0], False), node(2, [0.5, 0.0, 0.0], True),
                          node(3, [1.0, 0.0, 0.0], True)],
                'contacts': [{'id': 'plane', 'kind': 'node-plane', 'node': 3,
                              'normal': [0.0, 1.0, 0.0], 'gapM': 0.0}]}
        stiffness = np.zeros((18, 18))
        stiffness[6:9, 6:9] = 2e6 * np.eye(3)
        stiffness[6:9, 12:15] = -1e6 * np.eye(3)
        stiffness[12:15, 6:9] = -1e6 * np.eye(3)
        stiffness[12:15, 12:15] = 1e6 * np.eye(3)
        return plan, stiffness

    def test_cancelled_pressure_preserves_unloaded_interior_equilibrium(self):
        loads = [load_on(3, {3: values}) for values in
                 ([2.0, -10.0, 0.0], [5.0, -10.0, 0.0], [0.0, 0.0, 0.0], [-5.0, -10.0, 0.0])]
        for solver in SOLVERS:
            with self.subTest(solver=solver):
                plan, stiffness = self.fixture()
                result = solve_friction_steps(np, plan, stiffness, 0.5, {'plane': 0.3}, loads, solver=solver)
                self.assertEqual(len(result['states']), 4)
                for state, normal, friction_x, net_x, status in zip(
                        result['states'], (10.0, 10.0, 0.0, 10.0), (-2.0, -3.0, 0.0, 3.0),
                        (0.0, 2.0, 0.0, -2.0), ('stick', 'slip', 'open', 'slip'), strict=True):
                    contact = state['contacts'][0]
                    self.assertEqual(contact['state'], status)
                    self.assertAlmostEqual(contact['normalReactionN'], normal, delta=1e-9 * 10.0)
                    np.testing.assert_allclose(contact['frictionForceN'], [friction_x, 0.0, 0.0],
                                               rtol=0, atol=1e-9 * 10.0)
                    for row, factor in zip(state['nodes'], (0, 1, 2), strict=True):
                        np.testing.assert_allclose(row['displacementM'], [factor * net_x / 1e6, 0.0, 0.0],
                                                   rtol=0, atol=1e-9 * (10.0 / 1e6))
                        self.assertEqual(row['rotationRad'], [0.0, 0.0, 0.0])
                    self.assertLessEqual(state['equilibriumResidual'], 1e-9)
                check_laws(self, plan, stiffness, {'plane': 0.3}, loads, result)

    def test_tiny_unbalanced_load_or_interior_motion_still_fails(self):
        plan, stiffness = self.fixture()
        problem = FrictionProblem(np, plan, stiffness, 0.5, {'plane': 0.3})
        force = np.array([0.0, 0.0, 0.0, 0.0, -10.0, 0.0])
        p = np.array([10.0, 0.0, 0.0])
        accepted = check_step(np, problem, force, np.zeros(6), np.zeros(6), p, 10.0)
        self.assertEqual(accepted['equilibriumResidual'], 0.0)
        # A global 10 N floor would mask these 1e-12 N / 1e-20 m errors. Keep the componentwise rejection.
        tiny_load = force.copy()
        tiny_load[0] = 1e-12
        bad_motion = np.zeros(6)
        bad_motion[1] = 1e-20
        for load, motion in ((tiny_load, np.zeros(6)), (force, bad_motion)):
            with self.assertRaisesRegex(ValueError, 'contact-equilibrium'):
                check_step(np, problem, load, motion, np.zeros(6), p, 10.0)



if __name__ == '__main__':
    unittest.main()
