"""Fixed OOFEM214b161 ltrspace/IsoLE static linear elasticity, N-mm-MPa.

OOFEM native element matrices and native Skyline/LDLT solve; no dense global K,
NumPy solver or replacement constitutive engine. Native success alone is not a
singularity test: ldltfact.C returns CR_CONVERGED unconditionally. Check the
factorized, equilibrated matrix's D pivots and the original element residuals.
"""
import json
import math
from importlib.metadata import version


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('solid-numeric: finite number required')
    return float(value)


def _deck(plan):
    data = plan['input']
    materials = {row['id']: i + 1 for i, row in enumerate(data['materials'])}
    lines = ['/pcad_fem/solid.out', 'PointerCAD tet4; coherent N, mm, MPa',
             'LinearStatic nsteps 1 nmodules 0', 'domain 3d', 'OutputManager',
             f"ndofman {len(data['nodes'])} nelem {len(data['elements'])} "
             f"ncrosssect {len(materials)} nmat {len(materials)} nbc 1 nltf 1 nic 0"]
    for number, (point, fixed) in enumerate(zip(data['nodes'], plan['fixed'], strict=True), 1):
        lines.append(f'node {number} coords 3 ' + ' '.join(str(_finite(v)) for v in point)
                     + ' bc 3 ' + ' '.join('1' if v else '0' for v in fixed))
    for number, element in enumerate(data['elements'], 1):
        material = materials[element['materialId']]
        lines.append(f'ltrspace {number} nodes 4 ' + ' '.join(str(i + 1) for i in element['nodes'])
                     + f' mat {material} crosssect {material}')
    for number in range(1, len(materials) + 1):
        lines.append(f'SimpleCS {number} material {number}')
    for number, material in enumerate(data['materials'], 1):
        # Static stiffness has no density contribution. d=0 is not a supplied
        # physical density and must never be reported as a mass prediction.
        lines.append(f"IsoLE {number} d 0 E {_finite(material['youngMPa'])} "
                     f"n {_finite(material['poisson'])} tAlpha 0.0")
    lines += ['BoundaryCondition 1 loadTimeFunction 1 prescribedValue 0.0',
              'PeakFunction 1 t 1.0 f(t) 1.0', '']
    return '\n'.join(lines)


def _native_matrix(fem, element, step):
    matrix = fem.FloatMatrix()
    element.giveCharacteristicMatrix(matrix, fem.CharType.TangentStiffnessMatrix, step)
    values = [[_finite(matrix[i, j]) for j in range(12)] for i in range(12)]
    scale = max(abs(value) for row in values for value in row)
    if not scale > 0 or any(abs(values[i][j] - values[j][i]) > 1e-11 * scale
                           for i in range(12) for j in range(12)):
        raise ValueError('solid-native: invalid element stiffness symmetry')
    return matrix, values


def run_solid_analysis():
    import oofem as fem
    if version('oofem') != '3.1.dev5+g214b161ed':
        raise ValueError('solid-native: unexpected OOFEM distribution')
    with open('/pcad_fem/solid-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    data = plan['input']
    if (plan['schema'] != 'pointercad-solid-tet4-plan/1' or data['schema'] != 'pointercad-solid-tet4/1'
            or data['units'] != 'N-mm-MPa' or not 4 <= len(data['nodes']) <= 10000
            or not 1 <= len(data['elements']) <= 50000):
        raise ValueError('solid-input: invalid bounded plan')
    count, element_count = len(data['nodes']), len(data['elements'])
    budget = data['numericBudgetBytes']
    if not isinstance(budget, int) or isinstance(budget, bool) or budget <= 0:
        raise ValueError('solid-budget: explicit integer reservation required')
    # Conservative simultaneous numeric payload: owned input/plan, native
    # model fields, indices, decoded result, native vectors and loop temporaries.
    # Counts numbers at eight bytes, including integer indices; not a claim
    # about interpreter object/header overhead, GC, OS, or the WASM runtime.
    base_numbers = (count * 96 + element_count * 96 + len(data['materials']) * 12
                    + len(data['nodalLoads']) * 8 + len(data['surfaceLoads']) * 14 + 4096)
    if base_numbers * 8 > budget:
        raise ValueError('solid-budget: input/native/result numeric reservation exceeded')
    if len(plan['forcesN']) != count or len(plan['fixed']) != count:
        raise ValueError('solid-input: inconsistent node fields')
    forces = [[_finite(v) for v in row] for row in plan['forcesN']]
    if any(len(row) != 3 for row in forces) or any(len(row) != 3 or any(type(v) is not bool for v in row)
                                                  for row in plan['fixed']):
        raise ValueError('solid-input: exactly three translations required')
    with open('/pcad_fem/solid.in', 'w', encoding='utf-8') as stream:
        stream.write(_deck(plan))
    problem = None
    primary = None
    try:
        problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader('/pcad_fem/solid.in'),
                                        fem.problemMode.processor, 0, None, False)
        if problem is None or problem.checkProblemConsistency() != 1:
            raise ValueError('solid-native: inconsistent native model')
        # TXT instantiation already postInitialize'd the exact native model.
        # Explicit sparse solve does not start EngngModel's solveYourself timer.
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        problem.init()
        step = problem.giveNextStep()
        problem.forceEquationNumbering()
        domain = problem.giveDomain(1)
        numbering = fem.EModelDefaultEquationNumbering()
        equations = int(problem.giveNumberOfDomainEquations(1, numbering))
        if not 0 <= equations <= count * 3:
            raise ValueError('solid-native: invalid equation count')
        ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
        node_equations = [[int(numbering.giveDofEquationNumber(domain.giveDofManager(i + 1).giveDofWithID(dof)))
                           for dof in ids] for i in range(count)]
        observed = []
        for i, row in enumerate(node_equations):
            for axis, equation in enumerate(row):
                if (plan['fixed'][i][axis] and equation != 0) or (not plan['fixed'][i][axis] and not 1 <= equation <= equations):
                    raise ValueError('solid-native: restraint/numbering mismatch')
                if equation:
                    observed.append(equation)
        if sorted(observed) != list(range(1, equations + 1)):
            raise ValueError('solid-native: non-bijective equation numbering')
        # Exact skyline profile, same algorithm as skyline.C::buildInternalStructure.
        # No native global matrix exists before this check; no speculative dense allocation.
        minima = list(range(1, equations + 1))
        for element in data['elements']:
            location = [eq for node in element['nodes'] for eq in node_equations[node] if eq]
            if location:
                first = min(location)
                for eq in location:
                    minima[eq - 1] = min(minima[eq - 1], first)
        skyline_numbers = 0 if equations == 0 else 1 + sum(i + 1 - start + 1 for i, start in enumerate(minima))
        reserved = (base_numbers + skyline_numbers + 4 * (equations + 1)) * 8
        if reserved > budget:
            raise ValueError('solid-budget: actual native skyline profile exceeds reservation')
        diagonal = [0.0] * equations
        expected_mask = [int(dof) for dof in ids]
        for i, row in enumerate(data['elements']):
            element = domain.giveElement(i + 1)
            mask = fem.IntArray()
            element.giveDofManDofIDMask(1, mask)
            if list(mask) != expected_mask:
                raise ValueError('solid-native: unexpected tet4 DOF order')
            for local, node in enumerate(row['nodes'], 1):
                if element.giveDofManagerNumber(local) != node + 1:
                    raise ValueError('solid-native: element/node association changed')
            _, values = _native_matrix(fem, element, step)
            location = [eq for node in row['nodes'] for eq in node_equations[node]]
            for local, eq in enumerate(location):
                if eq:
                    diagonal[eq - 1] += values[local][local]
        if any(not math.isfinite(v) or v <= 0 for v in diagonal):
            raise ValueError('solid-mechanism: nonpositive restrained diagonal')
        scaling = [1 / math.sqrt(v) for v in diagonal]
        displacement = [[0.0, 0.0, 0.0] for _ in range(count)]
        minimum_pivot = 1.0
        if equations:
            matrix = fem.skyline()
            matrix.buildInternalStructure(problem, 1, numbering)
            if matrix.giveNumberOfRows() != equations:
                raise ValueError('solid-native: matrix extent mismatch')
            for i, row in enumerate(data['elements']):
                element = domain.giveElement(i + 1)
                native, values = _native_matrix(fem, element, step)
                location = fem.IntArray()
                element.giveLocationArray(location, numbering, None)
                expected = [eq for node in row['nodes'] for eq in node_equations[node]]
                if list(location) != expected:
                    raise ValueError('solid-native: native location differs from reserved profile')
                for a, eq_a in enumerate(expected):
                    for b, eq_b in enumerate(expected):
                        native[a, b] = values[a][b] * (scaling[eq_a - 1] if eq_a else 0) * (scaling[eq_b - 1] if eq_b else 0)
                matrix.assemble(location, native)
            rhs = [0.0] * equations
            for node, row in enumerate(node_equations):
                for axis, eq in enumerate(row):
                    if eq:
                        rhs[eq - 1] = _finite(forces[node][axis] * scaling[eq - 1])
            right, solved = fem.FloatArray(tuple(rhs)), fem.FloatArray()
            solver = fem.ldltfactorization(domain, problem)
            reason = solver.solve(matrix, right, solved)
            if reason != fem.ConvergedReason.CR_CONVERGED or len(list(solved)) != equations:
                raise ValueError('solid-native: sparse solve failed')
            # at is 1-based and returns the actual storage slot. AFTER solve,
            # Skyline::factorized has overwritten diagonal slots with D pivots.
            pivots = [_finite(matrix.at(i, i)) for i in range(1, equations + 1)]
            minimum_pivot = min(pivots)
            if minimum_pivot <= 1e-12 or max(pivots) > 1 + 1e-10:
                raise ValueError('solid-mechanism: nonpositive or numerically unresolved scaled LDL pivot')
            for node, row in enumerate(node_equations):
                for axis, eq in enumerate(row):
                    if eq:
                        displacement[node][axis] = _finite(float(solved[eq - 1]) * scaling[eq - 1])
        internal = [[0.0, 0.0, 0.0] for _ in range(count)]
        actions = []
        # Re-evaluate original native element K, never multiply by factorized K.
        for i, row in enumerate(data['elements']):
            _, stiffness = _native_matrix(fem, domain.giveElement(i + 1), step)
            local_u = [v for node in row['nodes'] for v in displacement[node]]
            force = [_finite(math.fsum(k * u for k, u in zip(values, local_u, strict=True))) for values in stiffness]
            actions.append(force)
            for local, node in enumerate(row['nodes']):
                for axis in range(3):
                    internal[node][axis] = _finite(internal[node][axis] + force[3 * local + axis])
        load_scale = max(1e-300, max(abs(v) for row in forces for v in row), max(abs(v) for row in internal for v in row))
        residual = max((abs(internal[node][axis] - forces[node][axis]) / load_scale
                        for node in range(count) for axis in range(3) if not plan['fixed'][node][axis]), default=0.0)
        if not math.isfinite(residual) or residual > 1e-8:
            raise ValueError('solid-equilibrium: native sparse residual exceeds 1e-8')
        return json.dumps({'schema': 'pointercad-solid-tet4-native/1', 'source': data['source'],
                           'displacementMm': displacement, 'elementForcesN': actions,
                           'reservedNumericBytes': reserved, 'minimumScaledPivot': minimum_pivot}, allow_nan=False)
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
