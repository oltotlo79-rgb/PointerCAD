"""Fixed OOFEM 214b161 TR_SHELL02 + SimpleCS + IsoLE static linear shell path, N-mm-MPa-rad.

The element (DKTPlate3d bending + TrPlanestressRotAllman3d membrane, six DOFs per node), the
global LinearStatic solve and every integration-point resultant are the existing native OOFEM
code. This wrapper only writes the deck from the validated TypeScript plan, reads the native
values back and checks them. It assembles no stiffness of its own, has no constitutive law and
recovers no stress; the TypeScript side derives surface stresses from the native resultants.

Checks on the native answer:
- every element is the native class TR_SHELL02 with a SimpleCrossSection and six-DOF nodes;
- free-DOF equilibrium of the native element matrices and the overall force/moment balance;
- a scaled native Skyline/LDLT refactorization of the same native element matrices: its D pivots
  detect a mechanism (ldltfact.C reports CR_CONVERGED even for a singular matrix) and its
  solution must equal the native LinearStatic displacements.

TR_SHELL02::giveCharacteristicMatrix gives the element-frame matrix; the native assembler
(core/engngm.C) rotates it with giveRotationMatrix, which the Python binding does not expose.
The frame is rebuilt exactly as DKTPlate3d/TrPlanestressRotAllman3d::computeGtoLRotationMatrix
(e1 = N2-N1, e3 = e1 x (N3-N1), e2 = e3 x e1); the agreement with the LinearStatic solution
proves that the same rotation was used.

Native result units (read from the pinned source, not assumed): IST_ShellMomentTensor is N*mm/mm
and IST_CurvatureTensor 1/mm, both about the element normal e3. The membrane part of
IST_ShellForceTensor is the plane-stress stress in MPa: trplanestressrotallman3d.C:238 only
carries the comment "multiply stresses by thickness to get forces". The DKT part adds the
transverse shear forces, which are identically zero because DKT is shear rigid (dkt.C B rows 4-5).
"""
import json
import math
from importlib.metadata import version

PLAN_SCHEMA = 'pointercad-shell-tri3-plan/1'
INPUT_SCHEMA = 'pointercad-shell-tri3/1'
RESULT_SCHEMA = 'pointercad-shell-tri3-native/1'
ELEMENT_RECORD = 'tr_shell02'
ELEMENT_CLASS = 'TR_SHELL02'
SECTION_CLASS = 'SimpleCrossSection'
INTEGRATION_POINTS = 4
STATES = ('IST_ShellForceTensor', 'IST_ShellMomentTensor', 'IST_ShellStrainTensor', 'IST_CurvatureTensor')
MAX_NODES = 20000
MAX_ELEMENTS = 40000


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('shell-numeric: finite number required')
    return float(value)


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _unit(vector):
    length = math.sqrt(sum(v * v for v in vector))
    if not length > 0 or not math.isfinite(length):
        raise ValueError('shell-geometry: degenerate triangle frame')
    return [v / length for v in vector]


def _frame(points):
    """Rows e1, e2, e3 exactly as DKTPlate3d::computeGtoLRotationMatrix."""
    first, second, third = points
    e1 = _unit([second[i] - first[i] for i in range(3)])
    e3 = _unit(_cross(e1, [third[i] - first[i] for i in range(3)]))
    return [e1, _cross(e3, e1), e3]


def _global_matrix(local, frame):
    """K_global = R^T K_local R with R = blockdiag(G, G, G, G, G, G), r_local = R r_global."""
    answer = [[0.0] * 18 for _ in range(18)]
    for row_block in range(6):
        for column_block in range(6):
            r0, c0 = 3 * row_block, 3 * column_block
            right = [[sum(local[r0 + c][c0 + d] * frame[d][b] for d in range(3)) for b in range(3)] for c in range(3)]
            for a in range(3):
                for b in range(3):
                    answer[r0 + a][c0 + b] = sum(frame[c][a] * right[c][b] for c in range(3))
    return answer


def _local_matrix(fem, element, step):
    matrix = fem.FloatMatrix()
    element.giveCharacteristicMatrix(matrix, fem.CharType.TangentStiffnessMatrix, step)
    # The binding has no FloatMatrix extent; its __getitem__ raises IndexError past the extent.
    for outside in ((18, 0), (0, 18)):
        try:
            matrix[outside]
        except IndexError:
            continue
        raise ValueError('shell-native: unexpected TR_SHELL02 matrix size')
    values = [[_finite(matrix[i, j]) for j in range(18)] for i in range(18)]
    scale = max(abs(value) for row in values for value in row)
    if not scale > 0 or any(abs(values[i][j] - values[j][i]) > 1e-11 * scale for i in range(18) for j in range(18)):
        raise ValueError('shell-native: invalid element stiffness symmetry')
    return matrix, values


def _validate(plan):
    if not isinstance(plan, dict) or plan.get('schema') != PLAN_SCHEMA:
        raise ValueError('shell-input: invalid plan schema')
    data = plan['input']
    if (data['schema'] != INPUT_SCHEMA or data['units'] != 'N-mm-MPa-rad' or plan['element'] != ELEMENT_RECORD
            or plan['integrationPoints'] != INTEGRATION_POINTS or data['surface'] != 'explicit-reference-surface'):
        raise ValueError('shell-input: unsupported schema, units, surface or element')
    count, element_count = len(data['nodes']), len(data['elements'])
    if not 3 <= count <= MAX_NODES or not 1 <= element_count <= MAX_ELEMENTS:
        raise ValueError('shell-input: invalid bounded plan')
    if len(plan['fixed']) != count or len(plan['loads']) != count or len(plan['normals']) != element_count:
        raise ValueError('shell-input: inconsistent node or element fields')
    for row in plan['fixed']:
        if len(row) != 6 or any(type(v) is not bool for v in row):
            raise ValueError('shell-input: exactly six restraint flags required')
    for row in plan['loads']:
        if len(row) != 6:
            raise ValueError('shell-input: exactly six load components required')
        for value in row:
            _finite(value)
    for point in data['nodes']:
        if len(point) != 3:
            raise ValueError('shell-input: three coordinates required')
        for value in point:
            _finite(value)
    for element in data['elements']:
        nodes = element['nodes']
        if (len(nodes) != 3 or len(set(nodes)) != 3
                or any(type(i) is not int or not 0 <= i < count for i in nodes)):
            raise ValueError('shell-input: invalid triangle')
        # TR_SHELL02 places its nodes on the midsurface; eccentricity is not modelled natively.
        if not _finite(element['thicknessMm']) > 0 or _finite(element['offsetMm']) != 0:
            raise ValueError('shell-input: positive thickness and zero offset required')
    return data


def _deck(plan):
    data = plan['input']
    materials = {row['id']: i + 1 for i, row in enumerate(data['materials'])}
    sections = {}
    for element in data['elements']:
        sections.setdefault((element['materialId'], _finite(element['thicknessMm'])), len(sections) + 1)
    loaded = [node for node, row in enumerate(plan['loads']) if any(value != 0 for value in row)]
    load_numbers = {node: 2 + index for index, node in enumerate(loaded)}
    lines = ['/pcad_fem/shell.out', 'PointerCAD tr_shell02; coherent N, mm, MPa, rad',
             'LinearStatic nsteps 1 nmodules 0', 'domain 3dshell', 'OutputManager',
             f"ndofman {len(data['nodes'])} nelem {len(data['elements'])} ncrosssect {len(sections)} "
             f"nmat {len(materials)} nbc {1 + len(loaded)} nltf 1 nic 0"]
    for number, (point, fixed) in enumerate(zip(data['nodes'], plan['fixed'], strict=True), 1):
        line = f'node {number} coords 3 ' + ' '.join(repr(_finite(v)) for v in point)
        if any(fixed):
            line += ' bc 6 ' + ' '.join('1' if v else '0' for v in fixed)
        if number - 1 in load_numbers:
            line += f' load 1 {load_numbers[number - 1]}'
        lines.append(line)
    for number, element in enumerate(data['elements'], 1):
        section = sections[(element['materialId'], _finite(element['thicknessMm']))]
        lines.append(f'{ELEMENT_RECORD} {number} nodes 3 ' + ' '.join(str(i + 1) for i in element['nodes'])
                     + f" mat {materials[element['materialId']]} crosssect {section} nip {INTEGRATION_POINTS}")
    for (material_id, thickness), number in sections.items():
        lines.append(f'SimpleCS {number} thick {thickness!r} material {materials[material_id]}')
    for number, material in enumerate(data['materials'], 1):
        # Static stiffness has no density contribution; d=0 is never a reported mass.
        lines.append(f"IsoLE {number} d 0 E {_finite(material['youngMPa'])!r} "
                     f"n {_finite(material['poisson'])!r} tAlpha 0")
    lines.append('BoundaryCondition 1 loadTimeFunction 1 prescribedValue 0')
    for node in loaded:
        lines.append(f'NodalLoad {load_numbers[node]} loadTimeFunction 1 components 6 '
                     + ' '.join(repr(_finite(v)) for v in plan['loads'][node]))
    lines += ['ConstantFunction 1 f(t) 1', '']
    return '\n'.join(lines)


def _element_checks(fem, domain, data):
    expected = [int(dof) for dof in (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w,
                                     fem.DofIDItem.R_u, fem.DofIDItem.R_v, fem.DofIDItem.R_w)]
    classes, sections = [], []
    for index, row in enumerate(data['elements']):
        element = domain.giveElement(index + 1)
        classes.append(element.giveClassName())
        sections.append(element.giveCrossSection().giveClassName())
        if classes[-1] != ELEMENT_CLASS or sections[-1] != SECTION_CLASS or element.giveNumberOfNodes() != 3:
            raise ValueError('shell-native: element is not the native TR_SHELL02 with SimpleCS')
        for local, node in enumerate(row['nodes'], 1):
            mask = fem.IntArray()
            element.giveDofManDofIDMask(local, mask)
            if element.giveDofManagerNumber(local) != node + 1 or list(mask) != expected:
                raise ValueError('shell-native: element/node/DOF association changed')
    return classes, sections


def _integration_points(fem, element, step):
    rule = element.giveDefaultIntegrationRulePtr()
    if rule.giveNumberOfIntegrationPoints() != INTEGRATION_POINTS:
        raise ValueError('shell-native: unexpected integration rule')
    points = []
    for index in range(INTEGRATION_POINTS):
        point = rule.getIntegrationPoint(index)
        row = {'xyzMm': [_finite(v) for v in point.giveGlobalCoordinates()]}
        if len(row['xyzMm']) != 3:
            raise ValueError('shell-native: integration point is not three-dimensional')
        for name in STATES:
            value = fem.FloatArray()
            if element.giveIPValue(value, point, getattr(fem.InternalStateType, name), step) != 1:
                raise ValueError('shell-native: missing native resultant ' + name)
            row[name] = [_finite(v) for v in value]
            if len(row[name]) != 6:
                raise ValueError('shell-native: resultant is not a six-component tensor')
        points.append(row)
    return points


def _refactorize(fem, problem, domain, data, plan, stiffness, displacement):
    """Same native element matrices in a scaled native Skyline; D pivots and solution identity."""
    count = len(data['nodes'])
    ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w,
           fem.DofIDItem.R_u, fem.DofIDItem.R_v, fem.DofIDItem.R_w)
    numbering = fem.EModelDefaultEquationNumbering()
    equations = int(problem.giveNumberOfDomainEquations(1, numbering))
    node_equations = [[int(numbering.giveDofEquationNumber(domain.giveDofManager(i + 1).giveDofWithID(dof)))
                       for dof in ids] for i in range(count)]
    observed = []
    for node, row in enumerate(node_equations):
        for axis, equation in enumerate(row):
            if plan['fixed'][node][axis] != (equation == 0) or (equation and not 1 <= equation <= equations):
                raise ValueError('shell-native: restraint/numbering mismatch')
            if equation:
                observed.append(equation)
    if sorted(observed) != list(range(1, equations + 1)):
        raise ValueError('shell-native: non-bijective equation numbering')
    if equations == 0:
        return 1.0, 0.0
    diagonal = [0.0] * equations
    for row, values in zip(data['elements'], stiffness, strict=True):
        location = [eq for node in row['nodes'] for eq in node_equations[node]]
        for local, equation in enumerate(location):
            if equation:
                diagonal[equation - 1] += values[local][local]
    if any(not math.isfinite(v) or v <= 0 for v in diagonal):
        raise ValueError('shell-mechanism: nonpositive restrained diagonal')
    scaling = [1 / math.sqrt(v) for v in diagonal]
    matrix = fem.skyline()
    matrix.buildInternalStructure(problem, 1, numbering)
    if matrix.giveNumberOfRows() != equations:
        raise ValueError('shell-native: matrix extent mismatch')
    step = problem.giveCurrentStep(False)
    for index, (row, values) in enumerate(zip(data['elements'], stiffness, strict=True)):
        element = domain.giveElement(index + 1)
        native, _ = _local_matrix(fem, element, step)
        location = fem.IntArray()
        element.giveLocationArray(location, numbering, None)
        expected = [eq for node in row['nodes'] for eq in node_equations[node]]
        if list(location) != expected:
            raise ValueError('shell-native: native location differs from node equations')
        for a, eq_a in enumerate(expected):
            for b, eq_b in enumerate(expected):
                native[a, b] = values[a][b] * (scaling[eq_a - 1] if eq_a else 0) * (scaling[eq_b - 1] if eq_b else 0)
        matrix.assemble(location, native)
    rhs = [0.0] * equations
    for node, row in enumerate(node_equations):
        for axis, equation in enumerate(row):
            if equation:
                rhs[equation - 1] = _finite(_finite(plan['loads'][node][axis]) * scaling[equation - 1])
    right, solved = fem.FloatArray(tuple(rhs)), fem.FloatArray()
    reason = fem.ldltfactorization(domain, problem).solve(matrix, right, solved)
    if reason != fem.ConvergedReason.CR_CONVERGED or len(list(solved)) != equations:
        raise ValueError('shell-native: sparse refactorization failed')
    # After solve the Skyline diagonal slots hold the D pivots of the scaled matrix.
    pivots = [_finite(matrix.at(i, i)) for i in range(1, equations + 1)]
    minimum = min(pivots)
    if minimum <= 1e-12 or max(pivots) > 1 + 1e-10:
        raise ValueError('shell-mechanism: nonpositive or numerically unresolved scaled LDL pivot')
    scale = max(1e-300, max(abs(v) for row in displacement for v in row))
    difference = 0.0
    for node, row in enumerate(node_equations):
        for axis, equation in enumerate(row):
            explicit = _finite(float(solved[equation - 1]) * scaling[equation - 1]) if equation else 0.0
            difference = max(difference, abs(explicit - displacement[node][axis]) / scale)
    if difference > 1e-8:
        raise ValueError('shell-native: refactorized and LinearStatic displacements differ')
    return minimum, difference


def _equilibrium(data, plan, stiffness, displacement):
    count = len(data['nodes'])
    internal = [[0.0] * 6 for _ in range(count)]
    for row, values in zip(data['elements'], stiffness, strict=True):
        local_u = [v for node in row['nodes'] for v in displacement[node]]
        force = [math.fsum(k * u for k, u in zip(line, local_u, strict=True)) for line in values]
        for local, node in enumerate(row['nodes']):
            for axis in range(6):
                internal[node][axis] = _finite(internal[node][axis] + force[6 * local + axis])
    loads = [[_finite(v) for v in row] for row in plan['loads']]
    points = data['nodes']
    lows = [min(p[i] for p in points) for i in range(3)]
    highs = [max(p[i] for p in points) for i in range(3)]
    length = math.sqrt(sum((h - l) ** 2 for h, l in zip(highs, lows, strict=True)))
    if not length > 0:
        raise ValueError('shell-geometry: zero model extent')
    # One generalized-force scale: forces in N, moments divided by the model diagonal in mm.
    def generalized(rows):
        return max([abs(v) for row in rows for v in row[:3]] + [abs(v) / length for row in rows for v in row[3:]])
    scale = max(1e-300, generalized(loads), generalized(internal))
    residual = 0.0
    reactions = [[0.0] * 6 for _ in range(count)]
    for node in range(count):
        for axis in range(6):
            difference = internal[node][axis] - loads[node][axis]
            if plan['fixed'][node][axis]:
                reactions[node][axis] = _finite(difference)
            else:
                residual = max(residual, abs(difference) / (scale * (1 if axis < 3 else length)))
    if not math.isfinite(residual) or residual > 1e-8:
        raise ValueError('shell-equilibrium: native free-DOF residual exceeds 1e-8')
    force = [0.0, 0.0, 0.0]
    moment = [0.0, 0.0, 0.0]
    for node in range(count):
        total = [loads[node][axis] + reactions[node][axis] for axis in range(6)]
        arm = _cross(points[node], total[:3])
        for axis in range(3):
            force[axis] += total[axis]
            moment[axis] += total[3 + axis] + arm[axis]
    balance = max(max(abs(v) for v in force), max(abs(v) for v in moment) / length) / scale
    if not math.isfinite(balance) or balance > 1e-8:
        raise ValueError('shell-equilibrium: loads and reactions are not in overall balance')
    return reactions, residual, balance


def run_shell_analysis():
    import oofem as fem
    if version('oofem') != '3.1.dev5+g214b161ed':
        raise ValueError('shell-native: unexpected OOFEM distribution')
    with open('/pcad_fem/shell-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    data = _validate(plan)
    with open('/pcad_fem/shell.in', 'w', encoding='utf-8') as stream:
        stream.write(_deck(plan))
    problem = None
    primary = None
    try:
        problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader('/pcad_fem/shell.in'),
                                        fem.problemMode.processor, 0, None, False)
        if problem is None or problem.checkProblemConsistency() != 1:
            raise ValueError('shell-native: inconsistent native model')
        problem.solveYourself()
        step = problem.giveCurrentStep(False)
        domain = problem.giveDomain(1)
        classes, sections = _element_checks(fem, domain, data)
        ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w,
               fem.DofIDItem.R_u, fem.DofIDItem.R_v, fem.DofIDItem.R_w)
        displacement = [[_finite(domain.giveDofManager(i + 1).giveDofWithID(dof).giveUnknown(
            fem.ValueModeType.VM_Total, step)) for dof in ids] for i in range(len(data['nodes']))]
        stiffness = []
        for index, row in enumerate(data['elements']):
            _, local = _local_matrix(fem, domain.giveElement(index + 1), step)
            stiffness.append(_global_matrix(local, _frame([data['nodes'][i] for i in row['nodes']])))
        reactions, residual, balance = _equilibrium(data, plan, stiffness, displacement)
        points = [_integration_points(fem, domain.giveElement(i + 1), step) for i in range(len(data['elements']))]
        pivot, difference = _refactorize(fem, problem, domain, data, plan, stiffness, displacement)
        return json.dumps({'schema': RESULT_SCHEMA, 'source': data['source'], 'elementRecord': ELEMENT_RECORD,
                           'elementClasses': classes, 'crossSectionClasses': sections,
                           'displacement': displacement, 'reactions': reactions,
                           'freeResidualRelative': residual, 'balanceRelative': balance,
                           'minimumScaledPivot': pivot, 'refactorizationDifferenceRelative': difference,
                           'integrationPoints': points}, allow_nan=False)
    except BaseException as error:
        primary = error
        raise
    finally:
        if problem is not None:
            try:
                problem.terminateAnalysis()
            except BaseException as cleanup:
                if primary is not None:
                    primary.add_note('Additional native termination error: ' + repr(cleanup))
                else:
                    raise
