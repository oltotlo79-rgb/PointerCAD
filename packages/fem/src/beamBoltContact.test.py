"""Root-run independent coupled-equilibrium tests. Not a native-runtime pass."""
import copy
import unittest
import numpy as np
from beamBoltContact import solve_bolt_contact_system, validate_bolts


def fixture(axis=0, swapped=False):
    origin = [10.0, 20.0, 30.0]
    end = origin.copy()
    end[axis] += 1.0
    direction = [0.0, 0.0, 0.0]
    direction[axis] = 1.0
    normal = [-v for v in direction]
    restraint = [True] * 6
    restraint[axis] = False
    load = [0.0] * 6
    load[axis] = 1.0
    frame = {'x': direction, 'y': [0.0, 1.0, 0.0] if axis == 0 else [-1.0, 0.0, 0.0],
             'z': [0.0, 0.0, 1.0], 'lengthM': 1.0}
    contact = {'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 2,
        'nodes': [{'number': 1, 'positionM': origin, 'restrained': [True] * 6, 'load': [0.0] * 6},
                  {'number': 2, 'positionM': end, 'restrained': restraint, 'load': load}],
        'materials': [{'number': 1, 'youngPa': 1000.0, 'poisson': 0.3, 'densityKgM3': 1.0}],
        'sections': [{'number': 1, 'areaM2': 1.0, 'iyM4': 1.0, 'izM4': 1.0, 'torsionM4': 1.0, 'shearFactor': 1.0}],
        'members': [{'number': 1, 'nodes': [1, 2], 'material': 1, 'section': 1, 'frame': frame}],
        'contacts': [{'id': 'stop', 'kind': 'node-plane', 'node': 2, 'normal': normal, 'gapM': 0.00025}],
        'loadFactors': [0.0, 0.2, 1.0, -1.0, 1.0]}
    bolt = {'id': 'bolt', 'nodeA': 2 if swapped else 1, 'nodeB': 1 if swapped else 2,
            'youngPa': 1000.0, 'areaM2': 1.0}
    # Analytic axial stiffness of the beam, EA/L=1000. Other DOFs are restrained.
    row = np.zeros(12)
    row[axis], row[6 + axis] = -1.0, 1.0
    return {'schema': 'pointercad-bolt-contact-plan/1', 'contact': contact, 'bolts': [bolt]}, 1000.0 * np.outer(row, row)


class BoltContactTests(unittest.TestCase):
    def test_parallel_stiffness_contact_reversal_and_force_moment_balance(self):
        for axis in (0, 1):
            for swapped in (False, True):
                plan, stiffness = fixture(axis, swapped)
                before, matrix_before = copy.deepcopy(plan), stiffness.copy()
                result = solve_bolt_contact_system(np, plan, stiffness, 1.0)
                # Two parallel 1000 N/m springs: u=F/2000 until the 0.25 mm stop.
                for state, bolt_state in zip(result['contact']['states'], result['states'], strict=True):
                    force = state['loadFactor']
                    expected_u = min(force / 2000.0, 0.00025)
                    expected_contact = max(0.0, force - 2000.0 * 0.00025)
                    u = state['nodes'][1]['displacementM'][axis]
                    bolt = bolt_state['bolts'][0]
                    self.assertAlmostEqual(u, expected_u, delta=1e-12)
                    self.assertAlmostEqual(bolt['axialForceN'], 1000.0 * expected_u, delta=1e-10)
                    reaction = state['contacts'][0]['normalReactionN']
                    self.assertAlmostEqual(reaction, expected_contact, delta=1e-10)
                    self.assertAlmostEqual(1000.0 * u + bolt['axialForceN'] + reaction, force, delta=1e-10)
                    self.assertLessEqual(state['equilibriumResidual'], 1e-9)
                    a, b = plan['bolts'][0]['nodeA'] - 1, plan['bolts'][0]['nodeB'] - 1
                    fa, fb = np.array(bolt['forceOnAN']), np.array(bolt['forceOnBN'])
                    np.testing.assert_allclose(fa + fb, 0.0, atol=1e-12, rtol=0)
                    moment = np.cross(plan['contact']['nodes'][a]['positionM'], fa) + np.cross(plan['contact']['nodes'][b]['positionM'], fb)
                    np.testing.assert_allclose(moment, 0.0, atol=1e-12, rtol=0)
                self.assertEqual(plan, before)
                np.testing.assert_array_equal(stiffness, matrix_before)

    def test_missing_coupling_is_detected_by_the_independent_oracle(self):
        # Removing the added bolt stiffness would give u=.0002, not .0001 for F=.2.
        plan, stiffness = fixture()
        from beam_contact import _solve_contact_system
        uncoupled = _solve_contact_system(np, plan['contact'], stiffness, 1.0)
        self.assertAlmostEqual(uncoupled['states'][1]['nodes'][1]['displacementM'][0], 0.0002, delta=1e-12)
        self.assertGreater(abs(uncoupled['states'][1]['nodes'][1]['displacementM'][0] - 0.0001), 1e-5)

    def test_invalid_unsupported_and_duplicate_refusal(self):
        for patch in ({'youngPa': True}, {'areaM2': 0}, {'youngPa': float('nan')}, {'nodeA': 3},
                      {'nodeB': 1}, {'preloadN': 100}, {'friction': 0.2}):
            plan, _ = fixture()
            plan['bolts'][0].update(patch)
            with self.assertRaises(ValueError):
                validate_bolts(plan)
        plan, _ = fixture()
        plan['bolts'].append({**plan['bolts'][0], 'id': 'other', 'nodeA': 2, 'nodeB': 1})
        with self.assertRaisesRegex(ValueError, 'bolt-duplicate'):
            validate_bolts(plan)

    def test_zero_bolt_length_refused_even_with_valid_beam_geometry(self):
        plan, _ = fixture()
        plan['contact']['nodes'].append({**copy.deepcopy(plan['contact']['nodes'][0]), 'number': 3})
        plan['contact']['originalNodeCount'] = 3
        plan['bolts'][0]['nodeB'] = 3
        with self.assertRaisesRegex(ValueError, 'bolt-length-stiffness'):
            validate_bolts(plan)


def check_native():
    """Root invokes this in the pinned OOFEM/NumPy runtime; uses actual native Beam3d K."""
    import json
    from beam_contact import run_beam_contact
    records = []
    for axis in (0, 1):
        for swapped in (False, True):
            plan, _ = fixture(axis, swapped)
            encoded = run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
                                       solve_bolt_contact_system(np, plan, stiffness, length))
            result = json.loads(encoded)
            for state, bolt_state in zip(result['contact']['states'], result['states'], strict=True):
                force = state['loadFactor']
                expected_u = min(force / 2000.0, 0.00025)
                actual_u = state['nodes'][1]['displacementM'][axis]
                reaction = state['contacts'][0]['normalReactionN']
                axial = bolt_state['bolts'][0]['axialForceN']
                if (abs(actual_u - expected_u) > 1e-12 or abs(axial - 1000 * expected_u) > 1e-10
                        or abs(1000 * actual_u + axial + reaction - force) > 1e-10):
                    raise AssertionError('native bolt/beam/contact failed independent stiffness/equilibrium oracle')
            records.append({'axis': axis, 'swapped': swapped, 'response': result})
    return records


if __name__ == '__main__':
    unittest.main()
