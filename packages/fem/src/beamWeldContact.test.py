"""Root-run independent effective-layer oracles; native entry is separate."""
import copy
import json
import unittest
import numpy as np
from beamWeldContact import solve_weld_contact_system, validate_welds, weld_operators
from beam_contact import _solve_contact_system, run_beam_contact


def fixture():
    # Rectangle 2 m along Y, 4 m along Z, t=.2 m, E=1000 Pa, nu=.25.
    # Deliberately simple SI values: no engineering strength claim.
    nodes = [
        {'number': 1, 'positionM': [0.0, 2.0, 3.0], 'restrained': [True]*6, 'load': [0.0]*6},
        {'number': 2, 'positionM': [1.0, 2.0, 3.0], 'restrained': [False]*6,
         'load': [40.0, 32.0, -16.0, 80.0/3, 160.0/3, -40.0/3]}]
    contact = {'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 2, 'nodes': nodes,
        'materials': [{'number': 1, 'youngPa': 1000.0, 'poisson': 0.25, 'densityKgM3': 1.0}],
        'sections': [{'number': 1, 'areaM2': 1.0, 'iyM4': 1.0, 'izM4': 1.0, 'torsionM4': 1.0, 'shearFactor': 1.0}],
        'members': [{'number': 1, 'nodes': [1, 2], 'material': 1, 'section': 1,
                     'frame': {'x': [1.0, 0.0, 0.0], 'y': [0.0, 1.0, 0.0], 'z': [0.0, 0.0, 1.0], 'lengthM': 1.0}}],
        'contacts': [{'id': 'distant-stop', 'kind': 'node-plane', 'node': 2, 'normal': [1.0, 0.0, 0.0], 'gapM': 1.0}],
        'loadFactors': [1.0, -1.0, 0.0]}
    weld = {'id': 'effective-patch', 'nodeA': 1, 'nodeB': 2, 'centerM': [1.0, 2.0, 3.0],
            'normal': [1.0, 0.0, 0.0], 'along': [0.0, 1.0, 0.0], 'widthM': 2.0,
            'lengthM': 4.0, 'thicknessM': 0.2, 'youngPa': 1000.0, 'poisson': 0.25}
    return {'schema': 'pointercad-weld-layer-plan/1', 'contact': contact, 'welds': [weld]}


def check_wrenches(test, plan, state):
    joint = state['welds'][0]
    fa, fb = np.array(joint['forceOnAN']), np.array(joint['forceOnBN'])
    ma, mb = np.array(joint['momentOnANm']), np.array(joint['momentOnBNm'])
    a, b = [np.array(n['positionM']) for n in plan['contact']['nodes']]
    np.testing.assert_allclose(fa + fb, 0.0, atol=1e-10, rtol=0)
    np.testing.assert_allclose(ma + mb + np.cross(a, fa) + np.cross(b, fb), 0.0, atol=1e-10, rtol=0)
    test.assertGreaterEqual(joint['elasticEnergyJ'], 0.0)


class WeldLayerTests(unittest.TestCase):
    def test_six_independent_stiffnesses_reversal_energy_and_eccentric_wrench_balance(self):
        plan = fixture()
        original = copy.deepcopy(plan)
        matrix = np.zeros((12, 12))
        result = solve_weld_contact_system(np, plan, matrix, 1.0)
        # Independent integrals: A=8, int(y²)dA=8/3, int(z²)dA=32/3.
        # Translation E*A/t or G*A/t; twist G*(Iy+Iz)/t; bends E*Iy/t,E*Iz/t.
        diagonal = np.array([40000.0, 16000.0, 16000.0, 80000.0/3, 160000.0/3, 40000.0/3])
        load = np.array(plan['contact']['nodes'][1]['load'])
        expected = load / diagonal
        np.testing.assert_allclose(expected, [.001, .002, -.001, .001, .001, -.001], atol=1e-15, rtol=0)
        for raw, state in zip(result['contact']['states'], result['states'], strict=True):
            factor = raw['loadFactor']
            node = raw['nodes'][1]
            actual = node['displacementM'] + node['rotationRad']
            np.testing.assert_allclose(actual, factor * expected, atol=1e-12, rtol=0)
            joint = state['welds'][0]
            np.testing.assert_allclose(joint['forceOnBN'] + joint['momentOnBNm'], -factor * load, atol=1e-10, rtol=0)
            self.assertAlmostEqual(joint['elasticEnergyJ'], float(factor**2 * load @ expected / 2), delta=1e-12)
            self.assertLessEqual(raw['equilibriumResidual'], 1e-9)
            check_wrenches(self, plan, state)
        self.assertEqual(plan, original)
        np.testing.assert_array_equal(matrix, np.zeros((12, 12)))

    def test_common_rigid_motion_has_zero_energy_with_rotated_patch_and_offsets(self):
        plan = fixture()
        rotation = np.array([[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        shift = np.array([4.0, -7.0, 2.0])
        for node in plan['contact']['nodes']:
            node['positionM'] = (rotation @ node['positionM'] + shift).tolist()
        member = plan['contact']['members'][0]
        for axis in ('x', 'y', 'z'):
            member['frame'][axis] = (rotation @ member['frame'][axis]).tolist()
        weld = plan['welds'][0]
        weld['centerM'] = (rotation @ weld['centerM'] + shift).tolist()
        for key in ('normal', 'along'):
            weld[key] = (rotation @ weld[key]).tolist()
        spin, translation = np.array([.003, -.002, .001]), np.array([.1, -.3, .2])
        displacement = np.zeros(12)
        for i, node in enumerate(plan['contact']['nodes']):
            displacement[6*i:6*i+3] = translation + np.cross(spin, node['positionM'])
            displacement[6*i+3:6*i+6] = spin
        for _, points in weld_operators(np, plan):
            for row, weighted in points:
                np.testing.assert_allclose(row @ displacement, 0.0, atol=1e-15, rtol=0)
                self.assertLess(abs(float(displacement @ row.T @ weighted @ row @ displacement)), 1e-20)

    def test_missing_connection_and_translation_only_connection_cannot_pass_oracle(self):
        plan = fixture()
        with self.assertRaisesRegex(ValueError, 'contact-mechanism'):
            _solve_contact_system(np, plan['contact'], np.zeros((12, 12)), 1.0)
        # A translation-only tie has zero bending/torsion energy, unlike the declared layer.
        _, points = weld_operators(np, plan)[0]
        spin = np.zeros(12)
        spin[9] = .001
        true_energy = sum(float((row @ spin) @ weighted @ (row @ spin))/2 for row, weighted in points)
        self.assertAlmostEqual(true_energy, (80000.0/3)*.001**2/2, delta=1e-12)
        self.assertGreater(true_energy, .01)

    def test_invalid_material_geometry_ownership_indices_and_unsupported_options_refused(self):
        for patch in ({'nodeA': True}, {'nodeB': 1}, {'nodeB': 3}, {'youngPa': True},
                      {'thicknessM': 0}, {'widthM': float('nan')}, {'poisson': .5},
                      {'normal': [2.0, 0.0, 0.0]}, {'along': [1.0, 0.0, 0.0]},
                      {'rigid': True}, {'yieldPa': 250e6}, {'preloadN': 10}):
            plan = fixture()
            plan['welds'][0].update(patch)
            with self.assertRaises(ValueError):
                validate_welds(plan)
        plan = fixture()
        plan['welds'].append({**plan['welds'][0], 'id': 'duplicate-other-name'})
        with self.assertRaisesRegex(ValueError, 'weld-duplicate'):
            validate_welds(plan)


def check_native():
    """Root only: actual native Beam3d K plus layer, independent axial/torsion oracle."""
    plan = fixture()
    end = plan['contact']['nodes'][1]
    end['restrained'] = [False, True, True, False, True, True]
    end['load'] = [40.0, 0.0, 0.0, 80.0/3, 0.0, 0.0]
    raw = json.loads(run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
                                     solve_weld_contact_system(np, plan, stiffness, length)))
    # Actual original beam: EA/L=1000, GJ/L=400. Both operate in parallel with the layer.
    for contact, state in zip(raw['contact']['states'], raw['states'], strict=True):
        factor = contact['loadFactor']
        node, joint = contact['nodes'][1], state['welds'][0]
        expected_u, expected_spin = factor * 40/41000, factor * (80/3)/(80000/3 + 400)
        if abs(node['displacementM'][0] - expected_u) > 1e-12 or abs(node['rotationRad'][0] - expected_spin) > 1e-12:
            raise AssertionError('native beam/layer independent axial or torsional stiffness mismatch')
        if abs(joint['forceOnBN'][0] + 40000*expected_u) > 1e-10 or abs(joint['momentOnBNm'][0] + (80000/3)*expected_spin) > 1e-10:
            raise AssertionError('native joint force or moment transfer mismatch')
    return raw


if __name__ == '__main__':
    unittest.main()
