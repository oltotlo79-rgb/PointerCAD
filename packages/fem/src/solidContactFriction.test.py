"""Independent fixed-point Coulomb state, tangent and dissipation checks."""

import copy
import json
import math
import unittest

from solidContact import contactResidualAndTangent
from solidContactFriction import updateCoulombState


def rotated(vector):
    angle = math.radians(37)
    c, s = math.cos(angle), math.sin(angle)
    x, y, z = vector
    return (c * x + s * z, y, -s * x + c * z)


class CoulombPoint(unittest.TestCase):
    def state(self, **changes):
        args = dict(normal=(0, 0, 1), gapMm=-.01, knNPerMm3=1000,
                    ktNPerMm3=100, mu=.3, sourceId='independent-test-oracle', areaMm2=2,
                    previousElasticSlipMm=(0, 0, 0), accumulatedDissipationNmm=0,
                    relativeIncrementMm=(.01, 0, 0))
        args.update(changes)
        return updateCoulombState(**args)

    def vector_close(self, actual, expected, places=12):
        self.assertEqual(len(actual), len(expected))
        for left, right in zip(actual, expected):
            self.assertAlmostEqual(left, right, places=places)

    def test_stick_has_independent_force_stiffness_and_elastic_energy(self):
        result = self.state()
        self.assertEqual(result['status'], 'stick')
        self.assertEqual(result['normalPressureMPa'], 10)
        self.assertEqual(result['normalForceN'], 20)
        self.vector_close(result['tangentialTractionMPa'], (1, 0, 0))
        self.vector_close(result['tangentialForceN'], (2, 0, 0))
        self.vector_close(result['elasticSlipMm'], (.01, 0, 0))
        self.assertEqual(result['addedDissipationNmm'], 0)
        self.assertAlmostEqual(result['elasticEnergyNmm'], .01, places=14)
        self.assertEqual(result['tangentialTangentNPerMm3'], [[100, 0, 0], [0, 100, 0], [0, 0, 0]])
        self.assertEqual(result['normalCouplingNPerMm3'], [0, 0, 0])

    def test_forward_slip_has_independent_cap_and_dissipation(self):
        result = self.state(relativeIncrementMm=(.05, 0, 0))
        self.assertEqual(result['status'], 'slip')
        self.vector_close(result['tangentialTractionMPa'], (3, 0, 0))
        self.vector_close(result['tangentialForceN'], (6, 0, 0))
        self.vector_close(result['elasticSlipMm'], (.03, 0, 0))
        self.vector_close(result['plasticSlipIncrementMm'], (.02, 0, 0))
        self.assertAlmostEqual(result['addedDissipationNmm'], .12, places=14)
        self.assertAlmostEqual(result['accumulatedDissipationNmm'], .12, places=14)
        self.assertAlmostEqual(result['elasticEnergyNmm'], .09, places=14)
        self.assertEqual(result['releasedElasticEnergyNmm'], 0)

    def test_reverse_slip_uses_accepted_history_and_keeps_dissipation_positive(self):
        forward = self.state(relativeIncrementMm=(.05, 0, 0))
        result = self.state(previousElasticSlipMm=forward['elasticSlipMm'],
                            accumulatedDissipationNmm=forward['accumulatedDissipationNmm'],
                            relativeIncrementMm=(-.08, 0, 0))
        self.assertEqual(result['status'], 'slip')
        self.vector_close(result['tangentialTractionMPa'], (-3, 0, 0))
        self.vector_close(result['tangentialForceN'], (-6, 0, 0))
        self.vector_close(result['elasticSlipMm'], (-.03, 0, 0))
        self.vector_close(result['plasticSlipIncrementMm'], (-.02, 0, 0))
        self.assertAlmostEqual(result['addedDissipationNmm'], .12, places=14)
        self.assertAlmostEqual(result['accumulatedDissipationNmm'], .24, places=14)

    def test_separation_releases_elastic_energy_without_inventing_dissipation(self):
        result = self.state(gapMm=.01, previousElasticSlipMm=(.03, 0, 0),
                            accumulatedDissipationNmm=.24, relativeIncrementMm=(10, -9, 3))
        self.assertEqual(result['status'], 'open')
        self.assertEqual(result['normalForceN'], 0)
        self.vector_close(result['tangentialForceN'], (0, 0, 0))
        self.vector_close(result['elasticSlipMm'], (0, 0, 0))
        self.vector_close(result['plasticSlipIncrementMm'], (0, 0, 0))
        self.assertEqual(result['addedDissipationNmm'], 0)
        self.assertEqual(result['accumulatedDissipationNmm'], .24)
        self.assertEqual(result['elasticEnergyNmm'], 0)
        self.assertAlmostEqual(result['releasedElasticEnergyNmm'], .09, places=14)
        self.assertEqual(result['tractionTangentNPerMm3'], [[0] * 3 for _ in range(3)])

    def test_two_tangent_components_use_a_circular_not_square_friction_limit(self):
        result = self.state(relativeIncrementMm=(.03, .04, 0))
        self.vector_close(result['tangentialTractionMPa'], (1.8, 2.4, 0))
        self.vector_close(result['tangentialForceN'], (3.6, 4.8, 0))
        self.vector_close(result['elasticSlipMm'], (.018, .024, 0))
        self.vector_close(result['plasticSlipIncrementMm'], (.012, .016, 0))
        self.assertAlmostEqual(math.hypot(*result['tangentialForceN']), 6, places=13)
        self.assertAlmostEqual(result['addedDissipationNmm'], .12, places=14)
        self.vector_close(result['normalCouplingNPerMm3'], (-180, -240, 0))
        for actual, expected in zip(result['tangentialTangentNPerMm3'],
                                    ((38.4, -28.8, 0), (-28.8, 21.6, 0), (0, 0, 0))):
            self.vector_close(actual, expected)

    def test_second_tangent_direction_has_same_independent_response(self):
        result = self.state(relativeIncrementMm=(0, .05, 0))
        self.vector_close(result['tangentialForceN'], (0, 6, 0))
        self.vector_close(result['elasticSlipMm'], (0, .03, 0))
        self.assertAlmostEqual(result['addedDissipationNmm'], .12, places=14)

    def test_rotated_normal_and_history_preserve_force_and_energy(self):
        result = self.state(normal=rotated((0, 0, 1)), relativeIncrementMm=rotated((.03, .04, 0)))
        self.vector_close(result['tangentialTractionMPa'], rotated((1.8, 2.4, 0)))
        self.vector_close(result['tractionMPa'], rotated((1.8, 2.4, -10)))
        self.assertAlmostEqual(result['addedDissipationNmm'], .12, places=13)
        reverse = self.state(normal=rotated((0, 0, 1)), previousElasticSlipMm=rotated((.03, 0, 0)),
                             relativeIncrementMm=rotated((-.08, 0, 0)))
        self.vector_close(reverse['tangentialTractionMPa'], rotated((-3, 0, 0)))
        self.assertAlmostEqual(reverse['addedDissipationNmm'], .12, places=13)

    def test_pure_normal_increment_does_not_create_tangential_slip(self):
        result = self.state(relativeIncrementMm=(0, 0, -.02))
        self.vector_close(result['tangentialForceN'], (0, 0, 0))
        self.assertEqual(result['addedDissipationNmm'], 0)
        self.vector_close(result['plasticSlipIncrementMm'], (0, 0, 0))

    def test_zero_and_null_coefficients_match_frictionless_contact(self):
        triangle = [(0, 0, 0), (2, 0, 0), (0, 2, 0)]
        frictionless = contactResidualAndTangent(triangle, triangle, (0, 0, 1), -.01, 1000)
        for coefficient, source in ((0, 'explicit-zero'), (None, None)):
            with self.subTest(coefficient=coefficient):
                result = self.state(mu=coefficient, sourceId=source, relativeIncrementMm=(.03, .04, 0))
                self.assertEqual(result['status'], 'frictionless')
                self.assertAlmostEqual(result['normalForceN'], 20, places=13)
                self.assertAlmostEqual(result['normalForceN'], frictionless['compressiveResultantN'], places=13)
                self.vector_close(result['tangentialForceN'], (0, 0, 0))
                self.vector_close(result['elasticSlipMm'], (0, 0, 0))
                self.assertEqual(result['addedDissipationNmm'], 0)
                self.assertEqual(result['tangentialTangentNPerMm3'], [[0] * 3 for _ in range(3)])
                self.assertEqual(result['tractionTangentNPerMm3'], [[0, 0, 0], [0, 0, 0], [0, 0, 1000]])

    def test_contact_and_cone_boundaries_have_explicit_one_sided_policies(self):
        boundary = self.state(relativeIncrementMm=(.03, 0, 0))
        self.assertEqual(boundary['status'], 'stick')
        self.assertEqual(boundary['tangentialTangentNPerMm3'][0][0], 100)
        opened = self.state(gapMm=0, previousElasticSlipMm=(.03, 0, 0))
        self.assertEqual(opened['status'], 'open')
        self.assertAlmostEqual(opened['releasedElasticEnergyNmm'], .09, places=14)

    def test_central_difference_checks_stick_and_slip_tangents(self):
        errors = []
        for increment in ((.01, .005, 0), (.03, .04, 0)):
            base = self.state(relativeIncrementMm=increment)
            difference, expected = [], []
            h = 1e-7
            for column in range(3):
                plus, minus = list(increment), list(increment)
                plus[column] += h
                minus[column] -= h
                positive = self.state(relativeIncrementMm=plus)
                negative = self.state(relativeIncrementMm=minus)
                self.assertEqual(positive['status'], base['status'])
                self.assertEqual(negative['status'], base['status'])
                for row in range(3):
                    actual = (positive['tangentialTractionMPa'][row] - negative['tangentialTractionMPa'][row]) / (2 * h)
                    target = base['tangentialTangentNPerMm3'][row][column]
                    difference.append(actual - target)
                    expected.append(target)
            error = math.hypot(*difference) / math.hypot(*expected)
            errors.append(error)
            self.assertLessEqual(error, 1e-5)
        print('W19 tangential derivatives ' + json.dumps({'relativeErrors': errors, 'limit': 1e-5}))

    def test_normal_coupling_and_full_tangent_are_not_falsely_symmetrized(self):
        increment = (.03, .04, 0)
        base = self.state(relativeIncrementMm=increment)
        h = 1e-7
        positive = self.state(relativeIncrementMm=increment, gapMm=-.01 + h)
        negative = self.state(relativeIncrementMm=increment, gapMm=-.01 - h)
        for axis in range(3):
            derivative = (positive['tangentialTractionMPa'][axis] - negative['tangentialTractionMPa'][axis]) / (2 * h)
            self.assertAlmostEqual(derivative, (-180, -240, 0)[axis], places=7)
        self.assertEqual(base['tractionTangentNPerMm3'][2][0], 0)
        self.assertAlmostEqual(base['tractionTangentNPerMm3'][0][2], -180, places=12)
        difference, expected = [], []
        for column in range(3):
            plus, minus = list(increment), list(increment)
            plus[column] += h
            minus[column] -= h
            positive = self.state(relativeIncrementMm=plus, gapMm=-.01 + (h if column == 2 else 0))
            negative = self.state(relativeIncrementMm=minus, gapMm=-.01 - (h if column == 2 else 0))
            for row in range(3):
                derivative = (positive['tractionMPa'][row] - negative['tractionMPa'][row]) / (2 * h)
                target = base['tractionTangentNPerMm3'][row][column]
                difference.append(derivative - target)
                expected.append(target)
        error = math.hypot(*difference) / math.hypot(*expected)
        self.assertLessEqual(error, 1e-5)
        print('W19 full nonsymmetric derivative ' + json.dumps({'relative': error, 'limit': 1e-5}))

    def test_four_state_force_cones_and_dissipation_have_independent_scales(self):
        cases = [self.state(), self.state(relativeIncrementMm=(.05, 0, 0)),
                 self.state(previousElasticSlipMm=(.03, 0, 0), relativeIncrementMm=(-.08, 0, 0)),
                 self.state(gapMm=.01)]
        for result, expected_force, expected_work in zip(cases, (2, 6, 6, 0), (0, .12, .12, 0)):
            actual_force = math.hypot(*result['tangentialForceN'])
            self.assertAlmostEqual(actual_force, expected_force, places=13)
            self.assertAlmostEqual(result['addedDissipationNmm'], expected_work, places=13)
            self.assertLessEqual(actual_force, .3 * result['normalForceN'] + 1e-8 * 20)
            self.assertGreaterEqual(result['addedDissipationNmm'], -1e-10 * .64)
        print('W19 independent four states ' + json.dumps({'forcesN': [math.hypot(*r['tangentialForceN']) for r in cases],
              'expectedForcesN': [2, 6, 6, 0], 'dissipationNmm': [r['addedDissipationNmm'] for r in cases],
              'expectedDissipationNmm': [0, .12, .12, 0]}))

    def test_friction_work_equals_traction_dot_plastic_increment_times_area(self):
        result = self.state(relativeIncrementMm=(.03, .04, 0))
        work = 2 * math.fsum(a * b for a, b in zip(result['tangentialTractionMPa'], result['plasticSlipIncrementMm']))
        self.assertAlmostEqual(work, .12, places=14)
        self.assertAlmostEqual(result['addedDissipationNmm'], work, places=14)

    def test_input_history_and_normal_are_not_mutated(self):
        args = dict(normal=[0, 0, 1], previousElasticSlipMm=[.01, 0, 0],
                    relativeIncrementMm=[.05, 0, 0])
        before = copy.deepcopy(args)
        self.state(**args)
        self.assertEqual(args, before)

    def test_missing_or_invalid_source_is_refused_even_for_numeric_zero(self):
        for source in (None, '', ' ', ' padded ', '\nsource', 'x' * 257, 3):
            with self.subTest(source=repr(source)[:20]), self.assertRaises(ValueError):
                self.state(mu=0, sourceId=source)
        with self.assertRaisesRegex(ValueError, 'null source'):
            self.state(mu=None, sourceId='invented')
        valid = self.state(mu=0, sourceId='explicit-zero')
        self.assertEqual(valid['sourceId'], 'explicit-zero')

    def test_bad_coefficients_and_nonfinite_scalar_inputs_are_refused(self):
        for coefficient in (-.1, 1.1, float('nan'), float('inf'), True, '0.3'):
            with self.subTest(coefficient=coefficient), self.assertRaises(ValueError):
                self.state(mu=coefficient)
        for name in ('gapMm', 'knNPerMm3', 'ktNPerMm3', 'areaMm2', 'accumulatedDissipationNmm'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.state(**{name: float('nan')})
        for name in ('knNPerMm3', 'ktNPerMm3', 'areaMm2'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.state(**{name: 0})

    def test_invalid_accepted_state_is_rejected_not_projected_or_clamped(self):
        for elastic in ((.01, 0, .001), (0, 0, float('inf')), [0, 0]):
            with self.subTest(elastic=elastic), self.assertRaises(ValueError):
                self.state(previousElasticSlipMm=elastic)
        with self.assertRaisesRegex(ValueError, 'negative'):
            self.state(accumulatedDissipationNmm=-.01)
        for direction in ((0, 0, 0), (0, 0, 2), (0, float('nan'), 1)):
            with self.subTest(direction=direction), self.assertRaises(ValueError):
                self.state(normal=direction)
        with self.assertRaises(ValueError):
            self.state(relativeIncrementMm=(0, True, 0))


if __name__ == '__main__':
    unittest.main()
