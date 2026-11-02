"""W20-A fixed full-open/full-closed P1 contact in native OOFEM Newton.

W18 normal and W19 Coulomb laws are callbacks of real native elements, not an
outer substitute Newton. Accepted histories are committed only after a complete
native increment and independent checks succeed. Partial contact, moving point
sets, condition changes, finite sliding, automatic step cuts and reconstruction
after a failed native trial remain unsupported. Penalty diagnostics do not certify
the still-unspecified strict complementarity criterion of the overall W20 plan.
"""

from copy import deepcopy
import hashlib
import json
import math

from solidContact import (_barycentric, _dot, _finite, _positive_product, _subtract,
                          _triangle, _vector, contactEquationMap, contactResidualAndTangent)
from solidContactFriction import updateCoulombState


_NATIVE_LIFETIME = []
MAX_RETAINED_NATIVE_ANALYSES = 8  # Same bounded lifetime as solidFiniteEquilibrium.
FREE_RESIDUAL_BOUND = 1e-8
QUADRATURE_KEYS = ((4, 1, 1), (1, 4, 1), (1, 1, 4))


class ContactIncrementError(ValueError):
    def __init__(self, reason, step, callbacks, accepted, iteration_limit):
        super().__init__(f'solid-contact-increment: step {step}: {reason}')
        self.failure = {'success': False, 'step': step, 'reason': str(reason),
                        'nativeCallbacks': deepcopy(callbacks), 'accepted': deepcopy(accepted),
                        'iterationLimit': iteration_limit, 'nativeIterationCount': None,
                        'nativeIterationCountAvailability': 'Not exposed by the pinned binding; callback counts are separate.'}


def _identity(value, name):
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError(f'solid-contact-solver: explicit {name} required')
    return value


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


class FixedContactPatch:
    """Own one immutable reference patch and its three semantic material points."""
    def __init__(self, definition, nodes, bodies):
        self.definition = deepcopy(definition)
        row = self.definition
        self.identifier = _identity(row['id'], 'contact id')
        master_body = _identity(row['masterBody'], 'master body')
        slave_body = _identity(row['slaveBody'], 'slave body')
        master_face = _identity(row['masterFace'], 'master face')
        slave_face = _identity(row['slaveFace'], 'slave face')
        if master_body == slave_body and master_face == slave_face:
            raise ValueError('solid-contact-solver: identical contact faces')
        references = []
        for body, local_nodes in ((master_body, row['masterNodes']), (slave_body, row['slaveNodes'])):
            if body not in bodies or not isinstance(local_nodes, (list, tuple)) or len(local_nodes) != 3 or len(set(local_nodes)) != 3:
                raise ValueError('solid-contact-solver: three distinct body-local nodes required')
            if any(type(node) is not int or node < 0 or node >= len(bodies[body]) for node in local_nodes):
                raise ValueError('solid-contact-solver: body-local node out of range')
            references.extend((body, node) for node in local_nodes)
        self.references = tuple(references)
        self.original_nodes = tuple(bodies[body][local] for body, local in references)
        self.master = tuple(_vector(nodes[node], 'master coordinate') for node in self.original_nodes[:3])
        self.slave = tuple(_vector(nodes[node], 'slave coordinate') for node in self.original_nodes[3:])
        self.normal = _vector(row['normal'], 'contact normal')
        self.gap = _finite(row['initialGapMm'], 'initial gap')
        self.kn = _finite(row['knNPerMm3'], 'normal penalty')
        self.kt = _finite(row['ktNPerMm3'], 'tangent penalty')
        self.mu, self.source = row['mu'], row['sourceId']
        self.reference_length = _finite(row['referenceLengthMm'], 'reference length')
        self.reference_force = _finite(row['referenceForceN'], 'reference force')
        if self.reference_length <= 0 or self.reference_force <= 0:
            raise ValueError('solid-contact-solver: positive declared reference scales required')
        master_triangle, slave_triangle = _triangle(self.master, 'master'), _triangle(self.slave, 'slave')
        self.area = slave_triangle[7]
        # Validate the unchanged W18/W19 geometric and coefficient contracts.
        contactResidualAndTangent(self.master, self.slave, self.normal, self.gap, self.kn)
        updateCoulombState(self.normal, 0, self.kn, self.kt, self.mu, self.source,
                           self.area, (0, 0, 0), 0, (0, 0, 0))
        vertex_weights = []
        for point in self.slave:
            distance = _dot(_subtract(point, self.master[0]), self.normal)
            projected = tuple(value - distance * axis for value, axis in zip(point, self.normal))
            vertex_weights.append(_barycentric(projected, master_triangle))
        self.points = {}
        for key in QUADRATURE_KEYS:
            slave_shape = tuple(value / 6 for value in key)
            master_shape = tuple(math.fsum(slave_shape[j] * vertex_weights[j][i] for j in range(3)) for i in range(3))
            identity = json.dumps([master_body, master_face, row['masterNodes'], slave_body,
                                   slave_face, row['slaveNodes'], list(key)], separators=(',', ':'))
            shape = tuple(-value for value in master_shape) + slave_shape
            relative_rows = tuple(tuple(shape[node] if component == axis else 0.0
                                        for node in range(6) for component in range(3)) for axis in range(3))
            self.points[identity] = {'rows': relative_rows, 'areaMm2': _positive_product(self.area, 1 / 3)}
        # Conditions include geometry, normal, area, coefficients and provenance.
        self.condition = _digest({'definition': row, 'master': self.master, 'slave': self.slave, 'area': self.area})


class ContactHistory:
    """All-or-nothing accepted/trial histories, indexed by meaning rather than order."""
    def __init__(self, patches):
        self.patches = {patch.identifier: patch for patch in patches}
        if len(self.patches) != len(patches):
            raise ValueError('solid-contact-solver: duplicate contact id')
        self.conditions = {key: patch.condition for key, patch in self.patches.items()}
        keys = [key for patch in patches for key in patch.points]
        if len(set(keys)) != len(keys):
            raise ValueError('solid-contact-solver: duplicate semantic integration point')
        self.accepted = {key: {'elasticSlipMm': [0.0] * 3, 'relativeMm': [0.0] * 3,
                              'accumulatedDissipationNmm': 0.0} for key in keys}
        self.active, self.failed, self.step = False, False, 0
        self.trial, self.patch_results = {}, {}
        self.accepted_results = {}
        self.point_order = keys
        self.cancelled = lambda: False

    def snapshot(self):
        return deepcopy(self.accepted)

    def begin(self, patches, *, point_order=None, cancelled=None):
        if self.failed or self.active:
            raise ValueError('solid-contact-solver: failed/active attempt cannot be reused')
        observed = {patch.identifier: patch.condition for patch in patches}
        if len(observed) != len(patches) or observed != self.conditions:
            raise ValueError('solid-contact-solver: contact point set or conditions changed')
        order = list(self.accepted) if point_order is None else list(point_order)
        if len(order) != len(self.accepted) or len(set(order)) != len(order) or set(order) != set(self.accepted):
            raise ValueError('solid-contact-solver: point keys missing, duplicated or changed')
        if cancelled is not None and not callable(cancelled):
            raise ValueError('solid-contact-solver: cancellation predicate required')
        self.point_order, self.cancelled = order, cancelled or (lambda: False)
        self.trial, self.patch_results = {}, {}
        self.active = True

    def evaluate(self, patch, displacement):
        if not self.active or self.failed:
            raise ValueError('solid-contact-solver: no live contact attempt')
        if self.cancelled():
            raise ValueError('solid-contact-solver: cancelled during native trial')
        if patch.identifier not in self.conditions or patch.condition != self.conditions[patch.identifier]:
            raise ValueError('solid-contact-solver: contact conditions changed')
        normal = contactResidualAndTangent(patch.master, patch.slave, patch.normal,
                                           patch.gap, patch.kn, displacement)
        gaps = normal['vertexGapsMm']
        if min(gaps) < 0 < max(gaps):
            raise ValueError('solid-contact-solver: partial contact requires material-point history transfer')
        residual = list(normal['residualN'])
        tangent = [list(row) for row in normal['tangentNPerMm']]
        point_results = {}
        for key in self.point_order:
            if key not in patch.points:
                continue
            point, previous = patch.points[key], self.accepted[key]
            rows = point['rows']
            relative = [_dot(row, displacement) for row in rows]
            gap = _finite(patch.gap + _dot(relative, patch.normal), 'point gap')
            increment = [value - old for value, old in zip(relative, previous['relativeMm'])]
            value = updateCoulombState(patch.normal, gap, patch.kn, patch.kt, patch.mu, patch.source,
                                       point['areaMm2'], previous['elasticSlipMm'],
                                       previous['accumulatedDissipationNmm'], increment)
            local_tangent = [[value['tangentialTangentNPerMm3'][i][j]
                              + value['normalCouplingNPerMm3'][i] * patch.normal[j]
                              for j in range(3)] for i in range(3)]
            for i in range(18):
                residual[i] += math.fsum(rows[axis][i] * value['tangentialForceN'][axis] for axis in range(3))
                for j in range(18):
                    tangent[i][j] += point['areaMm2'] * math.fsum(rows[a][i] * local_tangent[a][b] * rows[b][j]
                                                               for a in range(3) for b in range(3))
            pressure, force = value['normalPressureMPa'], value['normalForceN']
            physical = {'gapMm': gap, 'pressureMPa': pressure, 'normalForceN': force,
                        'areaMm2': point['areaMm2'], 'pressureGapNPerMm': pressure * gap,
                        'forceGapNmm': force * gap, 'referenceLengthMm': patch.reference_length,
                        'referenceForceN': patch.reference_force,
                        'dimensionlessForceGap': force * gap / (patch.reference_force * patch.reference_length)}
            point_results[key] = {'law': value, 'physical': physical}
            self.trial[key] = {'elasticSlipMm': list(value['elasticSlipMm']), 'relativeMm': relative,
                               'accumulatedDissipationNmm': value['accumulatedDissipationNmm']}
        if any(not math.isfinite(value) for value in residual + [value for row in tangent for value in row]):
            raise ValueError('solid-contact-solver: nonfinite assembled contact')
        result = {'residualN': residual, 'tangentNPerMm': tangent, 'points': point_results,
                  'normalResultantN': normal['compressiveResultantN']}
        self.patch_results[patch.identifier] = deepcopy(result)
        return result

    def check(self, free_residual):
        if not self.active or self.failed or set(self.trial) != set(self.accepted) or set(self.patch_results) != set(self.patches):
            raise ValueError('solid-contact-solver: incomplete contact trial cannot commit')
        if not math.isfinite(free_residual) or free_residual > FREE_RESIDUAL_BOUND or free_residual < 0:
            raise ValueError('solid-contact-solver: free-force residual exceeds 1e-8')
        if self.cancelled():
            raise ValueError('solid-contact-solver: cancelled before increment commit')
        for identifier, result in self.patch_results.items():
            patch = self.patches[identifier]
            for point in result['points'].values():
                law, physical = point['law'], point['physical']
                if max(0, -physical['gapMm']) > 1e-6 * patch.reference_length:
                    raise ValueError('solid-contact-solver: penetration exceeds declared length limit')
                force_scale = patch.reference_force
                coefficient = 0.0 if patch.mu is None else patch.mu
                if math.hypot(*law['tangentialForceN']) > coefficient * law['normalForceN'] + 1e-8 * force_scale:
                    raise ValueError('solid-contact-solver: friction cone exceeded')
                if law['addedDissipationNmm'] < -1e-10 * force_scale * patch.reference_length:
                    raise ValueError('solid-contact-solver: negative dissipation')

    def commit(self, free_residual):
        self.check(free_residual)
        self.accepted = deepcopy(self.trial)
        self.accepted_results = deepcopy(self.patch_results)
        self.step += 1
        self.active = False

    def abandon(self):
        self.active, self.failed = False, True
        self.trial, self.patch_results = {}, {}


def make_oofem_contact_element(fem, number, domain, patch, history, native_nodes, counters):
    """Create a structural trampoline before native equation/profile creation."""
    ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)

    class NativeContactElement(fem.StructuralElement):
        def __init__(self):
            super().__init__(number, domain)
            # StaticStructural checks the native C++ structural base type and
            # its cross-section. Initialize that metadata through the binding;
            # contact quadrature and its law remain owned by the fixed patch.
            record = fem.DynamicInputRecord('pointercadfixedp1contact', number)
            record.setField(1, 'crosssect')
            record.setField(fem.IntArray(tuple(native_nodes)), 'nodes')
            self.initializeFrom(record, 0)
            self.setDofManagers(fem.IntArray(tuple(native_nodes)))

        def giveNumberOfDofs(self):
            return 18

        def computeNumberOfDofs(self):
            return 18

        def giveNumberOfInternalDofManagers(self):
            return 0

        def giveDofManDofIDMask(self, inode, answer):
            if not 1 <= inode <= 6:
                raise ValueError('solid-contact-native: local node out of range')
            answer.resize(3)
            for index, dof in enumerate(ids):
                answer[index] = int(dof)

        def giveGeometryType(self):
            return fem.Element_Geometry_Type.EGT_unknown

        def giveClassName(self):
            return 'PointerCADFixedP1Contact'

        def giveInputRecordName(self):
            return 'pointercadfixedp1contact'

        def postInitialize(self):
            return None  # Fixed reference quadrature belongs to the owned patch.

        def computeGtoLRotationMatrix(self, answer):
            answer.resize(0, 0)
            return False  # All DOFs, forces and tangents already use global axes.

        def evaluated(self, step):
            displacement = [float(domain.giveDofManager(node).giveDofWithID(dof).giveUnknown(
                fem.ValueModeType.VM_Total, step)) for node in native_nodes for dof in ids]
            counters['evaluations'] += 1
            return history.evaluate(patch, displacement)

        def giveCharacteristicMatrix(self, answer, kind, step):
            if kind != fem.CharType.TangentStiffnessMatrix:
                raise ValueError('solid-contact-native: unsupported characteristic matrix')
            counters['tangent'] += 1
            values = self.evaluated(step)['tangentNPerMm']
            answer.resize(18, 18)
            for i in range(18):
                for j in range(18):
                    answer[i, j] = values[i][j]

        def giveCharacteristicVector(self, answer, kind, mode, step):
            if kind == fem.CharType.InternalForcesVector:
                counters['residual'] += 1
                values = self.evaluated(step)['residualN']
            elif kind == fem.CharType.ExternalForcesVector:
                values = [0.0] * 18
            elif kind == fem.CharType.LastEquilibratedInternalForcesVector:
                previous = history.accepted_results.get(patch.identifier)
                values = list(previous['residualN']) if previous is not None else [0.0] * 18
            else:
                raise ValueError('solid-contact-native: unsupported characteristic vector')
            answer.resize(18)
            for i, value in enumerate(values):
                answer[i] = value

    return NativeContactElement()


def _read_native_plan(value):
    plan = deepcopy(value)
    if not isinstance(plan, dict):
        raise ValueError('solid-contact-native: explicit plan required')
    nodes = plan['nodes']
    if not isinstance(nodes, list) or len(nodes) < 4:
        raise ValueError('solid-contact-native: at least four nodes required')
    plan['nodes'] = [_vector(point, 'native coordinate') for point in nodes]
    if type(plan['steps']) is not int or not 1 <= plan['steps'] <= 200:
        raise ValueError('solid-contact-native: step count must be from one to 200')
    maximum = plan.get('maxIterations', 50)
    if type(maximum) is not int or maximum < 1:
        raise ValueError('solid-contact-native: positive explicit iteration limit required')
    plan['maxIterations'] = maximum
    young, poisson = _finite(plan['youngMPa'], 'Young modulus'), _finite(plan['poisson'], 'Poisson ratio')
    if young <= 0 or not -1 < poisson < .5:
        raise ValueError('solid-contact-native: invalid elastic constants')
    if not isinstance(plan['elements'], list) or not plan['elements']:
        raise ValueError('solid-contact-native: tetrahedral elements required')
    for connectivity in plan['elements']:
        if (not isinstance(connectivity, (list, tuple)) or len(connectivity) != 4
                or any(type(node) is not int or not 0 <= node < len(nodes) for node in connectivity)
                or len(set(connectivity)) != 4):
            raise ValueError('solid-contact-native: four distinct existing tetrahedral nodes required')
        a, b, c, d = (plan['nodes'][node] for node in connectivity)
        u, v, w = _subtract(b, a), _subtract(c, a), _subtract(d, a)
        volume6 = _dot(u, (v[1] * w[2] - v[2] * w[1], v[2] * w[0] - v[0] * w[2], v[0] * w[1] - v[1] * w[0]))
        if volume6 <= 0:
            raise ValueError('solid-contact-native: positive reference tetrahedral volume required')
    if not isinstance(plan['bodies'], dict) or not plan['bodies']:
        raise ValueError('solid-contact-native: body-local node identities required')
    used = []
    for body, indices in plan['bodies'].items():
        _identity(body, 'body id')
        if not isinstance(indices, (list, tuple)) or not indices:
            raise ValueError('solid-contact-native: body nodes required')
        if any(type(node) is not int or not 0 <= node < len(nodes) for node in indices):
            raise ValueError('solid-contact-native: body node out of range')
        used.extend(indices)
    if sorted(used) != list(range(len(nodes))):
        raise ValueError('solid-contact-native: original nodes must belong to exactly one body')
    for name in ('prescribed', 'loads'):
        histories = plan[name]
        if not isinstance(histories, dict):
            raise ValueError('solid-contact-native: explicit scalar DOF histories required')
        for key, history in histories.items():
            if (not isinstance(key, tuple) or len(key) != 2 or type(key[0]) is not int or type(key[1]) is not int
                    or not 0 <= key[0] < len(nodes) or not 0 <= key[1] < 3):
                raise ValueError('solid-contact-native: unknown history DOF')
            if not isinstance(history, (list, tuple)) or len(history) != plan['steps']:
                raise ValueError('solid-contact-native: each history needs every step')
            histories[key] = [_finite(item, name) for item in history]
    if set(plan['prescribed']) & set(plan['loads']):
        raise ValueError('solid-contact-native: force and prescribed displacement on same DOF')
    if not isinstance(plan['contacts'], list) or not plan['contacts']:
        raise ValueError('solid-contact-native: explicit contact patches required')
    return plan


def _native_deck(plan, path):
    n = plan['steps']
    reference = max(_finite(row['referenceForceN'], 'force reference') for row in plan['contacts'])
    lines = [path + '.out', 'PointerCAD fixed P1 contact in native StaticStructural/NRSolver',
             f'StaticStructural nsteps {n} rtolf 1e-10 maxiter {plan["maxIterations"]} manrmsteps 1 '
             f'nmodules 0 smtype 1 forcescale 3 {reference} {reference} {reference} forcescaledofs 3 1 2 3',
             'domain 3d', 'OutputManager']
    records, functions, load_functions = [], [], {}
    for category in ('prescribed', 'loads'):
        for (node, axis), history in sorted(plan[category].items()):
            function = len(functions) + 1
            functions.append(f'PiecewiseLinFunction {function} t {n + 1} ' + ' '.join(str(i) for i in range(n + 1))
                             + f' f(t) {n + 1} ' + ' '.join(str(v) for v in [0.0] + history))
            if category == 'prescribed':
                records.append(f'BoundaryCondition {len(records) + 1} loadTimeFunction {function} '
                               f'dofs 1 {axis + 1} values 1 1.0 set {node + 2}')
            else:
                records.append(f'NodalLoad {len(records) + 1} loadTimeFunction {function} '
                               f'dofs 1 {axis + 1} Components 1 1.0 set {node + 2}')
                load_functions[(node, axis)] = function
    lines.append(f'ndofman {len(plan["nodes"])} nelem {len(plan["elements"])} ncrosssect 1 nmat 1 '
                 f'nbc {len(records)} nltf {len(functions)} nic 0 nset {len(plan["nodes"]) + 1}')
    lines += [f'node {i + 1} coords 3 ' + ' '.join(str(v) for v in point) for i, point in enumerate(plan['nodes'])]
    lines += [f'ltrspace {i + 1} nodes 4 ' + ' '.join(str(node + 1) for node in connectivity)
              for i, connectivity in enumerate(plan['elements'])]
    lines += ['SimpleCS 1 material 1 set 1',
              f'IsoLE 1 d 0 tAlpha 0.0 E {plan["youngMPa"]} n {plan["poisson"]}']
    lines += records + functions
    lines.append(f'Set 1 elementranges {{(1 {len(plan["elements"])})}}')
    lines += [f'Set {i + 2} nodes 1 {i + 1}' for i in range(len(plan['nodes']))]
    return '\n'.join(lines + ['']), load_functions


class SolidContactRun:
    """Single-use native analysis owning its injected Python contact elements."""
    def __init__(self, fem, value, path='/pcad_fem/solid-contact'):
        from importlib.metadata import version
        if version('oofem') != '3.1.dev5+g214b161ed':
            raise ValueError('solid-contact-native: unexpected packaged OOFEM version')
        if len(_NATIVE_LIFETIME) >= MAX_RETAINED_NATIVE_ANALYSES:
            raise ValueError('solid-contact-native: native runtime lifetime exhausted; create a fresh runtime')
        self.fem, self.plan = fem, _read_native_plan(value)
        self.patches = [FixedContactPatch(row, self.plan['nodes'], self.plan['bodies']) for row in self.plan['contacts']]
        self.history = ContactHistory(self.patches)
        self.records, self.finished = [], False
        self.counters = {'evaluations': 0, 'tangent': 0, 'residual': 0}
        self.native_elements = []
        self.problem = None
        deck, self.load_functions = _native_deck(self.plan, path)
        with open(path + '.in', 'w', encoding='utf-8') as stream:
            stream.write(deck)
        problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader(path + '.in'), fem.problemMode.processor, 0, None, False)
        if problem is None:
            raise ValueError('solid-contact-native: native model instantiation failed')
        self.problem, self.domain = problem, problem.giveDomain(1)
        # Keep the exact Python elements alive for every native pointer use.
        _NATIVE_LIFETIME.append((problem, self.native_elements))
        try:
            original_count = len(self.plan['elements'])
            self.domain.resizeElements(original_count + len(self.patches))
            for offset, patch in enumerate(self.patches, 1):
                element = make_oofem_contact_element(fem, original_count + offset, self.domain, patch,
                                                     self.history, [node + 1 for node in patch.original_nodes], self.counters)
                self.native_elements.append(element)
                self.domain.setElement(original_count + offset, element)
                if self.domain.giveElement(original_count + offset) is not element:
                    raise ValueError('solid-contact-native: injected element identity not retained')
                element.postInitialize()
            if problem.checkProblemConsistency() != 1:
                raise ValueError('solid-contact-native: inconsistent injected native domain')
            problem.setRenumberFlag()
            problem.init()
            problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
            meta = problem.giveMetaStep(1)
            if meta is None or meta.giveNumberOfSteps() != self.plan['steps']:
                raise ValueError('solid-contact-native: native metastep differs from plan')
            problem.initMetaStepAttributes(meta)
        except BaseException as error:
            self.finished = True
            self.history.abandon()
            try:
                problem.terminateAnalysis()
            except BaseException as cleanup:
                error.add_note('Additional native termination error: ' + repr(cleanup))
            raise

    def _mapping(self):
        fem, plan = self.fem, self.plan
        numbering = fem.EModelDefaultEquationNumbering()
        count = int(self.problem.giveNumberOfDomainEquations(1, numbering))
        bodies = {body: [{'nativeNode': original + 1,
                         'fixed': [(original, axis) in plan['prescribed'] for axis in range(3)]}
                        for original in indices] for body, indices in plan['bodies'].items()}
        locations = []
        for patch, element in zip(self.patches, self.native_elements):
            expected = contactEquationMap(fem, self.domain, numbering, bodies, patch.references, count)
            actual = fem.IntArray()
            element.giveLocationArray(actual, numbering, None)
            if list(actual) != expected:
                raise ValueError('solid-contact-native: actual contact equation location differs')
            locations.append(expected)
        return count, locations

    def _independent_forces(self, step):
        fem, plan = self.fem, self.plan
        internal = [[0.0] * 3 for _ in plan['nodes']]
        connectivity = list(plan['elements']) + [patch.original_nodes for patch in self.patches]
        for number, nodes in enumerate(connectivity, 1):
            values = fem.FloatArray()
            self.domain.giveElement(number).giveCharacteristicVector(values, fem.CharType.InternalForcesVector,
                                                                      fem.ValueModeType.VM_Total, step)
            if len(list(values)) != len(nodes) * 3:
                raise ValueError('solid-contact-native: native element force vector extent differs')
            for i, value in enumerate(values):
                internal[nodes[i // 3]][i % 3] += _finite(float(value), 'native element force')
        external = [[0.0] * 3 for _ in plan['nodes']]
        for (node, axis), function in self.load_functions.items():
            actual = _finite(float(self.domain.giveFunction(function).evaluate(step, fem.ValueModeType.VM_Total)), 'native load')
            expected = plan['loads'][(node, axis)][len(self.records)]
            if abs(actual - expected) > 1e-12 * max(1.0, abs(expected)):
                raise ValueError('solid-contact-native: native load function differs from declared history')
            external[node][axis] = actual
        reference = max(patch.reference_force for patch in self.patches)
        residual = max((abs(internal[node][axis] - external[node][axis]) / reference
                        for node in range(len(plan['nodes'])) for axis in range(3)
                        if (node, axis) not in plan['prescribed']), default=0.0)
        return internal, external, residual

    def advance(self, *, cancelled=None, point_order=None):
        if self.finished or len(self.records) >= self.plan['steps']:
            raise ValueError('solid-contact-native: ended analysis cannot be reused')
        index, fem = len(self.records), self.fem
        before = self.history.snapshot()
        try:
            self.history.begin(self.patches, point_order=point_order, cancelled=cancelled)
            self.problem.preInitializeNextStep()
            step = self.problem.giveNextStep()
            self.problem.initializeYourself(step)
            self.problem.forceEquationNumbering()
            equations, locations = self._mapping()
            initial_callbacks = dict(self.counters)
            self.problem.solveYourselfAt(step)
            during_native = {key: self.counters[key] - initial_callbacks[key] for key in self.counters}
            if self.counters['tangent'] == 0 or during_native['residual'] == 0:
                raise ValueError('solid-contact-native: ordinary Newton did not evaluate the contact law')
            ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
            displacement = [[_finite(float(self.domain.giveDofManager(node + 1).giveDofWithID(dof).giveUnknown(
                fem.ValueModeType.VM_Total, step)), 'native displacement') for dof in ids] for node in range(len(self.plan['nodes']))]
            for (node, axis), values in self.plan['prescribed'].items():
                if displacement[node][axis] != values[index]:
                    raise ValueError('solid-contact-native: prescribed displacement was not reproduced exactly')
            internal, external, residual = self._independent_forces(step)
            self.history.check(residual)
            record = {'success': True, 'step': index + 1, 'displacementMm': displacement,
                      'freeResidual': residual, 'referenceForceN': max(patch.reference_force for patch in self.patches),
                      'internalForcesN': internal, 'externalForcesN': external,
                      'contacts': deepcopy(self.history.patch_results), 'nativeCallbacks': during_native,
                      'nativeEquationCount': equations, 'nativeContactLocations': locations,
                      'injectedElementIdentityPreserved': True, 'requestedNativeMatrixType': 'SkylineU (smtype 1)',
                      'iterationLimit': self.plan['maxIterations'], 'nativeIterationCount': None,
                      'strictComplementarityQualified': False}
            # Validate all reported values before native update and Python commit.
            json.dumps(record, allow_nan=False)
            self.problem.updateYourself(step)
            self.history.commit(residual)
            record['accepted'] = self.history.snapshot()
            self.records.append(record)
            return deepcopy(record)
        except BaseException as error:
            self.finished = True
            self.history.abandon()
            if self.history.snapshot() != before:
                raise RuntimeError('solid-contact-native: accepted history changed during a rejected increment') from error
            failure = ContactIncrementError(str(error), index + 1, self.counters, before, self.plan['maxIterations'])
            try:
                self.problem.terminateAnalysis()
            except BaseException as cleanup:
                failure.add_note('Additional native termination error: ' + repr(cleanup))
            raise failure from error

    def close(self):
        if not self.finished:
            self.finished = True
            self.problem.terminateAnalysis()


def solveSolidContactIncrement(run, *, cancelled=None, point_order=None):
    """Advance the owned real native run once; no external Newton iteration."""
    if not isinstance(run, SolidContactRun):
        raise ValueError('solid-contact-native: owned native run required')
    return run.advance(cancelled=cancelled, point_order=point_order)
