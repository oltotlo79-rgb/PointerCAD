"""Ordinary FEM-suite regression: execute the real production force-check, without OOFEM mocks."""
import copy
import importlib.util
import math
import sys
import unittest

spec = importlib.util.spec_from_file_location('production_solid_plastic', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
check = module.check_free_force_balance


class ForceBalance(unittest.TestCase):
    def ratio(self, actual, expected):
        self.assertTrue(math.isclose(actual, expected, rel_tol=1e-14, abs_tol=0), (actual, expected))

    def test_force_control_unload_retains_actual_nonzero_imbalance(self):
        ratio, reference = check([[1000., 0., 0.]], [[1000., 0., 0.]], set(), 0., 'loaded')
        self.assertEqual((ratio, reference), (0., 1000.))
        ratio, after = check([[1e-12, 0., 0.]], [[0., 0., 0.]], set(), reference, 'unloaded')
        self.ratio(ratio, 1e-15)
        self.assertGreater(ratio, 0.)
        self.assertEqual(after, reference)

    def test_real_free_imbalance_is_still_rejected(self):
        # Independent arithmetic: 1e-4 / 1000 = 1e-7 > 1e-8.
        with self.assertRaisesRegex(ValueError, 'free-DOF force residual'):
            check([[0., 1e-4, 0.], [-3., 0., 0.]], [[0., 0., 0.], [0., 0., 0.]],
                  {(1, 0)}, 1000., 'bad equilibrium')
        self.assertEqual(module.FREE_RESIDUAL_BOUND, 1e-8)

    def test_displacement_control_reference_comes_from_constrained_reaction(self):
        zero = [[0., 0., 0.], [0., 0., 0.]]
        ratio, reference = check([[-1000., 0., 0.], [0., 0., 0.]], zero, {(0, 0)}, 0., 'prescribed')
        self.assertEqual((ratio, reference), (0., 1000.))
        ratio, after = check([[0., 0., 0.], [0., -1e-12, 0.]], zero, {(0, 0)}, reference, 'unloaded')
        self.ratio(ratio, 1e-15)
        self.assertEqual(after, 1000.)

    def test_reversal_and_uniform_force_scaling(self):
        for scale in (1e-9, 1., 1e9):
            for sign in (-1., 1.):
                _, reference = check([[sign * 1000. * scale, 0., 0.]], [[sign * 1000. * scale, 0., 0.]],
                                     set(), 0., 'accepted peak')
                _, reference = check([[-sign * 500. * scale, 0., 0.]], [[-sign * 500. * scale, 0., 0.]],
                                     set(), reference, 'reversed')
                ratio, after = check([[sign * 1e-12 * scale, 0., 0.]], [[0., 0., 0.]], set(), reference, 'zero')
                self.ratio(ratio, 1e-15)
                self.ratio(after, 1000. * scale)
                with self.assertRaisesRegex(ValueError, 'free-DOF force residual'):
                    check([[sign * 1e-4 * scale, 0., 0.]], [[0., 0., 0.]], set(), reference, 'bad zero')

    def test_zero_history_has_no_invented_force_floor(self):
        self.assertEqual(check([[0., 0., 0.]], [[0., 0., 0.]], set(), 0., 'zero'), (0., 0.))
        with self.assertRaisesRegex(ValueError, 'free-DOF force residual'):
            check([[1e-30, 0., 0.]], [[0., 0., 0.]], set(), 0., 'spurious')

    def test_nonfinite_and_invalid_reference_are_refused(self):
        for bad in (math.nan, math.inf, -math.inf):
            for internal, applied, reference in (([[bad, 0., 0.]], [[0., 0., 0.]], 1000.),
                                                   ([[0., 0., 0.]], [[bad, 0., 0.]], 1000.),
                                                   ([[0., 0., 0.]], [[0., 0., 0.]], bad)):
                with self.assertRaisesRegex(ValueError, 'non-finite'):
                    check(internal, applied, set(), reference, 'invalid')
        with self.assertRaisesRegex(ValueError, 'must not be negative'):
            check([[0., 0., 0.]], [[0., 0., 0.]], set(), -1., 'invalid history')

    def test_rejection_does_not_advance_history_or_mutate_inputs(self):
        internal, applied, fixed = [[1e30, 1e30, 0.]], [[0., 0., 0.]], {(0, 0)}
        original = copy.deepcopy((internal, applied, fixed))
        reference = 1000.
        with self.assertRaisesRegex(ValueError, 'free-DOF force residual'):
            _, reference = check(internal, applied, fixed, reference, 'failed step')
        self.assertEqual(reference, 1000.)
        self.assertEqual((internal, applied, fixed), original)
        # A large later load cannot establish a reference before it actually passes.
        with self.assertRaisesRegex(ValueError, 'free-DOF force residual'):
            check([[1e-4, 0., 0.]], [[0., 0., 0.]], set(), reference, 'before future load')
        _, future_reference = check([[1e20, 0., 0.]], [[1e20, 0., 0.]], set(), reference, 'future accepted')
        self.assertEqual(future_reference, 1e20)


suite = unittest.defaultTestLoader.loadTestsFromTestCase(ForceBalance)
assert suite.countTestCases() == 7
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
if not result.wasSuccessful():
    raise SystemExit(1)
print('solid-plastic-force-balance: 7 independent cases passed')
