"""Independent affine-load contact oracle for prescribed initial shank strain.

Core prerequisite only; not a qualified public preload or tightening feature.
"""
import copy
import unittest
import numpy as np
from beam_contact import _solve_contact_system


def fixture():
    # Free axial DOF at B. Independent beam+bolt+weld stiffness=1000+2000+40000.
    nodes = [
        {'number': 1, 'positionM': [0.0, 0.0, 0.0], 'restrained': [True]*6, 'load': [0.0]*6},
        {'number': 2, 'positionM': [1.0, 0.0, 0.0], 'restrained': [False, True, True, True, True, True],
         'load': [40.0, 0.0, 0.0, 0.0, 0.0, 0.0]},
    ]
    plan = {'nodes': nodes, 'originalNodeCount': 2, 'members': [{}],
            'contacts': [{'id': 'lower-stop', 'kind': 'node-plane', 'node': 2,
                          'normal': [1.0, 0.0, 0.0], 'gapM': .00002}],
            'loadFactors': [0.0, .05, 1.0, -1.0, 0.0]}
    row = np.zeros(12)
    row[0], row[6] = -1, 1
    matrix = 43000*np.outer(row, row)
    # Initial shortening s=.001, kb=2000: minus the initial internal force kb*s*b.
    initial = (-2*row).tolist()
    return plan, matrix, initial


class InitialForceTests(unittest.TestCase):
    def test_initial_force_survives_zero_reversed_and_repeated_external_loads(self):
        plan, matrix, initial = fixture()
        before, original, saved = copy.deepcopy(plan), matrix.copy(), initial[:]
        result = _solve_contact_system(np, plan, matrix, 1.0, constant_force=initial)
        for state in result['states']:
            force = state['loadFactor']*40
            displacement = max((force-2)/43000, -.00002)
            reaction = max(0.0, 2-force-43000*.00002)
            u = state['nodes'][1]['displacementM'][0]
            self.assertAlmostEqual(u, displacement, delta=1e-12)
            self.assertAlmostEqual(state['contacts'][0]['normalReactionN'], reaction, delta=1e-10)
            self.assertEqual(state['contacts'][0]['state'], 'closed' if reaction > 0 else 'open')
            # Actual displacement determines all three branch forces; initial stress is not an external load factor.
            beam, bolt, weld = 1000*u, 2000*(u+.001), 40000*u
            self.assertAlmostEqual(beam+bolt+weld, force+reaction, delta=1e-10)
            self.assertAlmostEqual(.5*1000*u*u+.5*2000*(u+.001)**2+.5*40000*u*u,
                                   .5*43000*displacement**2+2*displacement+.001, delta=1e-12)
            self.assertLessEqual(state['equilibriumResidual'], 1e-9)
            self.assertLessEqual(state['complementarity'], 1e-9)
        self.assertEqual(result['states'][0], result['states'][-1])
        self.assertEqual(plan, before)
        self.assertEqual(initial, saved)
        np.testing.assert_array_equal(matrix, original)

    def test_zero_initial_force_preserves_the_existing_contact_response(self):
        plan, matrix, _ = fixture()
        old = _solve_contact_system(np, plan, matrix, 1.0)
        explicit_zero = _solve_contact_system(np, plan, matrix, 1.0, constant_force=[0.0]*12)
        self.assertEqual(explicit_zero, old)

    def test_malformed_or_unbounded_initial_forces_are_refused(self):
        plan, matrix, _ = fixture()
        for value in ([0.0]*11, [True]+[0.0]*11, [float('nan')]+[0.0]*11,
                      [float('inf')]+[0.0]*11, [1e31]+[0.0]*11, {'load': [0.0]*12}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                _solve_contact_system(np, plan, matrix, 1.0, constant_force=value)


if __name__ == '__main__':
    unittest.main()
