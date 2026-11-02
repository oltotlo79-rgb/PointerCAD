"""Host checks of solidFiniteEquilibrium.py (EX-09 W34 first slice): plan reader, deck, force balance, lifetime bound.

Run: python -B -X utf8 solidFiniteEquilibrium.test.py -v   (host Python; solidFiniteMaterial.py must be importable,
the native test passes its folder in PYTHONPATH). No NumPy and no native OOFEM: the native element/solver checks are
in solidFiniteEquilibriumNative.test.ts. Expected numbers below are written out by hand, not taken from the module.
"""
import copy
import importlib.util
import math
import pathlib
import sys
import unittest

spec = importlib.util.spec_from_file_location('solid_finite_equilibrium',
                                              pathlib.Path(__file__).with_name('solidFiniteEquilibrium.py'))
fe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fe)

L = 10.0
MATERIAL = {'youngMPa': 200000.0, 'poisson': 0.3, 'yieldStressMPa': 250.0, 'hardeningModulusMPa': 20000.0}
# Two tetrahedra of positive volume: A = (0, 1, 2, 3) with 6V = L^3, B = (1, 2, 3, 4) with 6V = 2 L^3.
NODES = [[0.0, 0.0, 0.0], [L, 0.0, 0.0], [0.0, L, 0.0], [0.0, 0.0, L], [L, L, L]]
ELEMENTS = [[0, 1, 2, 3], [1, 2, 3, 4]]
FIXED = [(0, 'x'), (0, 'y'), (0, 'z'), (2, 'x'), (2, 'z'), (3, 'x'), (3, 'y')]


def plan(**changes):
    value = {'schema': fe.PLAN_SCHEMA, 'units': 'N-mm-MPa', 'nodes': copy.deepcopy(NODES),
             'elements': copy.deepcopy(ELEMENTS), 'material': dict(MATERIAL), 'steps': 3,
             'prescribedMm': [{'node': n, 'dof': d, 'valuesMm': [0.0, 0.0, 0.0]} for n, d in FIXED],
             'forcesN': [{'node': 1, 'dof': 'x', 'valuesN': [1000.0, 2000.0, 0.0]},
                         {'node': 4, 'dof': 'x', 'valuesN': [500.0, -2500.0, 0.0]}]}
    value.update(changes)
    return value


class Reader(unittest.TestCase):
    def test_valid_plan_and_deck(self):
        p = fe.read_plan(plan())
        self.assertEqual(p['steps'], 3)
        self.assertEqual(p['referenceForceN'], 2500.0)        # largest |nodal force| of the history
        self.assertEqual(len(p['prescribed']), 7)
        self.assertEqual(p['loads'][(4, 0)], [500.0, -2500.0, 0.0])
        self.assertEqual(fe.signed_volume6(*[NODES[i] for i in ELEMENTS[1]]), 2 * L ** 3)
        deck, functions = fe.plan_deck(p, '/pcad_fem/x')
        lines = deck.split('\n')
        self.assertIn('StaticStructural nsteps 3 rtolf 1e-10 maxiter 50 manrmsteps 1 nmodules 0 forcescale 3 2500 2500 2500 '
                      'forcescaledofs 3 1 2 3', lines)
        self.assertIn('ndofman 5 nelem 2 ncrosssect 1 nmat 1 nbc 9 nltf 9 nic 0 nset 6', lines)
        self.assertIn('ltrspace 1 nodes 4 1 2 3 4 nlgeo 1', lines)
        self.assertIn('ltrspace 2 nodes 4 2 3 4 5 nlgeo 1', lines)
        self.assertIn('BoundaryCondition 1 loadTimeFunction 1 dofs 1 1 values 1 1.0 set 2', lines)   # node 0 x
        self.assertIn('BoundaryCondition 7 loadTimeFunction 7 dofs 1 2 values 1 1.0 set 5', lines)   # node 3 y
        self.assertIn('NodalLoad 8 loadTimeFunction 8 dofs 1 1 Components 1 1.0 set 3', lines)        # node 1 x
        self.assertIn('NodalLoad 9 loadTimeFunction 9 dofs 1 1 Components 1 1.0 set 6', lines)        # node 4 x
        self.assertIn('PiecewiseLinFunction 9 t 4 0 1 2 3 f(t) 4 0 500 -2500 0', lines)
        self.assertIn('Set 1 elementranges {(1 2)}', lines)
        self.assertEqual(functions, {(1, 0): 8, (4, 0): 9})
        self.assertEqual(sum(line.startswith('Set ') for line in lines), 6)

    def test_non_finite_input_is_refused(self):
        bad = [plan(nodes=[[math.nan, 0, 0]] + NODES[1:]), plan(nodes=[[0, math.inf, 0]] + NODES[1:]),
               plan(nodes=[[0, 0, 10 ** 400]] + NODES[1:]), plan(nodes=[[True, 0, 0]] + NODES[1:]),
               plan(forcesN=[{'node': 1, 'dof': 'x', 'valuesN': [1.0, math.nan, 0.0]}]),
               plan(forcesN=[{'node': 1, 'dof': 'x', 'valuesN': [1.0, -math.inf, 0.0]}]),
               plan(prescribedMm=[{'node': 0, 'dof': 'x', 'valuesMm': [0.0, math.nan, 0.0]}]),
               plan(referenceForceN=math.inf), plan(referenceForceN=0.0),
               plan(material={**MATERIAL, 'youngMPa': math.nan}), plan(material={**MATERIAL, 'poisson': 0.5})]
        for value in bad:
            with self.assertRaises(ValueError):
                fe.read_plan(value)

    def test_inverted_and_collapsed_tetrahedra_are_refused(self):
        for elements in ([[0, 2, 1, 3], [1, 2, 3, 4]],            # swapped: 6V = -L^3
                         [[0, 1, 2, 3], [1, 3, 2, 4]],            # swapped second: 6V = -2 L^3
                         [[0, 1, 2, 2], [1, 2, 3, 4]]):           # repeated node
            with self.assertRaises(ValueError):
                fe.read_plan(plan(elements=elements))
        flat = copy.deepcopy(NODES)
        flat[4] = [L / 3, L / 3, L / 3]                           # on the face (1, 2, 3): 6V = 0
        with self.assertRaisesRegex(ValueError, 'non-positive or collapsed'):
            fe.read_plan(plan(nodes=flat))
        nearly = copy.deepcopy(NODES)
        nearly[4] = [L / 3 + 1e-14, L / 3, L / 3]                 # 6V ~ 1e-12 L^3 << 1e-12 * edge^3 bound
        with self.assertRaisesRegex(ValueError, 'non-positive or collapsed'):
            fe.read_plan(plan(nodes=nearly))

    def test_inconsistent_degrees_of_freedom_are_refused(self):
        fixed = [{'node': n, 'dof': d, 'valuesMm': [0.0, 0.0, 0.0]} for n, d in FIXED]
        cases = [plan(prescribedMm=fixed + [fixed[0]]),                                        # repeated
                 plan(forcesN=[{'node': 0, 'dof': 'x', 'valuesN': [1.0, 1.0, 1.0]}]),          # load on prescribed
                 plan(forcesN=[{'node': 1, 'dof': 'x', 'valuesN': [1.0, 1.0]}]),               # history length
                 plan(prescribedMm=[{'node': n, 'dof': d, 'valuesMm': [0.0] * 3} for n in range(5) for d in 'xyz'],
                      forcesN=[], referenceForceN=1.0),                                         # no free DOF
                 plan(prescribedMm=[]),                                                         # nothing prescribed
                 plan(prescribedMm=[{'node': 5, 'dof': 'x', 'valuesMm': [0.0] * 3}]),           # unknown node
                 plan(forcesN=[{'node': 1, 'dof': 'w', 'valuesN': [1.0] * 3}]),                # unknown direction
                 plan(nodes=NODES + [[2 * L, 0.0, 0.0]]),                                       # unused node
                 plan(forcesN=[]),                                                              # no load, no reference
                 plan(steps=0), plan(steps=201), plan(steps=2.0), plan(schema='x'), plan(units='N-m-Pa'),
                 {**plan(), 'extra': 1}]
        for value in cases:
            with self.assertRaises(ValueError):
                fe.read_plan(value)
        accepted = fe.read_plan(plan(forcesN=[], referenceForceN=25000.0))
        self.assertEqual((accepted['referenceForceN'], accepted['loads']), (25000.0, {}))


class ForceBalance(unittest.TestCase):
    def test_free_residual_against_actual_load_and_reaction_scale(self):
        prescribed = {(0, 0): [0.0], (0, 1): [0.0], (0, 2): [0.0]}
        internal = [[1.0, 0.0, 0.0], [-3.0, 2e-9, 0.0]]
        external = [[0.0, 0.0, 0.0], [-3.0, 0.0, 0.0]]
        residual, reference, scale = fe.free_force_balance(internal, external, prescribed, 0.0, 'step 1')
        self.assertEqual(scale, 3.0)
        self.assertAlmostEqual(residual, 2e-9 / 3.0, delta=1e-24)
        self.assertEqual(reference, 3.0)
        # Unloaded later step: the accepted reference keeps the scale (a free imbalance of 1e-9 N is 1e-9 / 3).
        residual, reference, scale = fe.free_force_balance([[0.0] * 3, [1e-9, 0.0, 0.0]], [[0.0] * 3, [0.0] * 3],
                                                           prescribed, 3.0, 'step 2')
        self.assertEqual((scale, reference), (3.0, 3.0))
        self.assertAlmostEqual(residual, 1e-9 / 3.0, delta=1e-24)
        # A reaction larger than the loads sets the reference; a free imbalance does not.
        _, reference, _ = fe.free_force_balance([[-7.0, 0.0, 0.0], [5.0, 0.5, 0.0]], [[0.0] * 3, [5.0, 0.0, 0.0]],
                                                prescribed, 0.0, 'step 1')
        self.assertEqual(reference, 7.0)
        for internal, external in (([[math.nan, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 0]]),
                                   ([[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [math.inf, 0, 0]]),
                                   ([[0, 0, 0]], [[0, 0, 0], [0, 0, 0]])):
            with self.assertRaises(ValueError):
                fe.free_force_balance(internal, external, prescribed, 0.0, 'step 1')
        with self.assertRaises(ValueError):
            fe.free_force_balance([[0.0] * 3], [[0.0] * 3], prescribed, -1.0, 'step 1')


class Kinematics(unittest.TestCase):
    def test_element_deformation_gradient_detects_reflections(self):
        f = [[1.1, 0.2, 0.0], [0.0, 0.9, 0.0], [0.1, 0.0, 1.05]]       # det = 1.1 * 0.9 * 1.05 = 1.0395
        affine = [[sum((f[i][k] - (1.0 if i == k else 0.0)) * x[k] for k in range(3)) for i in range(3)] for x in NODES]
        for got, det in fe.deformation_gradients(NODES, ELEMENTS, affine):
            self.assertLessEqual(max(abs(got[3 * i + j] - f[i][j]) for i in range(3) for j in range(3)), 1e-14)
            self.assertAlmostEqual(det, 1.0395, delta=1e-14)
        for got, det in fe.deformation_gradients(NODES, ELEMENTS, [[0.0] * 3 for _ in NODES]):
            self.assertEqual((got, det), ([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], 1.0))
        # x -> -x is a reflection: E = (F^T F - I) / 2 = 0, but det F = -1 must be visible.
        mirrored = [[-2.0 * x[0], 0.0, 0.0] for x in NODES]
        for got, det in fe.deformation_gradients(NODES, ELEMENTS, mirrored):
            self.assertEqual(det, -1.0)
            self.assertEqual(got, [-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])


class Lifetime(unittest.TestCase):
    def test_runtime_retains_a_bounded_number_of_native_analyses(self):
        self.assertEqual(fe.MAX_RETAINED_NATIVE_ANALYSES, 8)
        for count in range(8):
            fe.reserve_native_analysis([object()] * count)
        for count in (8, 9):
            with self.assertRaisesRegex(ValueError, 'must dispose the runtime'):
                fe.reserve_native_analysis([object()] * count)



class Transaction(unittest.TestCase):
    """Host doubles only for native calls; real W33 attempt/commit state and real W34 advance.

    This proves exception ownership/order, not finite-element accuracy (the native cases cover that separately).
    """
    def make_run(self, fault=None, cleanup_error=None):
        from types import SimpleNamespace as NS
        import solidFiniteMaterial as law
        events = []
        primary = RuntimeError('native boundary ' + str(fault))
        class NativeStatus:
            def __init__(self, gp):
                self.strain = [0.0] * 6
            def letTempStrainVectorBe(self, value): self.temp_strain = list(value)
            def letTempStressVectorBe(self, value): self.temp_stress = list(value)
            def giveStrainVector(self): return self.strain
        class NativeMaterial:
            def __init__(self, *args): pass
        class Point:
            status = None
            def hasMaterialStatus(self): return self.status is not None
            def giveMaterialStatus(self):
                if fault == 'status' and 'update' in events: return object()
                return self.status
            def setMaterialStatus(self, status, kind): self.status = status
        gp = Point()
        fem = NS(StructuralMaterialStatus=NativeStatus, StructuralMaterial=NativeMaterial,
                 FloatArray=lambda n=0: [0.0] * n,
                 IntegrationPointStatusIDType=NS(IPSID_Default=0),
                 DofIDItem=NS(D_u=0, D_v=1, D_w=2), ValueModeType=NS(VM_Total=0),
                 InternalStateType=NS(IST_DeformationGradientTensor='F', IST_StressTensor='S'))
        material = law.make_oofem_material(fem, 1, None, MATERIAL)
        status = material.giveStatus(gp)
        status.committed['alpha'] = 0.125   # a prior accepted history, never overwritten on failure
        before = copy.deepcopy(status.committed)
        material.acceptedSteps = [1]
        actual_commit = material.commit_accepted
        def commit(*args):
            events.append('commit')
            if fault == 'commit': raise primary
            actual_commit(*args)
        material.commit_accepted = commit
        actual_abandon = material.abandon_step
        def abandon(token):
            events.append('abandon')
            if cleanup_error is not None: raise cleanup_error
            actual_abandon(token)
        material.abandon_step = abandon
        class Step:
            def giveNumber(self): return 2
            def giveTargetTime(self):
                events.append('time')
                if fault == 'time': raise primary
                return 2.0
        step = Step()
        class Problem:
            def preInitializeNextStep(self): pass
            def giveNextStep(self): return step
            def initializeYourself(self, step): pass
            def solveYourselfAt(self, step):
                events.append('solve')
                material.giveRealStressVector_3d([0.0] * 6, gp, step)
            def updateYourself(self, step):
                events.append('update')
                if fault == 'update': raise primary
                status.strain = list(status.trialE)
        class Element:
            def giveDefaultIntegrationRulePtr(self): return NS(getIntegrationPoint=lambda n: gp)
            def giveIPValue(self, answer, gp, kind, step):
                events.append(kind)
                if fault == kind: raise primary
                self.assert_updated()
                values = law.to_oofem9([1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0]) if kind == 'F' else status.temp_stress
                if kind == 'F' and fault == 'overflow': values = [1e200 if v else 0.0 for v in values]
                answer.extend(values)
            def assert_updated(self):
                if 'update' not in events: raise AssertionError('native IP read requires native update')
        element = Element()
        domain = NS(giveElement=lambda n: element,
                    giveDofManager=lambda n: NS(giveDofWithID=lambda axis: NS(giveUnknown=lambda mode, step: 0.0)))
        run = fe.FiniteEquilibriumRun.__new__(fe.FiniteEquilibriumRun)
        run.fem, run.domain, run.material, run.law, run.problem = fem, domain, material, law, Problem()
        run.plan = {'nodes': [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                    'elements': [[0, 1, 2, 3]], 'prescribed': {}, 'steps': 2}
        run.records, run.accepted_reference, run.finished = [{'step': 1}], 7.0, False
        run._forces = lambda step, where: ([[0.0] * 3 for _ in range(4)], [[0.0] * 3 for _ in range(4)])
        return run, status, before, events, primary

    def test_native_result_read_failure_does_not_commit_or_lose_previous_record(self):
        for fault in ('F', 'S', 'time', 'status'):
            with self.subTest(fault=fault):
                run, status, before, events, primary = self.make_run(fault)
                with self.assertRaises(Exception) as caught: run.advance()
                if fault != 'status': self.assertIs(caught.exception, primary)
                self.assertEqual(status.committed, before)
                self.assertEqual(run.records, [{'step': 1}])
                self.assertEqual(run.accepted_reference, 7.0)
                self.assertEqual(run.material.acceptedSteps, [1])
                self.assertEqual(run.material.abandonedSteps, [2])
                self.assertIsNone(run.material.attempt)
                self.assertNotIn('commit', events)
                with self.assertRaisesRegex(ValueError, 'single use'): run.advance()

    def test_nonfinite_derived_record_cannot_commit(self):
        run, status, before, events, _ = self.make_run('overflow')
        with self.assertRaises(ValueError): run.advance()
        self.assertEqual(status.committed, before)
        self.assertNotIn('commit', events)
        self.assertEqual(run.material.abandonedSteps, [2])

    def test_refusal_cleanup_cannot_replace_primary_error(self):
        from unittest.mock import patch
        for refusal in ('inversion', 'residual'):
            with self.subTest(refusal=refusal):
                cleanup = RuntimeError('cleanup failed')
                run, status, before, events, _ = self.make_run(cleanup_error=cleanup)
                if refusal == 'residual': run._forces = lambda *args: ([[1.0, 0, 0]] * 4, [[0.0] * 3] * 4)
                gradients = [([1.0] * 9, -1.0 if refusal == 'inversion' else 1.0)]
                with patch.object(fe, 'deformation_gradients', return_value=gradients):
                    with self.assertRaisesRegex(ValueError, 'det F|force residual') as caught: run.advance()
                self.assertTrue(any('cleanup failed' in note for note in caught.exception.__notes__))
                self.assertEqual(status.committed, before)
                self.assertTrue(run.finished)
                self.assertNotIn('commit', events)

    def test_native_update_and_commit_rejection_preserve_prior_history(self):
        for fault in ('update', 'commit'):
            with self.subTest(fault=fault):
                run, status, before, events, primary = self.make_run(fault)
                with self.assertRaises(RuntimeError) as caught: run.advance()
                self.assertIs(caught.exception, primary)
                self.assertEqual(status.committed, before)
                self.assertEqual(run.records, [{'step': 1}])
                self.assertEqual(run.material.acceptedSteps, [1])
                self.assertEqual(run.material.abandonedSteps, [2])

    def test_all_native_reads_finish_before_single_python_commit(self):
        run, status, _, events, _ = self.make_run()
        record = run.advance()
        self.assertEqual(events, ['solve', 'update', 'F', 'S', 'time', 'commit'])
        self.assertEqual(run.material.acceptedSteps, [1, 2])
        self.assertEqual(status.commits, 1)
        self.assertEqual(record['step'], 2)
        self.assertEqual(record['elements'][0]['J'], 1.0)
        self.assertEqual(record['elements'][0]['alpha'], 0.125)
        self.assertEqual(record['elements'][0]['tau'], [0.0] * 9)
        self.assertIsNone(run.material.attempt)
        self.assertEqual(len(run.records), 2)


CASES = 12
suite = unittest.TestSuite()
for case in (Reader, ForceBalance, Kinematics, Lifetime, Transaction):
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(case))
assert suite.countTestCases() == CASES, suite.countTestCases()
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
if not result.wasSuccessful():
    raise SystemExit(1)
print(f'solid-finite-equilibrium: {CASES} host cases passed')
