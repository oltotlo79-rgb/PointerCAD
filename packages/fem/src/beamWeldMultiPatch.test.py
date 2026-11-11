"""Independent area/second-moment oracle for disjoint effective elastic intervals."""
import copy
import json
import unittest
import numpy as np
from beamWeldContact import solve_weld_contact_system, validate_welds, weld_operators
from beam_contact import run_beam_contact


def fixture(distance=0.75, offset=0.0):
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
    welds = [{'id': 'interval-'+str(index), 'nodeA': 1, 'nodeB': 2,
        'centerM': [1.0, 2.0+offset+sign*distance, 3.0],
        'normal': [1.0, 0.0, 0.0], 'along': [0.0, 1.0, 0.0],
        'widthM': 1.0, 'lengthM': 4.0, 'thicknessM': 0.2, 'youngPa': 1000.0, 'poisson': 0.25}
        for index, sign in enumerate((-1, 1))]
    return {'schema': 'pointercad-weld-layer-plan/1', 'contact': contact, 'welds': welds}


def section_matrix(distance, offset):
    # Each rectangle: A=4, int(y_local^2)dA=1/3, int(z_local^2)dA=16/3.
    # Parallel axis gives the complete group's centroidal integrals. No quadrature.
    iy = 2/3 + 8*distance**2
    iz = 32/3
    diagonal = np.diag([40000, 16000, 16000, 2000*(iy+iz), 5000*iz, 5000*iy])
    # Motion at group centroid: u_centroid = u_node + theta cross [0,offset,0].
    transform = np.eye(6)
    transform[0, 5] = -offset
    transform[2, 3] = offset
    return transform.T @ diagonal @ transform


class WeldMultiPatchTests(unittest.TestCase):
    def test_gap_changes_rotation_not_translation_with_sign_zero_and_individual_wrenches(self):
        matrices = [section_matrix(d, 0) for d in (0.75, 1.5)]
        np.testing.assert_array_equal(np.diag(matrices[0])[:3], np.diag(matrices[1])[:3])
        self.assertGreater(matrices[1][3, 3], matrices[0][3, 3])
        self.assertGreater(matrices[1][5, 5], matrices[0][5, 5])
        for distance, offset in ((0.75, 0.0), (1.5, 0.0), (0.75, 0.4)):
            plan = fixture(distance, offset)
            before = copy.deepcopy(plan)
            force = np.array(plan['contact']['nodes'][1]['load'])
            expected = np.linalg.solve(section_matrix(distance, offset), force)
            result = solve_weld_contact_system(np, plan, np.zeros((12, 12)), 1.0)
            for contact, state in zip(result['contact']['states'], result['states'], strict=True):
                factor = contact['loadFactor']
                node = contact['nodes'][1]
                np.testing.assert_allclose(node['displacementM']+node['rotationRad'], factor*expected, atol=1e-12, rtol=0)
                self.assertEqual([w['id'] for w in state['welds']], ['interval-0', 'interval-1'])
                summed = np.sum([w['forceOnBN']+w['momentOnBNm'] for w in state['welds']], axis=0)
                np.testing.assert_allclose(summed, -factor*force, atol=1e-10, rtol=0)
                self.assertAlmostEqual(sum(w['elasticEnergyJ'] for w in state['welds']),
                                       float(factor**2*force@expected/2), delta=1e-12)
                for joint in state['welds']:
                    fa, fb = np.array(joint['forceOnAN']), np.array(joint['forceOnBN'])
                    ma, mb = np.array(joint['momentOnANm']), np.array(joint['momentOnBNm'])
                    a, b = [np.array(n['positionM']) for n in plan['contact']['nodes']]
                    np.testing.assert_allclose(fa+fb, 0, atol=1e-10, rtol=0)
                    np.testing.assert_allclose(ma+mb+np.cross(a, fa)+np.cross(b, fb), 0, atol=1e-10, rtol=0)
                    self.assertGreaterEqual(joint['elasticEnergyJ'], 0)
            self.assertEqual(plan, before)

    def test_all_intervals_preserve_common_rigid_motion_nullspace(self):
        plan = fixture(1.5, 0.4)
        spin, shift = np.array([.003, -.002, .001]), np.array([.1, -.3, .2])
        motion = np.zeros(12)
        for i, node in enumerate(plan['contact']['nodes']):
            motion[6*i:6*i+3] = shift+np.cross(spin, node['positionM'])
            motion[6*i+3:6*i+6] = spin
        for _, points in weld_operators(np, plan):
            for row, weighted in points:
                relative = row@motion
                np.testing.assert_allclose(relative, 0, atol=1e-15, rtol=0)
                self.assertLess(abs(float(relative@weighted@relative)), 1e-20)

    def test_overlap_alias_and_noncollinear_groups_refuse_without_changing_single_patch(self):
        for second in ({'centerM': [1.0, 2.0, 3.0]}, {'centerM': [1.0, 2.0, 3.2]},
                       {'centerM': [1.2, 2.0, 3.0]}, {'normal': [0.0, 0.0, 1.0]},
                       {'id': 'interval-0'}):
            plan = fixture()
            plan['welds'][1].update(second)
            with self.assertRaises(ValueError):
                validate_welds(plan)
        # At nominal touching, an accepted tiny angular tilt adds transverse
        # extent 4*sin(angle)/2 along the other patch: positive area overlaps.
        for angle in (0.0, 5e-11):
            touching = fixture(0.5)
            touching['welds'][1]['along'] = [0.0, float(np.cos(angle)), float(np.sin(angle))]
            with self.assertRaisesRegex(ValueError, 'weld-duplicate'):
                validate_welds(touching)
        separated = fixture(0.500001)
        separated['welds'][1]['along'] = [0.0, 1.0, 5e-11]
        validate_welds(separated)
        single = fixture()
        single['welds'] = single['welds'][:1]
        validate_welds(single)


def check_native():
    """Root only: two actual native Beam3d assemblies, each with signed/zero loads."""
    results = []
    for distance in (0.75, 1.5):
        plan = fixture(distance)
        end = plan['contact']['nodes'][1]
        end['restrained'] = [False, True, True, False, True, True]
        end['load'] = [40.0, 0.0, 0.0, 80.0/3, 0.0, 0.0]
        result = json.loads(run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
            solve_weld_contact_system(np, plan, stiffness, length)))
        # Actual beam EA/L=1000, GJ/L=400 in parallel with the independent layer integrals.
        diagonal = np.diag(section_matrix(distance, 0))
        for contact, state in zip(result['contact']['states'], result['states'], strict=True):
            factor = contact['loadFactor']
            expected_u = factor*40/(1000+diagonal[0])
            expected_spin = factor*(80/3)/(400+diagonal[3])
            node = contact['nodes'][1]
            np.testing.assert_allclose([node['displacementM'][0], node['rotationRad'][0]],
                                       [expected_u, expected_spin], atol=1e-12, rtol=0)
            np.testing.assert_allclose([sum(w['forceOnBN'][0] for w in state['welds']),
                                       sum(w['momentOnBNm'][0] for w in state['welds'])],
                                      [-diagonal[0]*expected_u, -diagonal[3]*expected_spin], atol=1e-10, rtol=0)
        results.append(result)
    return results


if __name__ == '__main__':
    unittest.main()
