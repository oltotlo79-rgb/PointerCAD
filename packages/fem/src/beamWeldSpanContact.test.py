"""Pure NumPy coupled checks. K/C and fractions are Root's independent contract.
No native OOFEM assembly, no old core suite execution, no installation.
"""
from pathlib import Path
from unittest.mock import patch
import copy
import json
import unittest
import numpy as np
import beamContact as contact
import beamWeldSpanContact as subject


def fixture(elements=1, factors=None):
    positions = [0, 2, 0, 2] + ([1, 1] if elements == 2 else [])
    nodes = [{'number':i+1, 'positionM':[x, 0, 0],
              'restrained':[True]*6 if i in (0, 2) else [False, True, True, True, True, True],
              'load':[1 if i == 3 else 0, 0, 0, 0, 0, 0]} for i, x in enumerate(positions)]
    members = []
    groups = [('a', [(1, 2)]), ('b', [(3, 4)])] if elements == 1 else [('a', [(1, 5), (5, 2)]), ('b', [(3, 6), (6, 4)])]
    for name, edges in groups:
        for a, b in edges:
            members.append({'number':len(members)+1, 'id':name, 'componentId':name, 'occurrencePath':[name],
                            'nodes':[a, b], 'material':1, 'section':1,
                            'frame':{'x':[1, 0, 0], 'y':[0, 1, 0], 'z':[0, 0, 1], 'lengthM':2/elements}})
    return {'schema':subject.PLAN_SCHEMA, 'contact':{
        'schema':'pointercad-oofem-contact-plan/1', 'originalNodeCount':4, 'nodes':nodes,
        'materials':[{'number':1, 'youngPa':1000, 'poisson':.25, 'densityKgM3':1}],
        'sections':[{'number':1, 'areaM2':1, 'iyM4':.1, 'izM4':.1, 'torsionM4':.2, 'shearFactor':1}],
        'members':members, 'contacts':[{'id':'inactive-stop', 'kind':'node-plane', 'node':4, 'normal':[1, 0, 0], 'gapM':.01}],
        'loadFactors':[1, 0, -1] if factors is None else factors},
        'patches':[{'id':'longitudinal', 'first':{'kind':'span', 'memberId':'a'}, 'second':{'kind':'span', 'memberId':'b'},
                    'centerM':[1, 0, 0], 'normal':[0, 1, 0], 'along':[1, 0, 0], 'widthM':2, 'lengthM':1,
                    'thicknessM':.2, 'youngPa':1000, 'poisson':.25}]}


def axial_matrix(plan):
    # Independent EA/l [[1,-1],[-1,1]] for each actual axial element.
    c = plan['contact']
    matrix = np.zeros((6*len(c['nodes']),)*2)
    for member in c['members']:
        a, b = [6*(number-1) for number in member['nodes']]
        k = 1000/member['frame']['lengthM']
        matrix[a, a] += k; matrix[b, b] += k
        matrix[a, b] -= k; matrix[b, a] -= k
    return matrix


def solve(plan):
    return subject.solve_weld_span_contact_system(np, plan, axial_matrix(plan), max(m['frame']['lengthM'] for m in plan['contact']['members']))


class CoupledSpanTests(unittest.TestCase):
    def close(self, actual, expected):
        self.assertTrue(np.isfinite(actual))
        self.assertLessEqual(abs(actual-expected), abs(expected)*1e-9 if expected else 1e-12)

    def check_solution(self, elements, movements, forces, energy, resultant):
        plan = fixture(elements)
        before = copy.deepcopy(plan); matrix = axial_matrix(plan); original_matrix = matrix.copy()
        result = subject.solve_weld_span_contact_system(np, plan, matrix, 2/elements)
        self.assertEqual(plan, before); np.testing.assert_array_equal(matrix, original_matrix)
        self.assertEqual(result['schema'], 'pointercad-weld-span-result/1')
        self.assertEqual(result['contact']['schema'], 'pointercad-oofem-contact-result/1')
        self.assertEqual(result['contact']['meshNodes'], len(plan['contact']['nodes']))
        for factor, state, old in zip([1, 0, -1], result['states'], result['contact']['states'], strict=True):
            self.assertEqual(state['loadFactor'], factor)
            self.assertEqual(len(old['nodes']), 4)
            self.assertEqual(set(old), {'loadFactor', 'pivots', 'nodes', 'contacts', 'forceScaleN', 'gapScaleM',
                                        'equilibriumResidual', 'penetration', 'tension', 'complementarity'})
            self.assertEqual([n['number'] for n in state['meshNodes']], list(range(1, len(plan['contact']['nodes'])+1)))
            for number, u in movements.items(): self.close(state['meshNodes'][number-1]['displacementM'][0], factor*u)
            for node in state['meshNodes']:
                for v in node['displacementM'][1:]+node['rotationRad']: self.close(v, 0)
            w = state['welds'][0]
            self.assertEqual(set(w), {'id', 'first', 'second', 'forceOnFirstN', 'momentAtCenterNm', 'energyJ', 'structuralCertification'})
            self.assertFalse(w['structuralCertification'])
            for number, f in forces.items(): self.close(w['first'][number-1][0], factor*f)
            self.close(w['forceOnFirstN'][0], factor*resultant)
            self.close(w['energyJ'], factor*factor*energy)
            for f in w['forceOnFirstN'][1:]+w['momentAtCenterNm']: self.close(f, 0)
            self.close(sum(row[0] for row in w['first']), factor*resultant)
            self.close(sum(row[0] for row in w['second']), -factor*resultant)
            self.assertEqual(old['contacts'][0]['state'], 'open')
            self.close(old['contacts'][0]['normalReactionN'], 0)
            self.close(old['contacts'][0]['gapM'], .01+factor*movements[4])
        return result

    def test_one_element_per_beam_independent_unequal_endpoint_actions(self):
        self.check_solution(1, {1:0, 2:8/9500, 3:0, 4:11/9500}, {1:4/19, 2:8/19}, 3/45125, 12/19)

    def test_two_elements_internal_four_nonzero_solutions_and_three_unequal_actions(self):
        result = self.check_solution(2, {1:0, 5:47/97000, 2:76/97000, 3:0, 6:50/97000, 4:118/97000},
                                     {1:1/97, 5:18/97, 2:29/97}, 159/2352250, 48/97)
        m = result['states'][0]['meshNodes']
        self.assertNotEqual(m[4]['displacementM'][0], m[1]['displacementM'][0]/2)
        self.assertNotEqual(m[5]['displacementM'][0], m[3]['displacementM'][0]/2)

    def test_callback_none_and_mutating_owned_capture_keep_public_result_exact(self):
        plan = fixture(2)['contact']; matrix = axial_matrix({'contact':plan})
        before = copy.deepcopy(plan)
        default = contact._solve_contact_system(np, plan, matrix, 1)
        explicit = contact._solve_contact_system(np, plan, matrix, 1, capture_full_state=None)
        snapshots = []
        def mutate(factor, full):
            self.assertIsNone(full.base); self.assertEqual(full.shape, (36,))
            snapshots.append(full.copy()); full[:] = 1e10
        captured = contact._solve_contact_system(np, plan, matrix, 1, capture_full_state=mutate)
        self.assertEqual(json.dumps(default), json.dumps(explicit)); self.assertEqual(json.dumps(default), json.dumps(captured))
        self.assertEqual(plan, before); self.assertEqual(len(snapshots), 3)
        self.assertTrue(snapshots[0][30] != 0); self.assertEqual(len(captured['states'][0]['nodes']), 4)

    def test_callback_exception_propagates_instead_of_returning_success(self):
        p = fixture(); before = copy.deepcopy(p)
        def fail(*unused): raise RuntimeError('capture stopped')
        with self.assertRaisesRegex(RuntimeError, 'capture stopped'):
            contact._solve_contact_system(np, p['contact'], axial_matrix(p), 2, capture_full_state=fail)
        self.assertEqual(p, before)

    def test_callback_must_be_callable(self):
        p = fixture()
        with self.assertRaisesRegex(ValueError, 'callable'):
            contact._solve_contact_system(np, p['contact'], axial_matrix(p), 2, capture_full_state=7)

    def test_duplicate_load_factors_keep_exact_original_order_and_captures(self):
        p = fixture(2, [1, -1, 0, 1])
        result = solve(p)
        self.assertEqual([s['loadFactor'] for s in result['states']], [1, -1, 0, 1])
        self.assertEqual(result['states'][0], result['states'][3])

    def test_output_mutation_cannot_change_input_or_another_state(self):
        p = fixture(2); before = copy.deepcopy(p); result = solve(p)
        zero = copy.deepcopy(result['states'][1])
        result['states'][0]['meshNodes'][4]['displacementM'][0] = 999
        result['states'][0]['welds'][0]['first'][0][0] = 999
        self.assertEqual(p, before); self.assertEqual(result['states'][1], zero)

    def test_missing_capture_is_rejected_without_zero_filling(self):
        p = fixture(2)
        def omit(np_arg, c, k, length, *, capture_full_state):
            return contact._solve_contact_system(np_arg, c, k, length)
        with patch.object(subject, '_solve_contact_system', omit), self.assertRaisesRegex(ValueError, 'missing full mesh'):
            solve(p)

    def test_bad_full_capture_shape_finite_support_and_factor_are_rejected(self):
        p = fixture(2)
        for kind in ['short', 'nonfinite', 'support', 'factor']:
            def corrupt(np_arg, c, k, length, *, capture_full_state):
                def capture(factor, full):
                    if kind == 'short': full = full[:-6]
                    elif kind == 'nonfinite': full[30] = np.nan
                    elif kind == 'support': full[0] = .1
                    elif kind == 'factor': factor = 999
                    capture_full_state(factor, full)
                return contact._solve_contact_system(np_arg, c, k, length, capture_full_state=capture)
            with self.subTest(kind=kind), patch.object(subject, '_solve_contact_system', corrupt), self.assertRaises(ValueError): solve(p)

    def test_native_matrix_shape_nonfinite_negative_and_asymmetry_are_rejected(self):
        p = fixture(); k = axial_matrix(p)
        bad = [k[:-1], k+np.eye(24)*np.nan, -np.eye(24), k.copy()]
        bad[-1][0, 6] += 5
        for matrix in bad:
            with self.subTest(shape=matrix.shape), self.assertRaises(ValueError):
                subject.solve_weld_span_contact_system(np, p, matrix, 2)

    def test_negative_native_mode_cannot_be_hidden_by_positive_layer(self):
        p = fixture(); k = axial_matrix(p); k[6, 6] = -1
        with self.assertRaisesRegex(ValueError, 'negative native'):
            subject.solve_weld_span_contact_system(np, p, k, 2)

    def test_schema_prestrain_bolt_and_unknown_fields_are_not_implicitly_accepted(self):
        for key in ['initialStrain', 'bolt', 'constant_force', 'unknown']:
            p = fixture(); p[key] = 0
            with self.subTest(key=key), self.assertRaises(ValueError): solve(p)
        p = fixture(); p['schema'] = 'pointercad-weld-layer-plan/1'
        with self.assertRaises(ValueError): solve(p)

    def test_moment_length_and_nonfinite_input_are_rejected(self):
        p = fixture()
        for length in [0, 1, float('inf'), True]:
            with self.subTest(length=length), self.assertRaises(ValueError):
                subject.solve_weld_span_contact_system(np, p, axial_matrix(p), length)
        p['contact']['nodes'][3]['load'][0] = float('nan')
        with self.assertRaises(ValueError): solve(p)

    def test_original_patch_and_node_limits_are_retained(self):
        p = fixture(); p['patches'] *= 65
        with self.assertRaises(ValueError): solve(p)
        p = fixture(); p['contact']['nodes'] += [copy.deepcopy(p['contact']['nodes'][0])]*125
        with self.assertRaises(ValueError): solve(p)

    def test_contact_mechanism_and_redundant_constraints_still_fail(self):
        p = fixture()
        for i in [0, 2]: p['contact']['nodes'][i]['restrained'][0] = False
        with self.assertRaises(ValueError): solve(p)
        p = fixture(); p['contact']['contacts'].append({'id':'redundant', 'kind':'node-plane', 'node':4, 'normal':[.6, .8, 0], 'gapM':.01})
        with self.assertRaises(ValueError): solve(p)




class RuntimeEntryTests(unittest.TestCase):
    """Pure I/O tests: mocked native dispatcher, never a native computation claim."""
    def test_entry_reads_exact_runtime_path_and_dispatches_owned_plan_callback(self):
        from unittest.mock import mock_open
        p = fixture(2); before = copy.deepcopy(p); token_np = object(); token_k = object()
        calls = []
        def native(*, plan, solve_system):
            calls.append(plan)
            self.assertEqual(plan, p['contact']); self.assertIsNot(plan, p['contact'])
            return solve_system(token_np, plan, token_k, 1)
        with patch('builtins.open', mock_open(read_data='unused')) as opened, patch('json.load', return_value=p), \
             patch.object(contact, 'run_beam_contact', side_effect=native) as dispatch, \
             patch.object(subject, 'solve_weld_span_contact_system', return_value='pure-entry-result') as solve_mock:
            self.assertEqual(subject.run_beam_weld_span_contact(), 'pure-entry-result')
            opened.assert_called_once_with('/pcad_fem/weld-span-contact-input.json', encoding='utf-8')
            dispatch.assert_called_once()
            args = solve_mock.call_args.args
            self.assertIs(args[0], token_np); self.assertIs(args[2], token_k); self.assertEqual(args[3], 1)
            self.assertEqual(args[1], p); self.assertIsNot(args[1], p)
            self.assertIs(args[1]['contact'], calls[0])
            calls[0]['nodes'][0]['load'][0] = 999
        self.assertEqual(p, before)

    def test_entry_refuses_invalid_plan_before_native_or_callback(self):
        from unittest.mock import mock_open
        for bad in ['schema', 'extra', 'patch-limit', 'nonfinite']:
            p = fixture()
            if bad == 'schema': p['schema'] = 'pointercad-weld-layer-plan/1'
            elif bad == 'extra': p['initialStrain'] = 0
            elif bad == 'patch-limit': p['patches'] *= 65
            else: p['patches'][0]['thicknessM'] = float('nan')
            with self.subTest(bad=bad), patch('builtins.open', mock_open(read_data='unused')), patch('json.load', return_value=p), \
                 patch.object(contact, 'run_beam_contact') as native:
                with self.assertRaises(ValueError): subject.run_beam_weld_span_contact()
                native.assert_not_called()

    def test_entry_preserves_same_native_exception(self):
        from unittest.mock import mock_open
        failure = RuntimeError('native-entry-failure')
        with patch('builtins.open', mock_open(read_data=json.dumps(fixture()))), \
             patch.object(contact, 'run_beam_contact', side_effect=failure):
            with self.assertRaises(RuntimeError) as caught: subject.run_beam_weld_span_contact()
        self.assertIs(caught.exception, failure)

    def test_entry_refuses_broken_json_before_native(self):
        from unittest.mock import mock_open
        with patch('builtins.open', mock_open(read_data='{')), patch.object(contact, 'run_beam_contact') as native:
            with self.assertRaises(json.JSONDecodeError): subject.run_beam_weld_span_contact()
            native.assert_not_called()

if __name__ == '__main__':
    assert Path(contact.__file__).resolve() == Path(__file__).with_name('beamContact.py').resolve(), 'must inspect the candidate, not product solver'
    print(json.dumps({'pureNumPyVersion':np.__version__, 'nativeExecuted':False}), flush=True)
    unittest.main(verbosity=2)
