"""Independent initial-strain branch balance; Root may reuse the frozen mixed fixture."""
import copy
import json
import unittest
import numpy as np
from beam_contact import run_beam_contact
from beam_joint_contact import solve_joint_contact_system
from beamJointInitialStrain import solve_joint_initial_strain_system, validate_initial_strains
from joint_tests import fixture as mixed_fixture, analytic_native_matrix


def fixture(shortening=.001):
    joint = mixed_fixture(axial_only=True)
    joint['contact']['nodes'][1]['load'] = [40.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    joint['contact']['contacts'][0].update(normal=[1.0, 0.0, 0.0], gapM=.00002)
    joint['contact']['loadFactors'] = [0.0, .05, 1.0, -1.0, 0.0]
    return {'schema': 'pointercad-joint-initial-strain-plan/1', 'joint': joint,
            'shortenings': [{'boltId': 'shank', 'shorteningM': shortening}]}


def check_response(test, result):
    for contact, state in zip(result['contact']['states'], result['states'], strict=True):
        force = state['loadFactor']*40
        expected = max((force-2)/43000, -.00002)
        reaction = max(0.0, 2-force-.86)
        u = contact['nodes'][1]['displacementM'][0]
        test.assertAlmostEqual(u, expected, delta=1e-12)
        bolt = state['bolts'][0]
        test.assertAlmostEqual(bolt['axialForceN'], 2000*(expected+.001), delta=1e-10)
        test.assertAlmostEqual(bolt['elasticExtensionM'], expected+.001, delta=1e-12)
        test.assertAlmostEqual(bolt['extensionM'], expected, delta=1e-12)
        weld_force = sum(row['forceOnBN'][0] for row in state['welds'])
        test.assertAlmostEqual(weld_force, -40000*expected, delta=1e-10)
        test.assertAlmostEqual(contact['contacts'][0]['normalReactionN'], reaction, delta=1e-10)
        test.assertAlmostEqual(1000*u+bolt['axialForceN']-weld_force, force+reaction, delta=1e-10)
        total_energy = bolt['elasticEnergyJ']+sum(row['elasticEnergyJ'] for row in state['welds'])+.5*1000*u*u
        test.assertAlmostEqual(total_energy, .5*43000*expected**2+2*expected+.001, delta=1e-12)
        test.assertLessEqual(contact['equilibriumResidual'], 1e-9)
    test.assertEqual(result['states'][0], result['states'][-1])


class JointInitialStrainTests(unittest.TestCase):
    def test_actual_combined_assembly_balances_initial_stress_and_contact_for_each_factor(self):
        plan, matrix = fixture(), analytic_native_matrix()
        saved, original = copy.deepcopy(plan), matrix.copy()
        result = solve_joint_initial_strain_system(np, plan, matrix, 1.0)
        check_response(self, result)
        self.assertEqual(plan, saved)
        np.testing.assert_array_equal(matrix, original)

    def test_zero_shortening_retains_unstrained_mixed_contact_and_constitutive_results(self):
        plan, matrix = fixture(0.0), analytic_native_matrix()
        previous = solve_joint_contact_system(np, plan['joint'], matrix, 1.0)
        result = solve_joint_initial_strain_system(np, plan, matrix, 1.0)
        self.assertEqual(result['contact'], previous['contact'])
        for state, old in zip(result['states'], previous['states'], strict=True):
            self.assertEqual(state['welds'], old['welds'])
            for bolt, original in zip(state['bolts'], old['bolts'], strict=True):
                self.assertEqual({key: bolt[key] for key in original}, original)
                self.assertEqual(bolt['elasticExtensionM'], bolt['extensionM'])

    def test_declared_shortening_requires_exact_current_shank_and_positive_stress_free_length(self):
        for change in ('missing', 'duplicate', 'unknown', 'boolean', 'nan', 'negative', 'length', 'torque'):
            plan = fixture()
            if change == 'missing': plan['shortenings'] = []
            if change == 'duplicate': plan['shortenings'] *= 2
            if change == 'unknown': plan['shortenings'][0]['boltId'] = 'other'
            if change == 'boolean': plan['shortenings'][0]['shorteningM'] = True
            if change == 'nan': plan['shortenings'][0]['shorteningM'] = float('nan')
            if change == 'negative': plan['shortenings'][0]['shorteningM'] = -.001
            if change == 'length': plan['shortenings'][0]['shorteningM'] = 1.0
            if change == 'torque': plan['shortenings'][0]['torqueNm'] = 10
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_initial_strains(plan)


def check_native():
    plan = fixture()
    result = json.loads(run_beam_contact(plan=plan['joint']['contact'], solve_system=lambda np, unused, stiffness, length:
        solve_joint_initial_strain_system(np, plan, stiffness, length)))
    check_response(unittest.TestCase(), result)
    return result


if __name__ == '__main__':
    unittest.main()
