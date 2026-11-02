"""Independent P1 contact integrals, energy derivatives and native mapping guards."""

import copy
import json
import math
import unittest

from solidContact import contactEquationMap, contactResidualAndTangent


MASTER = [(0, 0, 0), (2, 0, 0), (0, 2, 0)]
SLAVE = [(0, 0, 3), (2, 0, 3), (0, 2, 3)]
NORMAL = (0, 0, 1)


def norm(values):
    return math.hypot(*values)


def rotate(vector):
    angle = math.radians(37)
    c, s = math.cos(angle), math.sin(angle)
    x, y, z = vector
    return (c * x + s * z, y, -s * x + c * z)


def cross(left, right):
    return [left[1] * right[2] - left[2] * right[1],
            left[2] * right[0] - left[0] * right[2],
            left[0] * right[1] - left[1] * right[0]]


class ContactIntegrals(unittest.TestCase):
    def standard(self, **changes):
        args = dict(master=MASTER, slave=SLAVE, normal=NORMAL,
                    initialGapMm=-5e-7, knNPerMm3=1e6)
        args.update(changes)
        return contactResidualAndTangent(**args)

    def test_exact_area_pressure_resultant_and_nodal_forces(self):
        result = self.standard()
        self.assertEqual(result['areaMm2'], 2)
        self.assertEqual(result['closedAreaMm2'], 2)
        self.assertAlmostEqual(result['compressiveResultantN'], 1, places=14)
        self.assertAlmostEqual(result['energyNmm'], 2.5e-7, places=20)
        self.assertEqual(result['vertexGapsMm'], [-5e-7] * 3)
        self.assertLessEqual(5e-7, 1e-6 * 2)
        for point in result['integrationPoints']:
            self.assertAlmostEqual(point['pressureMPa'], .5, places=14)
        for node in range(6):
            self.assertEqual(result['residualN'][3 * node:3 * node + 2], [0, 0])
            self.assertAlmostEqual(result['residualN'][3 * node + 2], (1 if node < 3 else -1) / 3, places=14)
        print('W18-A exact contact ' + json.dumps({'areaMm2': result['areaMm2'],
              'resultantN': result['compressiveResultantN'], 'expectedN': 1,
              'penetrationMm': 5e-7, 'penetrationLimitMm': 2e-6}))

    def test_exact_p1_mass_integrals_in_all_four_blocks(self):
        result = self.standard()
        for left in range(6):
            for right in range(6):
                # Integral Ni*Nj = A/6 on diagonal, A/12 off diagonal.
                expected = 1e6 * 2 / (6 if left % 3 == right % 3 else 12)
                expected *= 1 if (left < 3) == (right < 3) else -1
                self.assertAlmostEqual(result['tangentNPerMm'][3 * left + 2][3 * right + 2] / expected, 1, places=14)

    def test_open_and_zero_gap_have_zero_force_energy_and_open_side_tangent(self):
        for gap in (1e-3, 0):
            with self.subTest(gap=gap):
                result = self.standard(initialGapMm=gap)
                self.assertEqual(result['residualN'], [0] * 18)
                self.assertEqual(result['tangentNPerMm'], [[0] * 18 for _ in range(18)])
                self.assertEqual(result['energyNmm'], 0)
                self.assertEqual(result['integrationPoints'], [])
                self.assertEqual(result['zeroGapPolicy'], 'open-side-zero-tangent')

    def test_declared_gap_is_not_added_to_reference_distance(self):
        coincident = self.standard(slave=MASTER)
        separated = self.standard()
        self.assertEqual(coincident, separated)

    def test_37_degree_rotation_preserves_force_moment_and_tangent(self):
        master = [rotate(point) for point in MASTER]
        slave = [rotate(point) for point in SLAVE]
        direction = rotate(NORMAL)
        result = self.standard(master=master, slave=slave, normal=direction)
        forces = [result['residualN'][3 * node:3 * node + 3] for node in range(6)]
        total = [math.fsum(force[axis] for force in forces) for axis in range(3)]
        moments = [cross(point, force) for point, force in zip(master + slave, forces)]
        moment = [math.fsum(row[axis] for row in moments) for axis in range(3)]
        self.assertLessEqual(norm(total), 1e-8)
        self.assertLessEqual(norm(moment), 1e-8)
        self.assertAlmostEqual(result['compressiveResultantN'], 1, places=13)
        for axis in range(3):
            self.assertAlmostEqual(forces[0][axis], direction[axis] / 3, places=13)
        for i in range(3):
            for j in range(3):
                self.assertAlmostEqual(result['tangentNPerMm'][i][j] / 1e6,
                                       (2 / 6) * direction[i] * direction[j], places=13)
        print('W18-A rotated equilibrium ' + json.dumps({'degrees': 37,
              'forceResidualN': norm(total), 'momentResidualNmm': norm(moment), 'limit': 1e-8}))

    def test_central_difference_of_residual_matches_tangent_in_closed_region(self):
        displacement = [(index - 8) * 1e-4 for index in range(18)]
        result = self.standard(initialGapMm=-.1, knNPerMm3=1000, displacementMm=displacement)
        h, differences, expected = 1e-7, [], []
        for column in range(18):
            plus, minus = displacement.copy(), displacement.copy()
            plus[column] += h
            minus[column] -= h
            positive = self.standard(initialGapMm=-.1, knNPerMm3=1000, displacementMm=plus)
            negative = self.standard(initialGapMm=-.1, knNPerMm3=1000, displacementMm=minus)
            self.assertTrue(all(gap < 0 for gap in positive['vertexGapsMm'] + negative['vertexGapsMm']))
            for row in range(18):
                derivative = (positive['residualN'][row] - negative['residualN'][row]) / (2 * h)
                target = result['tangentNPerMm'][row][column]
                differences.append(derivative - target)
                expected.append(target)
        relative = norm(differences) / norm(expected)
        self.assertLessEqual(relative, 1e-5)
        print('W18-A tangent finite difference ' + json.dumps({'relative': relative, 'limit': 1e-5}))

    def test_energy_gradient_has_the_internal_residual_sign(self):
        displacement = [0.0] * 18
        result = self.standard(initialGapMm=-.1, knNPerMm3=1000)
        for column in (2, 5, 8, 11, 14, 17):
            h = 1e-7
            displacement[column] = h
            plus = self.standard(initialGapMm=-.1, knNPerMm3=1000, displacementMm=displacement)
            displacement[column] = -h
            minus = self.standard(initialGapMm=-.1, knNPerMm3=1000, displacementMm=displacement)
            displacement[column] = 0
            derivative = (plus['energyNmm'] - minus['energyNmm']) / (2 * h)
            self.assertLessEqual(abs(derivative - result['residualN'][column]) / abs(derivative), 1e-5)

    def test_partial_contact_uses_exact_clipped_triangle_integrals(self):
        displacement = [0.0] * 18
        displacement[11], displacement[14], displacement[17] = -1, 1, 1
        result = self.standard(initialGapMm=0, knNPerMm3=1, displacementMm=displacement)
        self.assertAlmostEqual(result['closedAreaMm2'], .5, places=14)
        self.assertAlmostEqual(result['compressiveResultantN'], 1 / 6, places=14)
        self.assertAlmostEqual(result['energyNmm'], 1 / 24, places=14)
        self.assertAlmostEqual(result['tangentNPerMm'][11][11], 11 / 48, places=14)
        self.assertAlmostEqual(result['residualN'][11], -1 / 8, places=14)
        self.assertAlmostEqual(result['residualN'][14], -1 / 48, places=14)

    def test_partial_quadrilateral_and_zero_edge_do_not_double_count(self):
        displacement = [0.0] * 18
        displacement[11], displacement[14], displacement[17] = -1, -1, 1
        result = self.standard(initialGapMm=0, knNPerMm3=1, displacementMm=displacement)
        self.assertAlmostEqual(result['closedAreaMm2'], 1.5, places=14)
        displacement[11], displacement[14], displacement[17] = -1, 0, 0
        result = self.standard(initialGapMm=0, knNPerMm3=1, displacementMm=displacement)
        self.assertAlmostEqual(result['closedAreaMm2'], 2, places=14)
        self.assertAlmostEqual(result['compressiveResultantN'], 2 / 3, places=14)

    def test_rigid_translation_has_no_contact_stiffness(self):
        displacement = [4, -3, 2] * 6
        result = self.standard(displacementMm=displacement)
        self.assertAlmostEqual(result['compressiveResultantN'], 1, places=9)
        for axis in range(3):
            for row in result['tangentNPerMm']:
                self.assertAlmostEqual(math.fsum(row[axis::3]) / 1e6, 0, places=14)

    def test_inputs_are_not_mutated(self):
        args = [copy.deepcopy(MASTER), copy.deepcopy(SLAVE), [0, 0, 1], [0] * 18]
        before = copy.deepcopy(args)
        self.standard(master=args[0], slave=args[1], normal=args[2], displacementMm=args[3])
        self.assertEqual(args, before)

    def test_thin_representable_triangle_does_not_lose_area_by_squaring(self):
        thin = [(0, 0, 0), (1, 0, 0), (0, 1e-170, 0)]
        result = self.standard(master=thin, slave=thin, knNPerMm3=1e170, initialGapMm=-1)
        self.assertEqual(result['areaMm2'], 5e-171)
        self.assertAlmostEqual(result['compressiveResultantN'], .5, places=14)

    def test_outside_master_patch_is_explicitly_refused(self):
        outside = [(point[0] + .1, point[1], point[2]) for point in SLAVE]
        with self.assertRaisesRegex(ValueError, 'outside master patch'):
            self.standard(slave=outside)

    def test_invalid_normals_are_refused(self):
        for normal in ((0, 0, 0), (0, 0, 2), (1, 0, 0), (0, float('nan'), 1), [0, 1]):
            with self.subTest(normal=normal), self.assertRaises(ValueError):
                self.standard(normal=normal)

    def test_degenerate_and_unrepresentable_areas_are_refused(self):
        for points in ([(0, 0, 0)] * 3, [(0, 0, 0), (1, 0, 0), (2, 0, 0)],
                       [(0, 0, 0), (1e-200, 0, 0), (0, 1e-200, 0)],
                       [(0, 0, 0), (1e200, 0, 0), (0, 1e200, 0)]):
            with self.subTest(points=points), self.assertRaises(ValueError):
                self.standard(master=points, slave=points)

    def test_nonparallel_reference_facets_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'parallel reference'):
            self.standard(slave=[(0, 0, 3), (2, 0, 3), (0, 2, 4)])

    def test_invalid_numbers_and_penalties_are_refused(self):
        for value in (float('nan'), float('inf'), True, '1', 10 ** 1000):
            with self.subTest(field='gap', value=repr(value)[:20]), self.assertRaises(ValueError):
                self.standard(initialGapMm=value)
        for penalty in (0, -1, float('inf'), True):
            with self.subTest(penalty=penalty), self.assertRaises(ValueError):
                self.standard(knNPerMm3=penalty)
        with self.assertRaises(ValueError):
            self.standard(displacementMm=[0] * 17)
        with self.assertRaises(ValueError):
            self.standard(displacementMm=[float('nan')] * 18)
        with self.assertRaisesRegex(ValueError, 'not representable'):
            self.standard(initialGapMm=-1e-300, knNPerMm3=1e-300)


class FakeFem:
    class DofIDItem:
        D_u, D_v, D_w = range(3)


class FakeManager:
    def __init__(self, row):
        self.row = row

    def giveDofWithID(self, axis):
        return self.row[axis]


class FakeDomain:
    def __init__(self, rows):
        self.rows = rows

    def giveDofManager(self, number):
        return FakeManager(self.rows[number])


class FakeNumbering:
    def giveDofEquationNumber(self, value):
        return value


class MappingGuards(unittest.TestCase):
    def setUp(self):
        self.rows = {9: [0, 0, 0], 2: [1, 2, 3], 7: [4, 5, 6], 1: [7, 8, 9],
                     8: [10, 11, 12], 4: [13, 14, 15]}
        self.bodies = {'master': [{'nativeNode': node, 'fixed': [node == 9] * 3} for node in (9, 2, 7)],
                       'slave': [{'nativeNode': node, 'fixed': [False] * 3} for node in (1, 8, 4)]}
        self.references = [(body, node) for body in ('master', 'slave') for node in range(3)]

    def mapped(self, **changes):
        args = dict(fem=FakeFem, domain=FakeDomain(self.rows), numbering=FakeNumbering(),
                    bodyNodes=self.bodies, contactNodes=self.references, equationCount=15)
        args.update(changes)
        return contactEquationMap(**args)

    def test_body_local_identity_and_actual_native_order_are_preserved(self):
        before = copy.deepcopy(self.bodies)
        self.assertEqual(self.mapped(), [0, 0, 0] + list(range(1, 16)))
        self.assertEqual(self.bodies, before)

    def test_missing_body_or_node_and_wrong_reference_count_are_refused(self):
        for reference in (('unknown', 0), ('slave', 3), ('slave', -1), ('slave', True)):
            with self.subTest(reference=reference), self.assertRaisesRegex(ValueError, 'body-local'):
                self.mapped(contactNodes=[reference] + self.references[1:])
        with self.assertRaises(ValueError):
            self.mapped(contactNodes=self.references[:5])

    def test_alias_native_node_and_alias_free_equation_are_refused(self):
        self.bodies['slave'][0]['nativeNode'] = 9
        with self.assertRaisesRegex(ValueError, 'unique'):
            self.mapped()
        self.bodies['slave'][0]['nativeNode'] = 1
        self.rows[1][0] = 1
        with self.assertRaisesRegex(ValueError, 'alias'):
            self.mapped()

    def test_zero_equation_requires_actual_restraint_and_cannot_index_minus_one(self):
        self.rows[1][0] = 0
        with self.assertRaisesRegex(ValueError, 'restraint'):
            self.mapped()
        self.rows[1][0] = 7
        self.rows[9][0] = 16
        with self.assertRaisesRegex(ValueError, 'range'):
            self.mapped()

    def test_invalid_map_numeric_flags_and_missing_native_node_are_refused(self):
        with self.assertRaises(ValueError):
            self.mapped(equationCount=True)
        self.bodies['master'][0]['fixed'] = [1, 1, 1]
        with self.assertRaisesRegex(ValueError, 'restraint flags'):
            self.mapped()
        self.bodies['master'][0]['fixed'] = [True] * 3
        self.bodies['master'][0]['nativeNode'] = 99
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.mapped()


def packaged_native_parallel_bar():
    """Real packaged OOFEM matrices, numbering, assembly and LDLT solve.

    A 100 x 10 x 20 mm elastic bar meets a fully fixed second body at x=100.
    Both bodies have actual tetrahedra/DOFs; no fictitious constrained equation
    is invented for the contact master. The slave end moves in +x into the
    stop, so its master-to-slave outward normal is -x and g=-u. The two face
    triangles already fit the volume skyline graph in this bounded fixture;
    this does not exercise a general cross-body profile extension.
    """
    from importlib.metadata import version
    import oofem as fem
    import solidAnalysis as boundary

    if version('oofem') != '3.1.dev5+g214b161ed':
        raise ValueError('native contact fixture: unexpected packaged version')
    nodes = [(x, y, z) for pair in ((0, 100), (100, 101))
             for x in pair for y in (0, 10) for z in (0, 20)]
    pattern = ((0, 4, 6, 7), (0, 6, 2, 7), (0, 2, 3, 7),
               (0, 3, 1, 7), (0, 1, 5, 7), (0, 5, 4, 7))
    elements = [{'materialId': 'm', 'nodes': [node + offset for node in tet]}
                for offset in (0, 8) for tet in pattern]
    fixed = [[node < 4 or node >= 8] * 3 for node in range(16)]
    plan = {'input': {'nodes': nodes, 'elements': elements,
                     'materials': [{'id': 'm', 'youngMPa': 210000, 'poisson': 0}]},
            'fixed': fixed}
    # Deliberately permute original nodes. Actual element connectivity and
    # numbering are checked, so no test can pass by assuming local == native.
    order = list(reversed(range(16)))
    native_numbers = [0] * 16
    for native, original in enumerate(order, 1):
        native_numbers[original] = native
    with open('/pcad_fem/contact-bar.in', 'w', encoding='utf-8') as stream:
        stream.write(boundary._deck(plan, order, native_numbers))
    problem = None
    primary = None
    try:
        problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader('/pcad_fem/contact-bar.in'),
                                        fem.problemMode.processor, 0, None, False)
        if problem is None or problem.checkProblemConsistency() != 1:
            raise ValueError('native contact fixture: inconsistent native model')
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        problem.init()
        step = problem.giveNextStep()
        problem.forceEquationNumbering()
        domain = problem.giveDomain(1)
        numbering = fem.EModelDefaultEquationNumbering()
        equation_count = int(problem.giveNumberOfDomainEquations(1, numbering))
        if equation_count != 12:
            raise ValueError('native contact fixture: expected twelve real free equations')
        body_nodes = {body: [{'nativeNode': native_numbers[offset + i], 'fixed': fixed[offset + i]}
                             for i in range(8)] for body, offset in (('bar', 0), ('stop', 8))}
        dofs = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
        node_equations = [[int(numbering.giveDofEquationNumber(
            domain.giveDofManager(native_numbers[node]).giveDofWithID(dof))) for dof in dofs]
            for node in range(16)]
        matrix = fem.skyline()
        matrix.buildInternalStructure(problem, 1, numbering)
        native_elements = []
        for index, entry in enumerate(elements, 1):
            element = domain.giveElement(index)
            mask = fem.IntArray()
            element.giveDofManDofIDMask(1, mask)
            if list(mask) != [int(dof) for dof in dofs]:
                raise ValueError('native contact fixture: native DOF order differs')
            if any(element.giveDofManagerNumber(local) != native_numbers[node]
                   for local, node in enumerate(entry['nodes'], 1)):
                raise ValueError('native contact fixture: original/native node map differs')
            native, values = boundary._native_matrix(fem, element, step)
            location = fem.IntArray()
            element.giveLocationArray(location, numbering, None)
            expected = [eq for node in entry['nodes'] for eq in node_equations[node]]
            if list(location) != expected:
                raise ValueError('native contact fixture: element location differs')
            matrix.assemble(location, native)
            native_elements.append((entry['nodes'], values))
        contacts = []
        external = [[0.0] * 3 for _ in range(16)]
        stiffness_contact = 0.0
        for slave_local, master_local in (((4, 6, 7), (0, 2, 3)), ((4, 7, 5), (0, 3, 1))):
            slave_points = [nodes[node] for node in slave_local]
            master_points = [nodes[8 + node] for node in master_local]
            references = [('stop', node) for node in master_local] + [('bar', node) for node in slave_local]
            location = contactEquationMap(fem, domain, numbering, body_nodes, references, equation_count)
            if location[:9] != [0] * 9 or any(value <= 0 for value in location[9:]):
                raise ValueError('native contact fixture: constrained/free contact map differs')
            trial = [0.0] * 9 + [1e-8, 0.0, 0.0] * 3
            local = contactResidualAndTangent(master_points, slave_points, (-1, 0, 0), 0, 10000, trial)
            native = fem.FloatMatrix(18, 18)
            for i in range(18):
                for j in range(18):
                    native[i, j] = local['tangentNPerMm'][i][j]
            matrix.assemble(fem.IntArray(tuple(location)), native)
            stiffness_contact += math.fsum(local['tangentNPerMm'][i][j]
                                           for i in (9, 12, 15) for j in (9, 12, 15))
            # Independent uniform 1 N / 200 mm^2 pressure: each 100 mm^2
            # triangle contributes pressure*A/3 to each of its three nodes.
            for node in slave_local:
                external[node][0] += (1 / 200) * (10 * 20 / 2) / 3
            contacts.append((master_points, slave_points, master_local, slave_local, location))
        rhs = [0.0] * equation_count
        for node, row in enumerate(node_equations):
            for axis, equation in enumerate(row):
                if equation:
                    rhs[equation - 1] += external[node][axis]
        solved = fem.FloatArray()
        reason = fem.ldltfactorization(domain, problem).solve(matrix, fem.FloatArray(tuple(rhs)), solved)
        if reason != fem.ConvergedReason.CR_CONVERGED or len(list(solved)) != equation_count:
            raise ValueError('native contact fixture: native solve failed')
        pivots = [float(matrix.at(index, index)) for index in range(1, equation_count + 1)]
        if any(not math.isfinite(value) or value <= 0 for value in pivots):
            raise ValueError('native contact fixture: native factorization has nonpositive pivot')
        displacement = [[float(solved[equation - 1]) if equation else 0.0 for equation in row]
                        for row in node_equations]
        internal = [[0.0] * 3 for _ in range(16)]
        unit_internal = [[0.0] * 3 for _ in range(16)]
        for connectivity, values in native_elements:
            local_u = [value for node in connectivity for value in displacement[node]]
            unit_u = [1.0 if 4 <= node < 8 and axis == 0 else 0.0
                      for node in connectivity for axis in range(3)]
            for i, row in enumerate(values):
                node, axis = connectivity[i // 3], i % 3
                internal[node][axis] += math.fsum(k * u for k, u in zip(row, local_u))
                unit_internal[node][axis] += math.fsum(k * u for k, u in zip(row, unit_u))
        stiffness_bar = math.fsum(unit_internal[node][0] for node in range(4, 8))
        max_penetration, total_pressure_force = 0.0, 0.0
        for master, slave, master_local, slave_local, _ in contacts:
            original = [8 + node for node in master_local] + list(slave_local)
            local_u = [value for node in original for value in displacement[node]]
            local = contactResidualAndTangent(master, slave, (-1, 0, 0), 0, 10000, local_u)
            if not all(gap < 0 for gap in local['vertexGapsMm']):
                raise ValueError('native contact fixture: solution left the assumed closed branch')
            max_penetration = max(max_penetration, -min(local['vertexGapsMm']))
            total_pressure_force += local['compressiveResultantN']
            for i, value in enumerate(local['residualN']):
                internal[original[i // 3]][i % 3] += value
        free_residual = max(abs(internal[node][axis] - external[node][axis])
                            for node in range(16) for axis in range(3) if not fixed[node][axis])
        reactions = [[internal[node][axis] - external[node][axis] if fixed[node][axis] else 0.0
                      for axis in range(3)] for node in range(16)]
        balanced = [[reaction[axis] + external[node][axis] for axis in range(3)]
                    for node, reaction in enumerate(reactions)]
        force = [math.fsum(row[axis] for row in balanced) for axis in range(3)]
        moments = [cross(point, load) for point, load in zip(nodes, balanced)]
        moment = [math.fsum(row[axis] for row in moments) for axis in range(3)]
        expected = 1 / (210000 * 200 / 100 + 10000 * 200)
        actual = [displacement[node][0] for node in range(4, 8)]
        return {'nativeVersion': version('oofem'), 'nativeElementMatrices': len(native_elements),
                'nativeFreeEquations': equation_count, 'nativeReordered': native_numbers != list(range(1, 17)),
                'nativeSolver': 'skyline/LDLT', 'barStiffnessNPerMm': stiffness_bar,
                'contactStiffnessNPerMm': stiffness_contact, 'expectedDisplacementMm': expected,
                'actualDisplacementMm': actual, 'maximumRelativeDisplacementError': max(abs(u - expected) / expected for u in actual),
                'penetrationMm': max_penetration, 'penetrationLimitMm': 1e-6 * 10,
                'freeResidualN': free_residual, 'forceResidualN': norm(force), 'momentResidualNmm': norm(moment),
                'compressiveResultantN': total_pressure_force,
                'expectedContactResultantN': (10000 * 200) * expected,
                'minimumPositiveNativePivot': min(pivots)}
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


if __name__ == '__main__':
    unittest.main()
