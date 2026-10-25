"""Pure NumPy checks of solidModal.py (no OOFEM). Root runs: python -B -X utf8 test_solidModal.py next to solidModal.py.

The element stiffness used here is an independent closed-form linear-tetrahedron stiffness (B^T D B V), not OOFEM's;
eigenpairs are manufactured with a known spectrum. Native OOFEM element matrices are exercised only by run_solid_modal.
The r148 regressions (class SolidModalPlanR148) each name the r147 behaviour they replace.
"""
import copy
import itertools
import json
import math
import tracemalloc
import unittest

import numpy as np

import solidModal as sm


def tet_stiffness(points, young, poisson):
    """Constant-strain tetrahedron stiffness, DOF order (u, v, w) per node."""
    coordinates = np.hstack([np.ones((4, 1)), np.asarray(points, dtype=float)])
    volume = np.linalg.det(coordinates) / 6
    gradients = np.linalg.inv(coordinates)[1:, :]  # d N_i / d x, y, z
    strain = np.zeros((6, 12))
    for node in range(4):
        dx, dy, dz = gradients[:, node]
        c = 3 * node
        strain[0, c], strain[1, c + 1], strain[2, c + 2] = dx, dy, dz
        strain[3, c], strain[3, c + 1] = dy, dx
        strain[4, c + 1], strain[4, c + 2] = dz, dy
        strain[5, c], strain[5, c + 2] = dz, dx
    lam = young * poisson / ((1 + poisson) * (1 - 2 * poisson))
    mu = young / (2 * (1 + poisson))
    elasticity = np.zeros((6, 6))
    elasticity[:3, :3] = lam
    elasticity[np.arange(3), np.arange(3)] += 2 * mu
    elasticity[np.arange(3, 6), np.arange(3, 6)] = mu
    return strain.T @ elasticity @ strain * volume, volume


UNIT_TET = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0]]
# 7850 kg/m^3 written directly in t/mm^3; the native module no longer converts units.
STEEL = {'young': 205000.0, 'poisson': 0.3, 'density': 7.85e-9}


def single_tet():
    stiffness, volume = tet_stiffness(UNIT_TET, STEEL['young'], STEEL['poisson'])
    mass = sm.consistent_tet4_mass(np, STEEL['density'], volume)
    return stiffness, mass, volume


def manufactured(size, values, seed):
    """K, M with M SPD and a known generalized spectrum: K = M V diag(values) V^T M, V^T M V = I."""
    generator = np.random.default_rng(seed)
    a = generator.standard_normal((size, size))
    mass = a @ a.T + size * np.eye(size)
    factor = np.linalg.cholesky(mass)
    q, _ = np.linalg.qr(generator.standard_normal((size, size)))
    vectors = np.linalg.solve(factor.T, q)
    stiffness = mass @ vectors @ np.diag(values) @ vectors.T @ mass
    return (stiffness + stiffness.T) / 2, (mass + mass.T) / 2


def block_mesh(nx, ny, nz, edge=10.0):
    """Conforming Kuhn split of nx x ny x nz cubes into six tets each, every tet in positive node order."""
    def index(i, j, k):
        return (i * (ny + 1) + j) * (nz + 1) + k
    nodes = [[i * edge, j * edge, k * edge] for i in range(nx + 1) for j in range(ny + 1) for k in range(nz + 1)]
    elements = []
    for i, j, k in itertools.product(range(nx), range(ny), range(nz)):
        for order in itertools.permutations(range(3)):
            corner = [i, j, k]
            tet = [index(*corner)]
            for axis in order:
                corner[axis] += 1
                tet.append(index(*corner))
            if sm.tet4_volume([nodes[n] for n in tet]) < 0:
                tet[1], tet[2] = tet[2], tet[1]
            elements.append(tet)
    return nodes, elements


def assemble(nodes, elements):
    size = 3 * len(nodes)
    stiffness, mass = np.zeros((size, size)), np.zeros((size, size))
    for tet in elements:
        local_k, volume = tet_stiffness([nodes[n] for n in tet], STEEL['young'], STEEL['poisson'])
        indices = [3 * node + axis for node in tet for axis in range(3)]
        stiffness[np.ix_(indices, indices)] += local_k
        mass[np.ix_(indices, indices)] += sm.consistent_tet4_mass(np, STEEL['density'], volume)
    return stiffness, mass


def plan(**changes):
    value = {'schema': sm.PLAN_SCHEMA, 'source': {'documentId': 'doc', 'revision': 1, 'meshKey': 'tet:1'},
             'units': 'N-mm-MPa-t-s', 'numericBudgetBytes': 10_000_000, 'nodes': copy.deepcopy(UNIT_TET),
             'elements': [{'nodes': [0, 1, 2, 3], 'materialId': 'steel'}],
             'materials': [{'id': 'steel', 'youngMPa': 205000.0, 'poisson': 0.3, 'densityTPerMm3': 7.85e-9}],
             'fixed': [[True, True, True] for _ in range(3)] + [[False, False, False]], 'modeCount': 3}
    value.update(copy.deepcopy(changes))
    return value


class SolidModalCore(unittest.TestCase):
    def test_manufactured_restrained_spectrum_is_recovered_with_mass_normalization(self):
        values = np.array([4.0, 9.0, 25.0, 49.0, 100.0, 400.0, 900.0, 1600.0])
        # One restrained DOF on a 3-node layout; the manufactured free 8 x 8 block is embedded in 9 x 9.
        full_k, full_m = np.eye(9), np.eye(9)
        free = np.arange(1, 9)
        k8, m8 = manufactured(8, values, 11)
        full_k[np.ix_(free, free)], full_m[np.ix_(free, free)] = k8, m8
        positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
        fixed = [[True, False, False], [False, False, False], [False, False, False]]
        result = sm.solve_solid_modal(np, positions, [], fixed, full_k, full_m, 4)
        np.testing.assert_allclose(result['eigenvalues'], values[:4], rtol=1e-9)
        self.assertEqual(result['rigidBodyModes'], 0)
        self.assertEqual(result['freeDofs'], 8)
        self.assertLessEqual(result['maximumMassOrthogonalityError'], 1e-8)
        self.assertTrue(all(r <= 1e-8 for r in result['residuals']))
        modes = result['massNormalizedModes']
        np.testing.assert_allclose(modes[free].T @ m8 @ modes[free], np.eye(4), atol=1e-8)
        self.assertTrue(np.all(modes[0] == 0), 'restrained DOF stays zero')

    def test_free_free_tet_has_six_rigid_modes_projected_and_six_elastic_modes(self):
        stiffness, mass, _ = single_tet()
        positions = UNIT_TET
        fixed = [[False] * 3 for _ in range(4)]
        result = sm.solve_solid_modal(np, positions, [[0, 1, 2, 3]], fixed, stiffness, mass, 6)
        self.assertEqual(result['rigidBodyModes'], 6)
        self.assertLessEqual(result['maximumRigidMotionResidual'], 1e-10)
        self.assertTrue(np.all(result['eigenvalues'] > 0))
        # Independent check: the six elastic eigenvalues equal the nonzero generalized eigenvalues of (K, M).
        factor = np.linalg.cholesky(mass)
        whitened = np.linalg.solve(factor, np.linalg.solve(factor, stiffness).T).T
        reference = np.sort(np.linalg.eigvalsh((whitened + whitened.T) / 2))[6:]
        np.testing.assert_allclose(np.sort(result['eigenvalues']), reference, rtol=1e-8)
        with self.assertRaisesRegex(ValueError, 'more modes requested'):
            sm.solve_solid_modal(np, positions, [[0, 1, 2, 3]], fixed, stiffness, mass, 7)

    def test_supported_tet_with_only_one_fixed_node_is_a_refused_mechanism(self):
        stiffness, mass, _ = single_tet()
        fixed = [[True, True, True]] + [[False] * 3 for _ in range(3)]
        with self.assertRaisesRegex(ValueError, 'solid-modal-mechanism'):
            sm.solve_solid_modal(np, UNIT_TET, [[0, 1, 2, 3]], fixed, stiffness, mass, 1)

    def test_unrestrained_disconnected_mesh_is_refused(self):
        stiffness, mass, _ = single_tet()
        k = np.zeros((24, 24)); m = np.zeros((24, 24))
        k[:12, :12], k[12:, 12:] = stiffness, stiffness
        m[:12, :12], m[12:, 12:] = mass, mass
        positions = UNIT_TET + [[x + 100, y, z] for x, y, z in UNIT_TET]
        fixed = [[False] * 3 for _ in range(8)]
        with self.assertRaisesRegex(ValueError, 'one connected solid'):
            sm.solve_solid_modal(np, positions, [[0, 1, 2, 3], [4, 5, 6, 7]], fixed, k, m, 1)

    def test_consistent_mass_check_accepts_only_the_closed_form(self):
        _, mass, volume = single_tet()
        density = STEEL['density']
        self.assertAlmostEqual(float(np.sum(mass[0::3, 0::3])), density * volume, delta=density * volume * 1e-12)
        self.assertLessEqual(sm.check_element_mass(np, mass, density, volume), 1e-12)
        lumped = np.eye(12) * density * volume / 4
        with self.assertRaisesRegex(ValueError, 'not the consistent tet4 mass'):
            sm.check_element_mass(np, lumped, density, volume)
        with self.assertRaisesRegex(ValueError, 'not the consistent tet4 mass'):
            sm.check_element_mass(np, mass * 1e9, density, volume)  # kg/m^3 not converted to t/mm^3

    def test_deck_writes_the_plan_density_in_tonne_per_cubic_millimetre_unchanged(self):
        deck = sm._deck(plan())
        line = next(row for row in deck.splitlines() if row.startswith('IsoLE 1 '))
        self.assertEqual(float(line.split()[3]), 7.85e-9)
        self.assertNotIn(' d 0 ', deck)
        self.assertEqual(sum(row.startswith('node ') for row in deck.splitlines()), 4)

    def test_plan_validation_refuses_before_any_native_work(self):
        # The seven r147 refusal cases carried to plan/2 (density in t/mm^3, plan units N-mm-MPa-t-s).
        sm.validate_plan(plan())
        material = {'id': 'steel', 'youngMPa': 205000.0, 'poisson': 0.3, 'densityTPerMm3': 7.85e-9}
        for bad, pattern in [
            (plan(materials=[dict(material, densityTPerMm3=0.0)]), '0 < density'),
            (plan(materials=[dict(material, poisson=0.5)]), 'nu < 0.5'),
            (plan(modeCount=21), '1 to 20 modes'),
            (plan(numericBudgetBytes=1000), 'budget'),
            (plan(schema='pointercad-solid-tet4-plan/1'), 'unknown plan schema'),
            (plan(units='SI'), 'N-mm-MPa-t-s'),
            (plan(elements=[{'nodes': [0, 2, 1, 3], 'materialId': 'steel'}]), 'positive in node order'),
        ]:
            with self.assertRaisesRegex(ValueError, pattern):
                sm.validate_plan(bad)

    def test_four_times_density_halves_frequencies_and_mass_normalized_vectors(self):
        # K unchanged, M x 4: lambda / 4, f / 2 and phi / 2, because (phi / 2)^T (4 M) (phi / 2) = 1.
        # phi is in 1/sqrt(t), not mm; a length would not change with density.
        stiffness, mass, volume = single_tet()
        heavy = sm.consistent_tet4_mass(np, 4 * STEEL['density'], volume)
        free = [[False] * 3 for _ in range(4)]
        base = sm.solve_solid_modal(np, UNIT_TET, [[0, 1, 2, 3]], free, stiffness, mass, 6)
        dense = sm.solve_solid_modal(np, UNIT_TET, [[0, 1, 2, 3]], free, stiffness, heavy, 6)
        np.testing.assert_allclose(np.sqrt(dense['eigenvalues']), np.sqrt(base['eigenvalues']) / 2, rtol=1e-10)
        # All six elastic modes: Phi Phi^T is independent of signs and of the basis inside degenerate clusters.
        projector = base['massNormalizedModes'] @ base['massNormalizedModes'].T
        np.testing.assert_allclose(dense['massNormalizedModes'] @ dense['massNormalizedModes'].T, projector / 4,
                                   rtol=0, atol=1e-10 * float(np.max(np.abs(projector))))
        # Distinct manufactured spectrum: every vector is the same up to its sign, halved.
        full_k, full_m = np.eye(9), np.eye(9)
        k8, m8 = manufactured(8, np.array([4.0, 9.0, 25.0, 49.0, 100.0, 400.0, 900.0, 1600.0]), 11)
        full_k[1:, 1:], full_m[1:, 1:] = k8, m8
        fixed = [[True, False, False], [False, False, False], [False, False, False]]
        positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
        light = sm.solve_solid_modal(np, positions, [], fixed, full_k, full_m, 4)
        weighted = sm.solve_solid_modal(np, positions, [], fixed, full_k, 4 * full_m, 4)
        np.testing.assert_allclose(weighted['eigenvalues'], light['eigenvalues'] / 4, rtol=1e-9)
        scale = float(np.max(np.abs(light['massNormalizedModes'])))
        np.testing.assert_allclose(np.abs(weighted['massNormalizedModes']), np.abs(light['massNormalizedModes']) / 2,
                                   rtol=0, atol=1e-9 * scale)


class SolidModalPlanR148(unittest.TestCase):
    def refuse(self, value, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            sm.validate_plan(value)

    def test_valid_plan_returns_densities_and_the_reservation(self):
        checked, densities, reserved = sm.validate_plan(plan())
        self.assertEqual(densities, {'steel': 7.85e-9})
        self.assertEqual(reserved, sm.dense_modal_bytes(12))
        self.assertIs(checked['fixed'][3][0], False)
        self.assertEqual(sm.validate_plan(sm.parse_plan(json.dumps(plan())))[2], reserved)

    def test_r147_plan_shape_and_unknown_or_missing_fields_are_refused(self):
        # r147 read data['nodes'] etc. from an embedded input and ignored every unexpected key.
        r147 = {'schema': 'pointercad-solid-tet4-modal-plan/1', 'input': plan(), 'fixed': [], 'modeCount': 1}
        self.refuse(r147, 'plan requires exactly the fields')
        self.refuse(plan(schema='pointercad-solid-tet4-modal-plan/1'), 'unknown plan schema')
        self.refuse(plan(units='N-mm-MPa'), 'N-mm-MPa-t-s')
        self.refuse(dict(plan(), extra=1), 'plan requires exactly the fields')
        missing = plan()
        del missing['fixed']
        self.refuse(missing, 'plan requires exactly the fields')
        self.refuse(plan(source={'documentId': 'doc', 'revision': 1, 'meshKey': 'tet:1', 'x': 0}), 'source requires')
        self.refuse(plan(materials=[{'id': 'steel', 'youngMPa': 205000.0, 'poisson': 0.3, 'densityKgM3': 7850.0}]),
                    'material requires')
        self.refuse(plan(elements=[{'nodes': [0, 1, 2, 3], 'materialId': 'steel', 'group': 1}]), 'element requires')

    def test_strict_json_refuses_non_finite_tokens_and_repeated_keys(self):
        # json.loads defaults accept NaN/Infinity and keep the last of repeated keys silently.
        text = json.dumps(plan())
        with self.assertRaisesRegex(ValueError, 'non-finite JSON token NaN'):
            sm.parse_plan(text.replace('10.0', 'NaN', 1))
        with self.assertRaisesRegex(ValueError, 'non-finite JSON token -Infinity'):
            sm.parse_plan(text.replace('10.0', '-Infinity', 1))
        with self.assertRaisesRegex(ValueError, 'duplicate JSON key'):
            sm.parse_plan(text.replace('"modeCount": 3', '"modeCount": 3, "modeCount": 1'))

    def test_every_coordinate_is_finite_and_every_node_is_used_before_allocation(self):
        # r147 checked only coordinates reached through elements and found unused nodes after dense allocation.
        nodes = copy.deepcopy(UNIT_TET) + [[float('nan'), 0.0, 0.0]]
        self.refuse(plan(nodes=nodes, fixed=[[True] * 3] * 3 + [[False] * 3] * 2), 'finite node coordinates')
        nodes[4] = [1.0, 1.0, 1.0]
        self.refuse(plan(nodes=nodes, fixed=[[True] * 3] * 3 + [[False] * 3] * 2), 'every node must belong')
        self.refuse(plan(nodes=copy.deepcopy(UNIT_TET[:3]) + [[0.0, 0.0, True]]), 'finite node coordinates')
        self.refuse(plan(nodes=copy.deepcopy(UNIT_TET[:3]) + [[0.0, 0.0]]), 'three coordinates')
        # Finite but overflowing coordinates give an infinite volume, which r147 accepted as positive.
        self.refuse(plan(nodes=[[v * 1e120 for v in point] for point in UNIT_TET]), 'finite and positive')

    def test_strict_restraint_rows_and_node_index_masks(self):
        self.refuse(plan(fixed=[[1, 1, 1]] * 3 + [[0, 0, 0]]), 'three boolean translations')
        self.refuse(plan(fixed=[[True, True]] * 3 + [[False, False]]), 'three boolean translations')
        self.refuse(plan(fixed=[[True] * 3] * 3), 'fixed must be a list of 4 to 4')
        for ids in ([0, 1, 2, True], [0, 1, 2, 3.0], [0, 1, 2, 4], [0, 1, 2, -1], [0, 1, 2, 2], [0, 1, 2]):
            self.refuse(plan(elements=[{'nodes': ids, 'materialId': 'steel'}]), 'invalid tet4 node indices')
        self.refuse(plan(elements=[{'nodes': [0, 1, 2, 3], 'materialId': ['steel']}]), 'unknown element material')
        self.refuse(plan(elements=[{'nodes': [0, 1, 2, 3], 'materialId': 'steel'},
                                   {'nodes': [1, 2, 3, 0], 'materialId': 'steel'}]), 'duplicate tetrahedron')
        self.refuse(plan(elements=[{'nodes': [0, 2, 1, 3], 'materialId': 'steel'}]), 'finite and positive')
        self.refuse(plan(source={'documentId': 'doc', 'revision': True, 'meshKey': 'tet:1'}), 'source revision')

    def test_units_density_and_materials_are_checked_in_native_units(self):
        self.refuse(plan(materials=[{'id': 'steel', 'youngMPa': 205000.0, 'poisson': 0.3, 'densityTPerMm3': 7850.0}]),
                    'density <= 1e-7')  # an unconverted kg/m^3 number
        for density in (0.0, -7.85e-9):
            self.refuse(plan(materials=[{'id': 'steel', 'youngMPa': 205000.0, 'poisson': 0.3,
                                         'densityTPerMm3': density}]), '0 < density')
        self.refuse(plan(materials=[{'id': 'steel', 'youngMPa': True, 'poisson': 0.3, 'densityTPerMm3': 7.85e-9}]),
                    'finite Young modulus')
        twice = [{'id': 'steel', 'youngMPa': 205000.0, 'poisson': 0.3, 'densityTPerMm3': 7.85e-9}] * 2
        self.refuse(plan(materials=twice), 'duplicate material id')

    def test_mode_count_and_applicability_are_refused_before_allocation(self):
        self.refuse(plan(modeCount=4), 'more modes requested')  # three free DOFs
        self.refuse(plan(modeCount=0), '1 to 20 modes')
        self.refuse(plan(modeCount=3.0), '1 to 20 modes')
        self.refuse(plan(fixed=[[True] * 3] * 4), 'more modes requested')
        free = [[False] * 3 for _ in range(4)]
        self.assertEqual(sm.validate_plan(plan(fixed=free, modeCount=6))[0]['modeCount'], 6)
        self.refuse(plan(fixed=free, modeCount=7), 'more modes requested')
        two = plan(nodes=UNIT_TET + [[x + 100, y, z] for x, y, z in UNIT_TET], fixed=[[False] * 3] * 8, modeCount=1,
                   elements=[{'nodes': [0, 1, 2, 3], 'materialId': 'steel'},
                             {'nodes': [4, 5, 6, 7], 'materialId': 'steel'}])
        self.refuse(two, 'one connected solid')

    def test_budget_is_the_enumerated_dense_reservation(self):
        reserved = sm.dense_modal_bytes(12)
        self.assertEqual(reserved, (14 * 144 + 160 * 12 + 4096) * 8)
        sm.validate_plan(plan(numericBudgetBytes=reserved))
        self.refuse(plan(numericBudgetBytes=reserved - 1), 'dense modal reservation exceeded')
        self.refuse(plan(numericBudgetBytes=float(reserved)), 'explicit integer reservation')

    def test_measured_dense_peak_exceeds_the_r147_six_array_claim_and_fits_the_reservation(self):
        tracemalloc.start()
        try:
            probe = np.empty(1 << 17)
            self.assertGreaterEqual(tracemalloc.get_traced_memory()[0], 8 << 17,
                                    'tracemalloc must see NumPy data buffers for this measurement')
            del probe
            nodes, elements = block_mesh(2, 2, 4)  # 45 nodes, s = 135
            size = 3 * len(nodes)
            stiffness, mass = assemble(nodes, elements)
            supported = [[point[2] == 0.0] * 3 for point in nodes]
            free_free = [[False] * 3 for _ in nodes]
            for fixed in (supported, free_free):
                tracemalloc.reset_peak()
                base = tracemalloc.get_traced_memory()[0]
                held_k, held_m = stiffness.copy(), mass.copy()  # the arrays run_solid_modal keeps alive
                result = sm.solve_solid_modal(np, nodes, elements, fixed, held_k, held_m, 6)
                peak = tracemalloc.get_traced_memory()[1] - base
                del held_k, held_m, result
                self.assertGreater(peak, (6 * size * size + 64 * size + 4096) * 8)  # r147 formula
                self.assertLessEqual(peak, sm.dense_modal_bytes(size))
        finally:
            tracemalloc.stop()


if __name__ == '__main__':
    unittest.main(verbosity=2)
