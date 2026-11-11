"""Pure runtime wiring tests. Native assembly is explicitly stubbed, never run."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

import numpy as np

import beamFrictionRuntime as runtime


def fixture():
    plan = {
        'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 2,
        'nodes': [
            {'number': 1, 'positionM': [0., 0., 0.], 'restrained': [True] * 6, 'load': [0.] * 6},
            {'number': 2, 'positionM': [1., 0., 0.], 'restrained': [False] * 3 + [True] * 3,
             'load': [0.] * 6}],
        'materials': [{'number': 1, 'youngPa': 1000., 'poisson': .25, 'densityKgM3': 1.}],
        'sections': [{'number': 1, 'areaM2': 1., 'iyM4': .1, 'izM4': .1,
                      'torsionM4': .1, 'shearFactor': 1.}],
        'members': [{'number': 1, 'nodes': [1, 2], 'material': 1, 'section': 1,
                     'frame': {'x': [1., 0., 0.], 'y': [0., 1., 0.], 'z': [0., 0., 1.], 'lengthM': 1.}}],
        'contacts': [{'id': 'plane', 'kind': 'node-plane', 'node': 2, 'normal': [0., 0., 1.], 'gapM': 0.}],
        'loadFactors': [1., 0., -1.]}
    load = [0.] * 12
    load[6], load[8] = 5., -10.
    return plan, {'plane': .3}, [load, [0.] * 12, [-v for v in load]]


class FrictionRuntimeTests(unittest.TestCase):
    def test_callback_once_preserves_all_steps_zero_and_json_contract(self):
        plan, friction, loads = fixture()
        original = deepcopy((plan, friction, loads))
        stiffness = object()
        result = {'kind': 'core-result', 'states': [{'step': 0}, {'step': 1}, {'step': 2}]}

        def native(assembled, *, solve_system):
            self.assertIsNot(assembled, plan)
            return json.dumps(solve_system(np, assembled, stiffness, 1.), allow_nan=False)

        with patch.object(runtime, 'run_beam_contact', side_effect=native) as entry, \
                patch.object(runtime, 'solve_friction_steps', return_value=result) as core:
            output = runtime.run_beam_friction_contact(plan, friction, loads, solver='nsgs', max_iterations=7)
        entry.assert_called_once()
        args, kwargs = core.call_args
        self.assertEqual(args[1], original[0])
        self.assertIs(args[2], stiffness)
        self.assertEqual(args[3:], (1., original[1], original[2]))
        self.assertEqual(kwargs, {'solver': 'nsgs', 'max_iterations': 7})
        self.assertEqual(json.loads(output), result)
        self.assertEqual((plan, friction, loads), original)
        self.assertIsNot(args[1], entry.call_args.args[0])
        self.assertIsNot(args[4], friction)
        self.assertIsNot(args[5][0], loads[0])

    def test_caller_mutation_during_native_start_cannot_change_owned_analysis(self):
        plan, friction, loads = fixture()
        original = deepcopy((plan, friction, loads))

        def native(assembled, *, solve_system):
            plan['nodes'][1]['positionM'][0] = 99.
            friction['plane'] = 99.
            loads[0][6] = 99.
            return solve_system(np, assembled, None, 1.)

        with patch.object(runtime, 'run_beam_contact', side_effect=native), \
                patch.object(runtime, 'solve_friction_steps', return_value='owned') as core:
            self.assertEqual(runtime.run_beam_friction_contact(plan, friction, loads), 'owned')
        args = core.call_args.args
        self.assertEqual((args[1], args[4], args[5]), original)

    def test_mutated_callback_plan_or_moment_length_is_refused(self):
        for change in ('plan', 'length'):
            with self.subTest(change=change):
                plan, friction, loads = fixture()
                original = deepcopy(plan)

                def native(assembled, *, solve_system):
                    if change == 'plan':
                        assembled['nodes'][1]['load'][0] = 1.
                    return solve_system(np, assembled, None, 2. if change == 'length' else 1.)

                with patch.object(runtime, 'run_beam_contact', side_effect=native), \
                        patch.object(runtime, 'solve_friction_steps') as core:
                    with self.assertRaisesRegex(ValueError, 'friction-callback'):
                        runtime.run_beam_friction_contact(plan, friction, loads)
                    core.assert_not_called()
                self.assertEqual(plan, original)

    def test_invalid_inputs_never_start_native(self):
        cases = [
            ('plan', None), ('plan', {}), ('mu', {}), ('mu', {'plane': -.1}),
            ('mu', {'plane': True}), ('mu', {'plane': float('nan')}),
            ('mu', {'plane': float('inf')}), ('mu', {'plane': .3, 'extra': .2}),
            ('loads', []), ('loads', None), ('loads', [[0.] * 11]),
            ('loads', [[0.] * 11 + [True]]), ('loads', [[0.] * 11 + [float('nan')]]),
            ('loads', [[0.] * 11 + [float('inf')]]), ('loads', [[0.] * 11 + [1e31]]),
            ('loads', [[0.] * 12] * 33), ('solver', 'other'), ('solver', None),
            ('budget', 0), ('budget', -1), ('budget', True), ('budget', 1.5), ('budget', '2')]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                plan, friction, loads = fixture()
                kwargs = {}
                if field == 'plan': plan = value
                if field == 'mu': friction = value
                if field == 'loads': loads = value
                if field == 'solver': kwargs['solver'] = value
                if field == 'budget': kwargs['max_iterations'] = value
                with patch.object(runtime, 'run_beam_contact') as entry:
                    with self.assertRaises(ValueError):
                        runtime.run_beam_friction_contact(plan, friction, loads, **kwargs)
                    entry.assert_not_called()

    def test_native_and_core_exception_identity_is_retained(self):
        for stage in ('native', 'core'):
            with self.subTest(stage=stage):
                plan, friction, loads = fixture()
                error = RuntimeError(stage)

                def native(assembled, *, solve_system):
                    if stage == 'native': raise error
                    return solve_system(np, assembled, None, 1.)

                with patch.object(runtime, 'run_beam_contact', side_effect=native), \
                        patch.object(runtime, 'solve_friction_steps', side_effect=error):
                    with self.assertRaises(RuntimeError) as caught:
                        runtime.run_beam_friction_contact(plan, friction, loads)
                self.assertIs(caught.exception, error)

    def test_second_callback_is_not_a_second_analysis(self):
        plan, friction, loads = fixture()

        def native(assembled, *, solve_system):
            solve_system(np, assembled, None, 1.)
            return solve_system(np, assembled, None, 1.)

        with patch.object(runtime, 'run_beam_contact', side_effect=native), \
                patch.object(runtime, 'solve_friction_steps', return_value={}) as core:
            with self.assertRaisesRegex(ValueError, 'more than once'):
                runtime.run_beam_friction_contact(plan, friction, loads)
            core.assert_called_once()

    def test_actual_core_independent_unit_spring_slips_at_three_newtons(self):
        # Kt=Kn=1 N/m. Applied N=10, Fx=5; mu*N=3, so ux=(5-3)/1=2 m, uz=0.
        # K is a pure test matrix, not a claim of native assembly success.
        plan, friction, loads = fixture()
        matrix = np.zeros((12, 12))
        matrix[6:9, 6:9] = np.eye(3)

        def native(assembled, *, solve_system):
            return json.dumps(solve_system(np, assembled, matrix, 1.), allow_nan=False)

        with patch.object(runtime, 'run_beam_contact', side_effect=native) as entry:
            result = json.loads(runtime.run_beam_friction_contact(plan, friction, loads[:1]))
        entry.assert_called_once()
        state = result['states'][0]
        contact = state['contacts'][0]
        self.assertEqual(contact['state'], 'slip')
        self.assertAlmostEqual(contact['normalReactionN'], 10., delta=1e-9)
        np.testing.assert_allclose(contact['frictionForceN'], [-3., 0., 0.], rtol=0, atol=1e-9)
        np.testing.assert_allclose(state['nodes'][1]['displacementM'], [2., 0., 0.], rtol=0, atol=1e-9)


if __name__ == '__main__':
    unittest.main()
