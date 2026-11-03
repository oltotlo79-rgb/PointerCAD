"""Finite-strain J2 equilibrium of a tetrahedral mesh (EX-09 W34 first slice; internal, not wired to any product route).

The packaged OOFEM 214b161 StaticStructural/NRSolver solves ltrspace elements with nlgeo 1 (total Lagrangian, F from
the current displacement) and the accepted W33 finite J2 law (solidFiniteMaterial.make_oofem_material, injected
through the Python material trampoline). This module only adds the general mesh and load history around it: explicit
nodes and connectivity, prescribed displacement and nodal force histories per DOF, one material parameter set, an
independent per-step equilibrium check and the attempt/commit ownership of the material history.

Units are those of the existing decks (solidPlasticAnalysis.py, W33 run_native_tet): coordinates and displacements mm,
forces N, moduli and stresses MPa = N/mm^2. Nodal forces are dead loads in the global axes (they do not follow the
deformation). Prescribed displacements and forces are given per step (time t = step number); time 0 is the undeformed,
unloaded state.

Acceptance of each step (a converged equilibrium, not merely the end of the native iteration):
  * the native external force at each loaded DOF is the deck component 1.0 times the native time function evaluated at
    the step (Load::computeComponentArrayAt, load.C:89; Function::evaluate VM_Total, function.C:59-60) and must equal
    the plan value; the native internal forces are the element InternalForcesVector of the solved trial state,
    assembled per node;
  * free-DOF residual |external - internal| over the actual force scale max(accepted free-load/constrained-action reference, all
    current internal forces, current free-DOF external forces) must be <= FREE_RESIDUAL_BOUND 1e-8 (method of
    solidPlasticAnalysis.check_free_force_balance, here with the native external force and the native internal force
    of the finite element); NRSolver keeps rtolf 1e-10 and maxiter 50. StaticStructural only warns when the iteration
    limit is reached (staticstructural.C:353-357), so this check is what refuses a non-converged step;
  * every native value is finite, prescribed displacements are reproduced, and det F > 0 for every element, with F
    formed here from the native displacements (the law only receives the Green-Lagrange strain, which is blind to a
    reflection such as F = diag(-1, 1, 1); it raises only when its own F = U is singular). The reader also refuses
    non-positive reference volumes.
Only then is the native status updated; native output reads and finite derived-value checks must succeed before
the Python trial history of every point is committed (all or nothing) through W33 commit_accepted. A read failure
after native update ends the run permanently: native buffers cannot be rolled back and must not be reused. A rejected step, or any exception from the solve, the native update or the commit, abandons the
still open attempt (the W33 adapter then refuses further attempts), keeps the committed history of the earlier steps
and re-raises the original exception object; cleanup failures are attached as notes.

Native lifetime: Domain.setMaterial stores the Python-owned trampoline in the native domain, so problem and material are
kept in solidFiniteMaterial._NATIVE_LIFETIME until the interpreter ends (W33, RUN 20261030-054958; that list is never
cleared here). The binding exposes no safe native destruction, so this entry enforces a finite execution lifetime: one
runtime hosts at most MAX_RETAINED_NATIVE_ANALYSES retained native analyses (W33 and this entry together) and refuses
more. A run object is single use. The production Worker must own the end of the runtime (terminate the Worker after
its analysis); long-lived reuse of one runtime is not claimed to be safe.
"""
import math

PLAN_SCHEMA = 'pointercad-finite-j2-equilibrium-plan/1'
RESULT_SCHEMA = 'pointercad-finite-j2-equilibrium/1'
METHOD = 'oofem-ltrspace-nlgeo1-staticstructural-nrsolver-pointercad-finite-j2/1'
FREE_RESIDUAL_BOUND = 1e-8
MAX_RETAINED_NATIVE_ANALYSES = 8
MAXIMUM_NODES, MAXIMUM_ELEMENTS, MAXIMUM_STEPS, MAXIMUM_RECORDED_STATES = 2000, 5000, 200, 20000
# A tetrahedron whose 6 |volume| is below this fraction of the cube of its longest edge is treated as collapsed.
MINIMUM_RELATIVE_VOLUME = 1e-12
DOFS = ('x', 'y', 'z')


def _fail(detail):
    raise ValueError(f'finite-equilibrium: {detail}')


def _record(value, required, optional, path):
    if not isinstance(value, dict):
        _fail(f'{path} must be an object')
    unknown = [name for name in value if name not in required and name not in optional]
    missing = [name for name in required if name not in value]
    if unknown or missing:
        _fail(f'{path} must have the fields {", ".join(required)} (optional: {", ".join(optional) or "none"})')
    return value


def _finite(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f'{path} must be a finite number')
    try:
        number = float(value)
    except OverflowError:
        _fail(f'{path} must be a finite number')
    if not math.isfinite(number):
        _fail(f'{path} must be a finite number')
    return 0.0 if number == 0 else number


def _integer(value, path, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        _fail(f'{path} must be an integer from {low} to {high}')
    return value


def _array(value, path, low, high):
    if not isinstance(value, list) or not low <= len(value) <= high:
        _fail(f'{path} must have {low} to {high} entries')
    return value


def signed_volume6(a, b, c, d):
    """6 x signed volume det(b - a, c - a, d - a); OOFEM ltrspace node order needs it positive (W33 tet: L^3 > 0)."""
    u = [b[i] - a[i] for i in range(3)]
    v = [c[i] - a[i] for i in range(3)]
    w = [d[i] - a[i] for i in range(3)]
    return (u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0])
            + u[2] * (v[0] * w[1] - v[1] * w[0]))


def read_plan(value):
    """Validated internal plan; refuses non-finite input, non-positive tetrahedra and inconsistent DOF histories."""
    row = _record(value, ('schema', 'units', 'nodes', 'elements', 'material', 'steps', 'prescribedMm', 'forcesN'),
                  ('referenceForceN',), 'plan')
    if row['schema'] != PLAN_SCHEMA:
        _fail('unsupported plan schema')
    if row['units'] != 'N-mm-MPa':
        _fail('units must be N-mm-MPa')
    nodes = []
    for index, point in enumerate(_array(row['nodes'], 'nodes', 4, MAXIMUM_NODES)):
        xyz = _array(point, f'nodes[{index}]', 3, 3)
        nodes.append([_finite(xyz[axis], f'nodes[{index}][{axis}]') for axis in range(3)])
    elements, used = [], set()
    for index, element in enumerate(_array(row['elements'], 'elements', 1, MAXIMUM_ELEMENTS)):
        ids = []
        for local, item in enumerate(_array(element, f'elements[{index}]', 4, 4)):
            ids.append(_integer(item, f'elements[{index}][{local}]', 0, len(nodes) - 1))
        if len(set(ids)) != 4:
            _fail(f'elements[{index}] must use four distinct nodes')
        a, b, c, d = (nodes[i] for i in ids)
        volume6 = signed_volume6(a, b, c, d)
        edge = max(math.dist(p, q) for p, q in ((a, b), (a, c), (a, d), (b, c), (b, d), (c, d)))
        if not math.isfinite(volume6) or not volume6 > MINIMUM_RELATIVE_VOLUME * edge ** 3:
            _fail(f'elements[{index}] has a non-positive or collapsed reference volume (6V = {volume6!r}); '
                  'order the nodes so that det(x1 - x0, x2 - x0, x3 - x0) > 0')
        elements.append(ids)
        used.update(ids)
    if len(used) != len(nodes):
        _fail('every node must belong to an element')
    from solidFiniteMaterial import read_parameters  # same validated parameter set as the W33 law
    try:
        material = read_parameters(row['material'])
    except ValueError as error:
        _fail(f'material: {error}')
    steps = _integer(row['steps'], 'steps', 1, MAXIMUM_STEPS)
    if steps * (len(nodes) + len(elements)) > MAXIMUM_RECORDED_STATES:
        _fail(f'at most {MAXIMUM_RECORDED_STATES} recorded node and element states are allowed')
    prescribed, loads = {}, {}
    for name, target, unit in (('prescribedMm', prescribed, 'valuesMm'), ('forcesN', loads, 'valuesN')):
        for index, item in enumerate(_array(row[name], name, 0, len(nodes) * 3)):
            entry = _record(item, ('node', 'dof', unit), (), f'{name}[{index}]')
            node = _integer(entry['node'], f'{name}[{index}].node', 0, len(nodes) - 1)
            if entry['dof'] not in DOFS:
                _fail(f'{name}[{index}].dof must be x, y or z')
            key = (node, DOFS.index(entry['dof']))
            if key in target:
                _fail(f'{name}[{index}] repeats node {node} direction {entry["dof"]} (a DOF appears at most once per list)')
            values = _array(entry[unit], f'{name}[{index}].{unit}', steps, steps)
            target[key] = [_finite(v, f'{name}[{index}].{unit}[{k}]') for k, v in enumerate(values)]
    if not prescribed:
        _fail('at least one displacement must be prescribed')
    if len(prescribed) >= len(nodes) * 3:
        _fail('at least one degree of freedom must stay free')
    largest_load = max((abs(v) for key, values in loads.items() if key not in prescribed for v in values), default=0.0)
    if 'referenceForceN' in row:
        reference = _finite(row['referenceForceN'], 'referenceForceN')
        if not reference > 0:
            _fail('referenceForceN must be positive')
    elif largest_load > 0:
        reference = largest_load
    else:
        _fail('a history without free-DOF nodal forces needs referenceForceN (native NRSolver force scale of the free DOFs)')
    return {'nodes': nodes, 'elements': elements, 'material': {k: row['material'][k] for k in
            ('youngMPa', 'poisson', 'yieldStressMPa', 'hardeningModulusMPa')}, 'parameters': material,
            'steps': steps, 'prescribed': prescribed, 'loads': loads, 'referenceForceN': reference}


def _number(value):
    return format(float(value), '.17g')


def plan_deck(plan, path):
    """OOFEM deck for a plan accepted by read_plan; returns (deck text, {(node, dof): function number of each load})."""
    n, nodes, elements = plan['steps'], plan['nodes'], plan['elements']
    scale = _number(plan['referenceForceN'])
    lines = [path + '.out', 'PointerCAD internal finite J2 tetrahedral equilibrium (EX-09 W34 candidate)',
             f'StaticStructural nsteps {n} rtolf 1e-10 maxiter 50 manrmsteps 1 nmodules 0 '
             f'forcescale 3 {scale} {scale} {scale} forcescaledofs 3 1 2 3', 'domain 3d', 'OutputManager']
    records, functions, load_functions = [], [], {}

    def history(values):
        number = len(functions) + 1
        functions.append(f'PiecewiseLinFunction {number} t {n + 1} ' + ' '.join(_number(t) for t in range(n + 1))
                         + f' f(t) {n + 1} ' + ' '.join(_number(v) for v in [0.0] + list(values)))
        return number
    for (node, dof) in sorted(plan['prescribed']):
        number = history(plan['prescribed'][(node, dof)])
        records.append(f'BoundaryCondition {len(records) + 1} loadTimeFunction {number} dofs 1 {dof + 1} '
                       f'values 1 1.0 set {node + 2}')
    for (node, dof) in sorted(plan['loads']):
        number = history(plan['loads'][(node, dof)])
        load_functions[(node, dof)] = number
        records.append(f'NodalLoad {len(records) + 1} loadTimeFunction {number} dofs 1 {dof + 1} '
                       f'Components 1 1.0 set {node + 2}')
    lines.append(f'ndofman {len(nodes)} nelem {len(elements)} ncrosssect 1 nmat 1 nbc {len(records)} '
                 f'nltf {len(functions)} nic 0 nset {len(nodes) + 1}')
    lines += [f'node {i + 1} coords 3 ' + ' '.join(_number(v) for v in point) for i, point in enumerate(nodes)]
    lines += [f'ltrspace {i + 1} nodes 4 ' + ' '.join(str(k + 1) for k in element) + ' nlgeo 1'
              for i, element in enumerate(elements)]
    # IsoLE is only the deck placeholder of material 1; the injected finite J2 law replaces it before consistency/init.
    m = plan['material']
    lines += ['SimpleCS 1 material 1 set 1', f'IsoLE 1 d 1.0 tAlpha 0.0 E {_number(m["youngMPa"])} n {_number(m["poisson"])}']
    lines += records + functions
    lines.append(f'Set 1 elementranges {{(1 {len(elements)})}}')
    lines += [f'Set {i + 2} nodes 1 {i + 1}' for i in range(len(nodes))]
    lines.append('')
    return '\n'.join(lines), load_functions


def shape_gradients(nodes, element):
    """Reference gradients of the four linear shape functions (rows of J^-1, J = [x1 - x0, x2 - x0, x3 - x0])."""
    a, b, c, d = (nodes[i] for i in element)
    j = [[b[i] - a[i], c[i] - a[i], d[i] - a[i]] for i in range(3)]
    det = (j[0][0] * (j[1][1] * j[2][2] - j[1][2] * j[2][1]) - j[0][1] * (j[1][0] * j[2][2] - j[1][2] * j[2][0])
           + j[0][2] * (j[1][0] * j[2][1] - j[1][1] * j[2][0]))
    inverse = [[(j[1][1] * j[2][2] - j[1][2] * j[2][1]) / det, (j[0][2] * j[2][1] - j[0][1] * j[2][2]) / det,
                (j[0][1] * j[1][2] - j[0][2] * j[1][1]) / det],
               [(j[1][2] * j[2][0] - j[1][0] * j[2][2]) / det, (j[0][0] * j[2][2] - j[0][2] * j[2][0]) / det,
                (j[0][2] * j[1][0] - j[0][0] * j[1][2]) / det],
               [(j[1][0] * j[2][1] - j[1][1] * j[2][0]) / det, (j[0][1] * j[2][0] - j[0][0] * j[2][1]) / det,
                (j[0][0] * j[1][1] - j[0][1] * j[1][0]) / det]]
    return [[-inverse[0][k] - inverse[1][k] - inverse[2][k] for k in range(3)]] + inverse


def deformation_gradients(nodes, elements, displacement):
    """Row-major F = I + sum_a u_a (x) grad N_a of every linear tetrahedron and its det F (exact for tet4).

    Needed because the law only sees the Green-Lagrange strain E = (F^T F - I) / 2, which is blind to reflections:
    F = diag(-1, 1, 1) gives E = 0 and no stress (RUN 20261030-074238), so an inverted element is detected here.
    """
    out = []
    for element in elements:
        grads = shape_gradients(nodes, element)
        f = [1.0 if i == j else 0.0 for i in range(3) for j in range(3)]
        for local, node in enumerate(element):
            for i in range(3):
                for j in range(3):
                    f[3 * i + j] += displacement[node][i] * grads[local][j]
        det = (f[0] * (f[4] * f[8] - f[5] * f[7]) - f[1] * (f[3] * f[8] - f[5] * f[6])
               + f[2] * (f[3] * f[7] - f[4] * f[6]))
        out.append((f, det))
    return out


def reserve_native_analysis(retained):
    """Finite execution lifetime: refuse a new native analysis once the runtime retains the maximum number."""
    if len(retained) >= MAX_RETAINED_NATIVE_ANALYSES:
        _fail(f'this runtime already retains {len(retained)} native analyses (limit {MAX_RETAINED_NATIVE_ANALYSES}); '
              'the Worker must dispose the runtime and start a new one (no native destruction is exposed)')


def _require_finite(values, what):
    for value in values:
        if not math.isfinite(value):
            _fail(f'non-finite {what}')


def free_force_balance(internal, external, prescribed, accepted_reference, where):
    """Free-DOF |external - internal| over the structural force scale; returns (residual, reference, scale).

    internal and external are per-node 3-vectors (N). The scale is max(accepted reference, every current internal force
    including constrained internal actions, every free-DOF external force); the new reference (only after acceptance) is
    max(accepted reference, every free-DOF external force, every constrained internal action).
    Fixed external loads change reactions (internal - external), not the free equations or their scale.
    """
    if len(internal) != len(external) or any(len(row) != 3 for row in internal + external):
        _fail('force arrays must contain matching three-vectors')
    _require_finite((v for row in internal for v in row), f'native internal force at {where}')
    _require_finite((v for row in external for v in row), f'native external force at {where}')
    _require_finite([accepted_reference], 'accepted force reference')
    if accepted_reference < 0:
        _fail('accepted force reference must not be negative')
    scale = max([1e-300, accepted_reference] + [abs(v) for row in internal for v in row]
                + [abs(v) for n, row in enumerate(external) for a, v in enumerate(row) if (n, a) not in prescribed])
    ratios = [abs(external[n][a] - internal[n][a]) / scale for n in range(len(internal)) for a in range(3)
              if (n, a) not in prescribed]
    _require_finite([scale] + ratios, f'free-DOF residual at {where}')
    residual = max(ratios, default=0.0)
    reference = max([accepted_reference] + [abs(v) for n, row in enumerate(external) for a, v in enumerate(row) if (n, a) not in prescribed]
                    + [abs(internal[n][a]) for n in range(len(internal)) for a in range(3) if (n, a) in prescribed])
    return residual, reference, scale


class FiniteEquilibriumRun:
    """One native analysis of a read plan, advanced one load step at a time (single use, see module docstring)."""

    def __init__(self, fem, plan, path='/pcad_fem/finite-equilibrium'):
        import solidFiniteMaterial as law
        from importlib.metadata import version
        if version('oofem') != '3.1.dev5+g214b161ed':
            _fail('unexpected fixed OOFEM distribution')
        self.fem, self.plan, self.law = fem, plan, law
        reserve_native_analysis(law._NATIVE_LIFETIME)
        deck, self.load_functions = plan_deck(plan, path)
        with open(path + '.in', 'w', encoding='utf-8') as stream:
            stream.write(deck)
        self.records, self.accepted_reference, self.finished, self.problem = [], 0.0, False, None
        problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader(path + '.in'), fem.problemMode.processor, 0, None, False)
        if problem is None:
            _fail('OOFEM rejected the generated deck')
        self.problem = problem
        try:
            self.domain = problem.giveDomain(1)
            self.material = law.make_oofem_material(fem, 1, self.domain, plan['material'])
            self.domain.setMaterial(1, self.material)
            law._NATIVE_LIFETIME.append((problem, self.material))
            self.retained = len(law._NATIVE_LIFETIME)
            if self.domain.giveMaterial(1) is not self.material or problem.checkProblemConsistency() != 1:
                _fail('the injected material was not accepted by the native domain')
            problem.init()
            problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
            meta = problem.giveMetaStep(1)
            if meta is None or meta.giveNumberOfSteps() != plan['steps']:
                _fail('the default metastep does not carry the plan step count')
            problem.initMetaStepAttributes(meta)
        except Exception as error:
            self.finished = True
            try:
                problem.terminateAnalysis()
            except Exception as cleanup_error:
                error.add_note(f'Additional terminateAnalysis error: {cleanup_error!r}')
            raise

    def _forces(self, step, where):
        fem, plan, domain = self.fem, self.plan, self.domain
        count = len(plan['nodes'])
        internal = [[0.0, 0.0, 0.0] for _ in range(count)]
        for e, ids in enumerate(plan['elements']):
            forces = fem.FloatArray()
            domain.giveElement(e + 1).giveCharacteristicVector(forces, fem.CharType.InternalForcesVector,
                                                               fem.ValueModeType.VM_Total, step)
            forces = [float(v) for v in forces]
            if len(forces) != 12:
                _fail(f'element {e + 1} native internal force is not a 12-vector at {where}')
            _require_finite(forces, f'element {e + 1} native internal force at {where}')
            for local, node in enumerate(ids):
                for axis in range(3):
                    internal[node][axis] += forces[3 * local + axis]
        external = [[0.0, 0.0, 0.0] for _ in range(count)]
        index = len(self.records)
        for (node, dof), number in self.load_functions.items():
            value = float(domain.giveFunction(number).evaluate(step, fem.ValueModeType.VM_Total))
            planned = plan['loads'][(node, dof)][index]
            if not math.isfinite(value) or abs(value - planned) > 1e-12 * max(1.0, abs(planned)):
                _fail(f'native load of node {node} direction {DOFS[dof]} is {value!r}, plan {planned!r} at {where}')
            external[node][dof] = value
        return internal, external

    def advance(self):
        """Solve, check and commit the next step; returns its record. Any failure ends the run (no reuse)."""
        if self.finished:
            _fail('this analysis has ended (failed, finished or closed); a run object is single use')
        fem, plan, domain, material = self.fem, self.plan, self.domain, self.material
        index = len(self.records)
        if index >= plan['steps']:
            _fail('all steps of the plan are already solved')
        where, token, committed = f'step {index + 1}', None, False
        try:
            self.problem.preInitializeNextStep()
            step = self.problem.giveNextStep()
            self.problem.initializeYourself(step)
            token = material.begin_step(step.giveNumber())
            self.problem.solveYourselfAt(step)
            ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
            displacement = [[float(domain.giveDofManager(n + 1).giveDofWithID(d).giveUnknown(fem.ValueModeType.VM_Total, step))
                             for d in ids] for n in range(len(plan['nodes']))]
            _require_finite((v for row in displacement for v in row), f'native displacement at {where}')
            for (node, dof), values in plan['prescribed'].items():
                if abs(displacement[node][dof] - values[index]) > 1e-12 * max(1.0, abs(values[index])):
                    _fail(f'prescribed displacement of node {node} direction {DOFS[dof]} not reproduced at {where}')
            for e, (_, det) in enumerate(deformation_gradients(plan['nodes'], plan['elements'], displacement)):
                if not (math.isfinite(det) and det > 0):
                    _fail(f'element {e + 1} has det F = {det!r} at {where} (inverted or collapsed element; nothing committed)')
            internal, external = self._forces(step, where)
            residual, reference, scale = free_force_balance(internal, external, plan['prescribed'],
                                                            self.accepted_reference, where)
            if not residual <= FREE_RESIDUAL_BOUND:
                _fail(f'free-DOF force residual {residual!r} exceeds {FREE_RESIDUAL_BOUND} at {where} '
                      '(no converged equilibrium; nothing committed)')
            self.problem.updateYourself(step)
            elements = []
            for e in range(len(plan['elements'])):
                element = domain.giveElement(e + 1)
                gp = element.giveDefaultIntegrationRulePtr().getIntegrationPoint(0)
                status = gp.giveMaterialStatus()
                if not any(status is known for known in material.statuses):
                    _fail(f'element {e + 1} status is not a status of the injected material at {where}')
                native = {}
                for key, kind, size in (('F9', fem.InternalStateType.IST_DeformationGradientTensor, 9),
                                        ('S6', fem.InternalStateType.IST_StressTensor, 6)):
                    answer = fem.FloatArray()
                    element.giveIPValue(answer, gp, kind, step)
                    native[key] = [float(v) for v in answer]
                    if len(native[key]) != size:
                        _fail(f'element {e + 1} native {key} has {len(native[key])} components at {where}')
                    _require_finite(native[key], f'element {e + 1} native {key} at {where}')
                # Spatial measures from the native F and S: the law evaluates S at the right stretch U = (F^T F)^1/2
                # (frame-free), so its own tau/P/sigma are those of U, not of F = R U.
                law = self.law
                f = law.from_oofem9(native['F9'])
                s = [0.0] * 9
                for k, (i, j) in enumerate(law.VOIGT6):
                    s[3 * i + j] = s[3 * j + i] = native['S6'][k]
                jacobian = law.det(f)
                if not (math.isfinite(jacobian) and jacobian > 0):
                    _fail(f'element {e + 1} native det F {jacobian!r} is not positive at {where}')
                p = law.mm(f, s)
                tau = law.mm(p, law.mt(f))
                if status.trialToken != token or status.trial is None or status.last is None:
                    _fail(f'element {e + 1} has no owned trial record at {where}')
                c = status.last
                elements.append({'J': jacobian, 'tau': tau, 'P': p, 'sigma': [v / jacobian for v in tau],
                                 'alpha': status.trial['alpha'], 'plastic': c['plastic'], 'dissipation': c['dissipation'],
                                 'q': c['q'], 'native': native})
            record = {'step': index + 1, 'time': float(step.giveTargetTime()), 'freeResidualRatio': residual,
                      'forceScaleN': scale, 'displacementMm': displacement, 'internalN': internal, 'externalN': external,
                      'elements': elements}
            # Native IP reads require updateYourself, but Python history must remain uncommitted until all
            # fallible output reads and derived-value validation have succeeded. Native rollback is unavailable;
            # on failure abandon the Python attempt and end the run permanently.
            import json
            json.dumps(record, allow_nan=False)
            next_records = self.records + [record]
            material.commit_accepted(step.giveNumber(), token, float(residual))
            committed = True
            self.accepted_reference = reference
            self.records = next_records
            if len(self.records) == plan['steps']:
                self.finished = True
            return record
        except Exception as error:
            self.finished = True
            error.add_note(f'finite-equilibrium: raised at step {index + 1} of {plan["steps"]} '
                           + ('after its commit' if committed else '(nothing of this step committed)'))
            if token is not None:
                try:
                    if material._token() == token:
                        material.abandon_step(token)
                except Exception as cleanup_error:
                    error.add_note(f'Additional abandon_step error: {cleanup_error!r}')
            raise

    def close(self, primary=None):
        """Terminate the native analysis once; the problem and material stay retained (see module docstring)."""
        self.finished = True
        problem, self.problem = self.problem, None
        if problem is None:
            return
        try:
            problem.terminateAnalysis()
        except Exception as cleanup_error:
            if primary is None:
                raise
            primary.add_note(f'Additional terminateAnalysis error: {cleanup_error!r}')

    def result(self):
        return {'schema': RESULT_SCHEMA, 'method': METHOD, 'units': 'N-mm-MPa',
                'scope': 'finite-strain-j2-linear-isotropic-hardening-tet4-internal', 'structuralCertification': False,
                'freeResidualBound': FREE_RESIDUAL_BOUND, 'records': self.records,
                'refusedCommits': self.material.refusedCommits, 'retainedNativeAnalyses': self.retained,
                'runtimeAnalysisLimit': MAX_RETAINED_NATIVE_ANALYSES}


def run_finite_equilibrium(fem, plan_value, path='/pcad_fem/finite-equilibrium'):
    """Solve every step of a plan; returns the JSON result text or re-raises the original exception of the first failure."""
    import json
    plan = read_plan(plan_value)
    run = FiniteEquilibriumRun(fem, plan, path)
    primary = None
    try:
        for _ in range(plan['steps']):
            run.advance()
        return json.dumps(run.result(), allow_nan=False)
    except Exception as error:
        primary = error
        raise
    finally:
        run.close(primary)
