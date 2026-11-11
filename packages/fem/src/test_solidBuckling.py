"""Pure NumPy checks of solidBuckling.py native-r1 (no OOFEM). Root runs: python -B -X utf8 test_solidBuckling.py next to
solidBuckling.py. Expected values are closed forms derived here, never read from the implementation.

Corner tetrahedron (0,0,0),(L,0,0),(0,L,0),(0,0,L), vertices 0, 2, 3 fully prescribed, vertex 1 free in x and y,
force (-P, 0, 0) at vertex 1. With g_1 = (1/L, 0, 0): eps_xx = u1x/L, gamma_xy = u1y/L, so (V = L^3/6)
  K = diag(V (lame + 2 mu) / L^2, V mu / L^2),  sigma_xx = -P L / V,  Kg = V sigma_xx / L^2 I = -(P/L) I,
  lambda_y = mu L^2 / (6 P) < lambda_x = (lame + 2 mu) L^2 / (6 P).
"""
import unittest

import numpy as np

import solidBuckling as sb

L, E, NU, P = 10.0, 205000.0, 0.3, 1000.0
MU = E / (2 * (1 + NU))
LAME = E * NU / ((1 + NU) * (1 - 2 * NU))
V = L ** 3 / 6
CORNER = [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]]
FREE = [3, 4]  # vertex 1 ux, uy in the 12-DOF numbering


def benchmark(load=P, young=E, length=L):
    mu, lame, volume = young / (2 * (1 + NU)), young * NU / ((1 + NU) * (1 - 2 * NU)), length ** 3 / 6
    stiffness = np.diag([volume * (lame + 2 * mu) / length ** 2, volume * mu / length ** 2])
    sigma = -load * length / volume
    geometric = sb.tet4_initial_stress(np, [[0, 0, 0], [length, 0, 0], [0, length, 0], [0, 0, length]],
                                       [sigma, 0, 0, 0, 0, 0])[np.ix_(FREE, FREE)]
    return stiffness, geometric


def plan(forces=None, fixed=None):
    fixed = fixed or [[True, True, True], [False, False, True], [True, True, True], [True, True, True]]
    forces = forces or [[0, 0, 0], [-P, 0, 0], [0, 0, 0], [0, 0, 0]]
    data = {'schema': 'pointercad-solid-tet4/1', 'source': {'documentId': 'd', 'revision': 1, 'meshKey': 'm'},
            'units': 'N-mm-MPa', 'numericBudgetBytes': 16 * 1024 * 1024, 'nodes': CORNER,
            'elements': [{'nodes': [0, 1, 2, 3], 'materialId': 'steel'}],
            'materials': [{'id': 'steel', 'youngMPa': E, 'poisson': NU}], 'constraints': [], 'nodalLoads': [],
            'surfaceLoads': []}
    return {'schema': 'pointercad-solid-tet4-buckling-plan/1', 'freeDofs': 2,
            'input': {'schema': 'pointercad-solid-tet4-buckling/1', 'reference': data, 'modeCount': 2},
            'reference': {'schema': 'pointercad-solid-tet4-plan/1', 'input': data, 'forcesN': forces, 'fixed': fixed}}


class InitialStressMatrix(unittest.TestCase):
    def test_corner_vertex_entries(self):
        sigma = -60.0
        kg = sb.tet4_initial_stress(np, CORNER, [sigma, 0, 0, 0, 0, 0])
        np.testing.assert_allclose(np.diag(kg)[3:6], V * sigma / L ** 2, rtol=1e-14)
        self.assertAlmostEqual(kg[0, 3], -V * sigma / L ** 2, delta=1e-12)
        self.assertEqual(float(np.abs(kg[6:, 6:]).max()), 0.0)

    def test_symmetric_and_rigid_translation_free(self):
        points = [[0, 0, 0], [12, 1, -2], [3, 9, 1], [-1, 2, 11]]
        kg = sb.tet4_initial_stress(np, points, [-40, 15, 7, -3, 9, 21])
        np.testing.assert_allclose(kg, kg.T, atol=1e-12)
        for translation in ([1, 0, 0], [0, 1, 0], [0, 0, 1]):
            self.assertLess(float(np.abs(kg @ np.tile(translation, 4)).max()), 1e-10)

    def test_inverted_tetrahedron_refused(self):
        with self.assertRaisesRegex(ValueError, 'solid-buckling-geometry'):
            sb.tet4_initial_stress(np, [CORNER[0], CORNER[2], CORNER[1], CORNER[3]], [1, 0, 0, 0, 0, 0])


class IndependentStress(unittest.TestCase):
    def test_uniaxial_and_shear_of_the_free_vertex(self):
        u = 1e-3
        stress = sb.tet4_stress(np, CORNER, [[0, 0, 0], [u, 0, 0], [0, 0, 0], [0, 0, 0]], E, NU)
        np.testing.assert_allclose(stress, [(LAME + 2 * MU) * u / L, LAME * u / L, LAME * u / L, 0, 0, 0], atol=1e-12)
        shear = sb.tet4_stress(np, CORNER, [[0, 0, 0], [0, u, 0], [0, 0, 0], [0, 0, 0]], E, NU)
        np.testing.assert_allclose(shear, [0, 0, 0, 0, 0, MU * u / L], atol=1e-12)

    def test_rigid_translation_is_stress_free(self):
        stress = sb.tet4_stress(np, [[0, 0, 0], [12, 1, -2], [3, 9, 1], [-1, 2, 11]], [[0.2, -0.1, 0.3]] * 4, E, NU)
        self.assertLess(max(abs(v) for v in stress), 1e-9)


class ReferenceDeck(unittest.TestCase):
    def test_only_free_load_components_enter_the_native_deck(self):
        deck = sb.solid_buckling_deck(plan(forces=[[5, 0, 0], [-P, 0, 7], [0, 0, 0], [0, 0, 0]]))
        lines = deck.splitlines()
        self.assertIn('LinearStatic nsteps 1 nmodules 0', lines)
        self.assertIn('ndofman 4 nelem 1 ncrosssect 1 nmat 1 nbc 2 nltf 1 nic 0 nset 1', lines)
        self.assertIn('NodalLoad 2 loadTimeFunction 1 dofs 1 1 Components 1 -1000.0 set 1', lines)
        self.assertIn('Set 1 nodes 1 2', lines)
        self.assertIn('node 2 coords 3 10.0 0.0 0.0 bc 3 0 0 1', lines)
        self.assertIn('IsoLE 1 d 0 E 205000.0 n 0.3 tAlpha 0.0', lines)

    def test_load_only_on_prescribed_components_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'solid-buckling-load'):
            sb.solid_buckling_deck(plan(forces=[[5, 0, 0], [0, 0, 7], [0, 0, 0], [0, 0, 0]]))


class ReducedEigensolve(unittest.TestCase):
    def test_closed_form_load_factors_and_shapes(self):
        stiffness, geometric = benchmark()
        modes = sb.solve_buckling(np, stiffness, geometric, 2, 4, FREE)
        expected = [MU * L ** 2 / (6 * P), (LAME + 2 * MU) * L ** 2 / (6 * P)]
        np.testing.assert_allclose([m['loadFactor'] for m in modes], expected, rtol=1e-12)
        np.testing.assert_allclose(np.abs(modes[0]['shape'][1]), [0.0, 1.0, 0.0], atol=1e-12)
        np.testing.assert_allclose(np.abs(modes[1]['shape'][1]), [1.0, 0.0, 0.0], atol=1e-12)
        for mode in modes:
            self.assertEqual(mode['shape'][0] + mode['shape'][2] + mode['shape'][3], [0.0] * 9)
            self.assertLessEqual(mode['normalizedResidual'], 1e-12)

    def test_scaling_with_load_modulus_and_length(self):
        base = sb.solve_buckling(np, *benchmark(), 1, 4, FREE)[0]['loadFactor']
        for kwargs, ratio in (({'load': 2 * P}, 0.5), ({'young': 2 * E}, 2.0), ({'length': 2 * L}, 4.0)):
            value = sb.solve_buckling(np, *benchmark(**kwargs), 1, 4, FREE)[0]['loadFactor']
            self.assertAlmostEqual(value / base, ratio, places=12)

    def test_tension_and_stress_free_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'solid-buckling-no-positive-mode'):
            sb.solve_buckling(np, *benchmark(load=-P), 1, 4, FREE)
        stiffness, _ = benchmark()
        with self.assertRaisesRegex(ValueError, 'solid-buckling-no-positive-mode'):
            sb.solve_buckling(np, stiffness, np.zeros((2, 2)), 1, 4, FREE)

    def test_partial_compression_returns_only_available_modes(self):
        stiffness, _ = benchmark()
        mixed = np.diag([P / L, -P / L])  # x in tension, y in compression
        modes = sb.solve_buckling(np, stiffness, mixed, 1, 4, FREE)
        self.assertAlmostEqual(modes[0]['loadFactor'], MU * L ** 2 / (6 * P), places=9)
        with self.assertRaisesRegex(ValueError, '1 positive load factor'):
            sb.solve_buckling(np, stiffness, mixed, 2, 4, FREE)

    def test_mechanism_and_inconsistent_systems_are_refused(self):
        _, geometric = benchmark()
        with self.assertRaisesRegex(ValueError, 'solid-buckling-mechanism'):
            sb.solve_buckling(np, np.diag([1.0, 0.0]), geometric, 1, 4, FREE)
        with self.assertRaisesRegex(ValueError, 'solid-buckling-mechanism'):
            sb.solve_buckling(np, np.diag([1.0, -1.0]), geometric, 1, 4, FREE)
        with self.assertRaisesRegex(ValueError, 'solid-buckling-numeric'):
            sb.solve_buckling(np, np.array([[1.0, 0.5], [0.0, 1.0]]), geometric, 1, 4, FREE)
        with self.assertRaisesRegex(ValueError, 'solid-buckling-supports'):
            sb.solve_buckling(np, *benchmark(), 3, 4, FREE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
