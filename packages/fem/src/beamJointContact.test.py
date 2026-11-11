"""Independent mixed branch stiffness, gap, moment and native-matrix oracles."""
import copy
import json
import unittest
from unittest.mock import patch
import numpy as np
import beam_weld_contact
from beam_contact import run_beam_contact
from beamJointContact import solve_joint_contact_system, validate_joints


def fixture(offset=0.0, axial_only=False):
    end = {'number': 2, 'positionM': [1.0, 2.0, 3.0],
           'restrained': [False, True, True, False, True, True] if axial_only else [False]*6,
           'load': [40.0, 0.0, 0.0, 80.0/3, 0.0, 0.0] if axial_only else [40.0, 32.0, -16.0, 80.0/3, 160.0/3, -40.0/3]}
    contact = {'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 2,
        'nodes': [{'number': 1, 'positionM': [0.0, 2.0, 3.0], 'restrained': [True]*6, 'load': [0.0]*6}, end],
        'materials': [{'number': 1, 'youngPa': 1000.0, 'poisson': 0.25, 'densityKgM3': 1.0}],
        'sections': [{'number': 1, 'areaM2': 1.0, 'iyM4': 1.0, 'izM4': 1.0, 'torsionM4': 1.0, 'shearFactor': 1.0}],
        'members': [{'number': 1, 'nodes': [1, 2], 'material': 1, 'section': 1,
            'frame': {'x': [1.0, 0.0, 0.0], 'y': [0.0, 1.0, 0.0], 'z': [0.0, 0.0, 1.0], 'lengthM': 1.0}}],
        'contacts': [{'id': 'stop', 'kind': 'node-plane', 'node': 2, 'normal': [-1.0, 0.0, 0.0],
                      'gapM': 0.0005 if axial_only else 1.0}], 'loadFactors': [0.2, 1.0, -1.0, 0.0, 1.0]}
    welds = [{'id': 'interval-'+str(i), 'nodeA': 1, 'nodeB': 2,
        'centerM': [1.0, 2.0+offset+sign*0.75, 3.0], 'normal': [1.0, 0.0, 0.0], 'along': [0.0, 1.0, 0.0],
        'widthM': 1.0, 'lengthM': 4.0, 'thicknessM': 0.2, 'youngPa': 1000.0, 'poisson': 0.25}
        for i, sign in enumerate((-1, 1))]
    return {'schema': 'pointercad-joint-contact-plan/1', 'contact': contact,
            'bolts': [{'id': 'shank', 'nodeA': 1, 'nodeB': 2, 'youngPa': 2000.0, 'areaM2': 1.0}], 'welds': welds}


def independent_matrix(offset):
    # Two rectangles A=4 each. Integral y^2=2*(1/3+4*.75^2)=31/6;
    # integral z^2=2*16/3=32/3. No implementation quadrature is used.
    diagonal = np.diag([40000.0, 16000.0, 16000.0, 2000*95/6, 5000*32/3, 5000*31/6])
    transform = np.eye(6)
    transform[0, 5], transform[2, 3] = -offset, offset
    return transform.T @ diagonal @ transform + np.diag([3000.0, 0, 0, 400.0, 0, 0])


def analytic_native_matrix():
    matrix = np.zeros((12, 12))
    for axis, stiffness in ((0, 1000.0), (3, 400.0)):
        row = np.zeros(12)
        row[axis], row[6+axis] = -1.0, 1.0
        matrix += stiffness*np.outer(row, row)
    return matrix


def check_axial(test, result):
    for contact, state in zip(result['contact']['states'], result['states'], strict=True):
        factor = contact['loadFactor']
        u = min(factor*40/43000, 0.0005)
        spin = factor*(80/3)/(400+2000*95/6)
        reaction = max(0.0, factor*40-43000*0.0005)
        actual = contact['nodes'][1]
        np.testing.assert_allclose([actual['displacementM'][0], actual['rotationRad'][0]], [u, spin], atol=1e-12, rtol=0)
        test.assertAlmostEqual(state['bolts'][0]['axialForceN'], 2000*u, delta=1e-10)
        test.assertAlmostEqual(sum(w['forceOnBN'][0] for w in state['welds']), -40000*u, delta=1e-10)
        test.assertAlmostEqual(contact['contacts'][0]['normalReactionN'], reaction, delta=1e-10)
        test.assertAlmostEqual(1000*u+state['bolts'][0]['axialForceN']-sum(w['forceOnBN'][0] for w in state['welds'])+reaction,
                               factor*40, delta=1e-10)
        test.assertEqual(contact['contacts'][0]['state'], 'closed' if reaction > 0 else 'open')
        test.assertLessEqual(contact['equilibriumResidual'], 1e-9)


class JointContactTests(unittest.TestCase):
    def test_parallel_branches_share_one_open_closed_reversed_zero_contact_solution(self):
        plan, matrix = fixture(axial_only=True), analytic_native_matrix()
        before, original = copy.deepcopy(plan), matrix.copy()
        with patch.object(beam_weld_contact, '_solve_contact_system', wraps=beam_weld_contact._solve_contact_system) as solver:
            result = solve_joint_contact_system(np, plan, matrix, 1.0)
            solver.assert_called_once()
        check_axial(self, result)
        self.assertEqual(plan, before)
        np.testing.assert_array_equal(matrix, original)

    def test_eccentric_weld_and_axial_shank_obey_independent_six_dof_equilibrium_and_energy(self):
        plan = fixture(offset=0.4)
        force = np.array(plan['contact']['nodes'][1]['load'])
        expected = np.linalg.solve(independent_matrix(0.4), force)
        result = solve_joint_contact_system(np, plan, analytic_native_matrix(), 1.0)
        for contact, state in zip(result['contact']['states'], result['states'], strict=True):
            factor = contact['loadFactor']
            motion = factor*expected
            node = contact['nodes'][1]
            np.testing.assert_allclose(node['displacementM']+node['rotationRad'], motion, atol=1e-12, rtol=0)
            bolt = state['bolts'][0]
            summed = np.sum([w['forceOnBN']+w['momentOnBNm'] for w in state['welds']], axis=0)
            summed[:3] += bolt['forceOnBN']
            native = np.diag([1000.0, 0, 0, 400.0, 0, 0])@motion
            np.testing.assert_allclose(native-summed, factor*force, atol=1e-10, rtol=0)
            energy = sum(w['elasticEnergyJ'] for w in state['welds']) + bolt['axialForceN']*bolt['extensionM']/2 + motion@native/2
            self.assertAlmostEqual(float(energy), float(factor*force@motion/2), delta=1e-12)
            for weld in state['welds']:
                fa, fb = np.array(weld['forceOnAN']), np.array(weld['forceOnBN'])
                ma, mb = np.array(weld['momentOnANm']), np.array(weld['momentOnBNm'])
                a, b = [np.array(n['positionM']) for n in plan['contact']['nodes']]
                np.testing.assert_allclose(fa+fb, 0, atol=1e-10, rtol=0)
                np.testing.assert_allclose(ma+mb+np.cross(a, fa)+np.cross(b, fb), 0, atol=1e-10, rtol=0)

    def test_invalid_mixed_inputs_cannot_fall_back_to_one_connector(self):
        for key in ('bolts', 'welds'):
            plan = fixture()
            plan[key] = []
            with self.assertRaises(ValueError):
                validate_joints(plan)
        for change in ('identity', 'preload', 'overlap'):
            plan = fixture()
            if change == 'identity':
                plan['bolts'][0]['id'] = plan['welds'][0]['id']
            if change == 'preload':
                plan['bolts'][0]['preloadN'] = 10
            if change == 'overlap':
                plan['welds'][1]['centerM'] = plan['welds'][0]['centerM'][:]
            with self.assertRaises(ValueError):
                validate_joints(plan)


def check_native():
    """Root only; one actual native Beam3d assembly, five actual load states."""
    plan = fixture(axial_only=True)
    result = json.loads(run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
        solve_joint_contact_system(np, plan, stiffness, length)))
    check_axial(unittest.TestCase(), result)
    return result


if __name__ == '__main__':
    unittest.main()
