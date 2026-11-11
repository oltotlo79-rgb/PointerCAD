"""W20-A history ownership and actual packaged native-Newton independent cases."""

from copy import deepcopy
import math
import unittest

from solidContactSolver import (ContactHistory, ContactIncrementError, FixedContactPatch,
                                SolidContactRun, solveSolidContactIncrement)


def local_patch(**changes):
    points = [(0, 0, 0), (2, 0, 0), (0, 2, 0)] * 2
    definition = {'id': 'pair', 'masterBody': 'master', 'slaveBody': 'slave',
                  'masterFace': 'master-face', 'slaveFace': 'slave-face',
                  'masterNodes': [0, 1, 2], 'slaveNodes': [0, 1, 2],
                  'normal': [0, 0, 1], 'initialGapMm': 0, 'knNPerMm3': 1e6,
                  'ktNPerMm3': 100, 'mu': .3, 'sourceId': 'independent-test',
                  'referenceLengthMm': 2, 'referenceForceN': 1}
    definition.update(changes)
    return FixedContactPatch(definition, points, {'master': [0, 1, 2], 'slave': [3, 4, 5]})


def local_displacement(tangent=.005, gap=-5e-7):
    return [0.0] * 9 + [tangent, 0.0, gap] * 3


class HistoryOwnership(unittest.TestCase):
    def test_repeated_trial_evaluation_does_not_accumulate_dissipation(self):
        patch = local_patch()
        history = ContactHistory([patch])
        before = history.snapshot()
        history.begin([patch])
        first = history.evaluate(patch, local_displacement())
        second = history.evaluate(patch, local_displacement())
        self.assertEqual(first, second)
        self.assertEqual(history.snapshot(), before)
        history.commit(0)
        self.assertAlmostEqual(sum(point['accumulatedDissipationNmm'] for point in history.snapshot().values()), .00105, places=14)
        self.assertEqual(history.step, 1)

    def test_point_order_change_preserves_semantic_history(self):
        patch = local_patch()
        left, right = ContactHistory([patch]), ContactHistory([patch])
        left.begin([patch])
        right.begin([patch], point_order=list(reversed(list(right.snapshot()))))
        left.evaluate(patch, local_displacement())
        right.evaluate(patch, local_displacement())
        left.commit(0)
        right.commit(0)
        self.assertEqual(left.snapshot(), right.snapshot())

    def test_missing_or_duplicate_point_key_is_refused_before_state_changes(self):
        patch = local_patch()
        history = ContactHistory([patch])
        before = history.snapshot()
        keys = list(before)
        for changed in (keys[:-1], [keys[0]] * len(keys), keys + ['unknown']):
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'point keys'):
                history.begin([patch], point_order=changed)
        self.assertEqual(history.snapshot(), before)

    def test_changed_condition_is_not_applied_to_old_history(self):
        patch = local_patch()
        history = ContactHistory([patch])
        before = history.snapshot()
        for changed in (local_patch(mu=.4), local_patch(ktNPerMm3=101), local_patch(sourceId='other')):
            with self.subTest(condition=changed.condition), self.assertRaisesRegex(ValueError, 'conditions changed'):
                history.begin([changed])
        self.assertEqual(history.snapshot(), before)

    def test_nonconverged_trial_is_not_committed_and_run_cannot_resume(self):
        patch = local_patch()
        history = ContactHistory([patch])
        before = history.snapshot()
        history.begin([patch])
        history.evaluate(patch, local_displacement())
        with self.assertRaisesRegex(ValueError, 'residual'):
            history.commit(1e-3)
        history.abandon()
        self.assertEqual(history.snapshot(), before)
        with self.assertRaisesRegex(ValueError, 'cannot be reused'):
            history.begin([patch])

    def test_cancellation_after_trial_preserves_accepted_state(self):
        patch = local_patch()
        history = ContactHistory([patch])
        before, cancellation = history.snapshot(), [False]
        history.begin([patch], cancelled=lambda: cancellation[0])
        history.evaluate(patch, local_displacement())
        cancellation[0] = True
        with self.assertRaisesRegex(ValueError, 'cancelled'):
            history.commit(0)
        history.abandon()
        self.assertEqual(history.snapshot(), before)

    def test_opening_and_recontact_use_last_accepted_open_position(self):
        patch = local_patch()
        history = ContactHistory([patch])
        history.begin([patch])
        history.evaluate(patch, local_displacement())
        history.commit(0)
        dissipated = sum(row['accumulatedDissipationNmm'] for row in history.snapshot().values())
        history.begin([patch])
        opened = history.evaluate(patch, local_displacement(.01, 5e-7))
        history.commit(0)
        self.assertAlmostEqual(sum(p['law']['releasedElasticEnergyNmm'] for p in opened['points'].values()), .000225, places=14)
        history.begin([patch])
        recontact = history.evaluate(patch, local_displacement(.01, -5e-7))
        history.commit(0)
        for point in recontact['points'].values():
            self.assertEqual(point['law']['addedDissipationNmm'], 0)
            self.assertAlmostEqual(math.hypot(*point['law']['tangentialForceN']), 0, places=14)
        self.assertAlmostEqual(sum(row['accumulatedDissipationNmm'] for row in history.snapshot().values()), dissipated, places=14)

    def test_partial_contact_is_refused_without_history_transfer(self):
        patch = local_patch()
        history = ContactHistory([patch])
        before = history.snapshot()
        history.begin([patch])
        displacement = local_displacement()
        displacement[14] = 5e-7
        with self.assertRaisesRegex(ValueError, 'partial contact'):
            history.evaluate(patch, displacement)
        self.assertEqual(history.snapshot(), before)

    def test_incomplete_patch_evaluation_cannot_commit(self):
        patch = local_patch()
        history = ContactHistory([patch])
        history.begin([patch])
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            history.commit(0)

    def test_physical_complementarity_quantities_are_distinct_and_dimensioned(self):
        patch = local_patch()
        history = ContactHistory([patch])
        history.begin([patch])
        result = history.evaluate(patch, local_displacement())
        physical = [point['physical'] for point in result['points'].values()]
        for point in physical:
            self.assertAlmostEqual(point['pressureMPa'], .5, places=14)
            self.assertAlmostEqual(point['gapMm'], -5e-7, places=20)
            self.assertAlmostEqual(point['pressureGapNPerMm'], -2.5e-7, places=20)
            self.assertAlmostEqual(point['forceGapNmm'], -.5e-6 / 3, places=20)
        self.assertAlmostEqual(sum(p['dimensionlessForceGap'] for p in physical), -2.5e-7, places=20)

    def test_owned_inputs_and_returned_snapshots_do_not_mutate_accepted_state(self):
        patch = local_patch()
        history = ContactHistory([patch])
        displacement = local_displacement()
        before_displacement = deepcopy(displacement)
        history.begin([patch])
        history.evaluate(patch, displacement)
        history.commit(0)
        snapshot = history.snapshot()
        snapshot[next(iter(snapshot))]['elasticSlipMm'][0] = 999
        self.assertEqual(displacement, before_displacement)
        self.assertLess(history.snapshot()[next(iter(snapshot))]['elasticSlipMm'][0], 1)


def native_shear_bar_plan(*, max_iterations=50, first_load_only=False):
    nodes = [(x, y, z) for pair in ((0, 100), (100, 101))
             for x in pair for y in (0, 10) for z in (0, 20)]
    pattern = ((0, 4, 6, 7), (0, 6, 2, 7), (0, 2, 3, 7),
               (0, 3, 1, 7), (0, 1, 5, 7), (0, 5, 4, 7))
    loads_y = [1] if first_load_only else [.1, 1, 1, 1, 2]
    closing_x = [5e-7] if first_load_only else [5e-7, 5e-7, -5e-7, 5e-7, 5e-7]
    steps = len(loads_y)
    prescribed = {}
    for node in range(16):
        for axis in range(3):
            if 4 <= node < 8 and axis == 1:
                continue
            prescribed[(node, axis)] = list(closing_x) if 4 <= node < 8 and axis == 0 else [0] * steps
    contacts = []
    for index, (slave, master) in enumerate((((4, 6, 7), (0, 2, 3)), ((4, 7, 5), (0, 3, 1)))):
        contacts.append({'id': f'patch-{index}', 'masterBody': 'stop', 'slaveBody': 'bar',
                         'masterFace': f'stop-face-{index}', 'slaveFace': f'bar-face-{index}',
                         'masterNodes': list(master), 'slaveNodes': list(slave), 'normal': [-1, 0, 0],
                         'initialGapMm': 0, 'knNPerMm3': 10000, 'ktNPerMm3': 10000,
                         'mu': .3, 'sourceId': 'independent-native-shear-oracle',
                         'referenceLengthMm': 10, 'referenceForceN': 1})
    return {'nodes': nodes, 'elements': [[node + offset for node in tet] for offset in (0, 8) for tet in pattern],
            'bodies': {'bar': list(range(8)), 'stop': list(range(8, 16))}, 'youngMPa': 210000, 'poisson': 0,
            'steps': steps, 'maxIterations': max_iterations, 'prescribed': prescribed,
            'loads': {(node, 1): [value * weight for value in loads_y]
                      for node, weight in zip(range(4, 8), (1 / 3, 1 / 6, 1 / 6, 1 / 3))}, 'contacts': contacts}


def run_native_history():
    import oofem as fem
    plan = native_shear_bar_plan()
    run = SolidContactRun(fem, plan, '/pcad_fem/contact-history')
    for offset, element in enumerate(run.native_elements, len(plan['elements']) + 1):
        assert isinstance(element, fem.StructuralElement)
        assert run.domain.giveElement(offset) is element
        assert element.giveCrossSection().giveNumber() == 1
        assert element.giveNumberOfDofManagers() == 6
    expected_u = [.1 / 2210000, .7 / 210000, 1 / 210000, 1 / 210000, 1.7 / 210000]
    expected_force = [2000000 * expected_u[0], .3, 0, 0, .3]
    expected_added = [0, .3 * (expected_u[1] - .3 / 2000000), 0, 0,
                      .3 * (expected_u[4] - expected_u[3] - .3 / 2000000)]
    observed = []
    try:
        for index, expected in enumerate(expected_u):
            # Reverse point iteration order on one accepted increment: identity
            # is the material point key, not the array position.
            order = list(reversed(list(run.history.snapshot()))) if index == 1 else None
            record = solveSolidContactIncrement(run, point_order=order)
            actual_u = [record['displacementMm'][node][1] for node in range(4, 8)]
            points = [point for contact in record['contacts'].values() for point in contact['points'].values()]
            force = sum(point['law']['tangentialForceN'][1] for point in points)
            added = sum(point['law']['addedDissipationNmm'] for point in points)
            actual_normal = sum(point['physical']['normalForceN'] for point in points)
            physical = [point['physical'] for point in points]
            observed.append({'step': index + 1, 'expectedDisplacementMm': expected, 'actualDisplacementMm': actual_u,
                             'maximumRelativeDisplacementError': max(abs(value - expected) / abs(expected) for value in actual_u),
                             'expectedTangentialForceN': expected_force[index], 'actualTangentialForceN': force,
                             'expectedAddedDissipationNmm': expected_added[index], 'actualAddedDissipationNmm': added,
                             'actualNormalForceN': actual_normal, 'expectedNormalForceN': 0 if index == 2 else 1,
                             'freeResidual': record['freeResidual'], 'nativeCallbacks': record['nativeCallbacks'],
                             'nativeEquationCount': record['nativeEquationCount'], 'physical': physical,
                             'strictComplementarityQualified': record['strictComplementarityQualified'],
                             'matrixType': record['requestedNativeMatrixType']})
        verification_input = {
            'geometry': {key: plan[key] for key in ('nodes', 'elements', 'bodies')},
            'boundary': {
                'prescribed': [{'node': node, 'axis': axis, 'values': values}
                               for (node, axis), values in plan['prescribed'].items()],
                'loads': [{'node': node, 'axis': axis, 'values': values}
                          for (node, axis), values in plan['loads'].items()],
                'contacts': plan['contacts'], 'steps': plan['steps'], 'maxIterations': plan['maxIterations'],
            },
            'material': {key: plan[key] for key in ('youngMPa', 'poisson')},
            'units': 'N-mm-MPa', 'source': 'solidContactConvergence.test.py:native_shear_bar_plan',
        }
        return {'success': True, 'states': observed, 'acceptedStepCount': run.history.step,
                'contactElementCount': len(run.native_elements), 'callbacks': run.counters,
                'verificationInput': verification_input}
    finally:
        run.close()


def run_native_iteration_failure():
    import oofem as fem
    run = SolidContactRun(fem, native_shear_bar_plan(max_iterations=1, first_load_only=True), '/pcad_fem/contact-insufficient')
    before = run.history.snapshot()
    try:
        solveSolidContactIncrement(run)
    except ContactIncrementError as error:
        if 'residual' not in str(error) and 'converg' not in str(error):
            raise
        if run.history.snapshot() != before or run.history.step != 0 or run.records:
            raise AssertionError('Failed native iteration committed history') from error
        if run.counters['tangent'] == 0 or run.counters['residual'] == 0:
            raise AssertionError('Failure did not exercise actual native contact iteration') from error
        try:
            solveSolidContactIncrement(run)
        except ValueError as reuse:
            if 'cannot be reused' not in str(reuse):
                raise
        else:
            raise AssertionError('Failed native run was reused')
        return {'successResultCount': 0, 'acceptedUnchanged': True, 'acceptedStepCount': 0,
                'nativeCallbacks': run.counters, 'failure': error.failure}
    finally:
        run.close()
    raise AssertionError('One-iteration closed/sliding solve unexpectedly accepted')


def run_native_cancellation():
    import oofem as fem
    run = SolidContactRun(fem, native_shear_bar_plan(), '/pcad_fem/contact-cancelled')
    before = run.history.snapshot()
    calls = [0]

    def cancelled():
        calls[0] += 1
        return calls[0] >= 3

    try:
        solveSolidContactIncrement(run, cancelled=cancelled)
    except ContactIncrementError as error:
        if 'cancelled' not in str(error):
            raise
        if run.history.snapshot() != before or run.history.step != 0 or run.records:
            raise AssertionError('Cancelled native attempt committed history') from error
        return {'successResultCount': 0, 'acceptedUnchanged': True, 'acceptedStepCount': 0,
                'cancellationChecks': calls[0], 'nativeCallbacks': run.counters, 'failure': error.failure}
    finally:
        run.close()
    raise AssertionError('Cancelled native trial unexpectedly accepted')


if __name__ == '__main__':
    unittest.main()
