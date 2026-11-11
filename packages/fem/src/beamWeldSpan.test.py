"""Pure independent SI contracts, not native OOFEM executions or a solver oracle."""
import copy
import unittest
from beamWeldSpan import WeldSpanKernel, beam_span_shape


def fixture():
    return {'mesh': {'originalNodeCount': 4,
        'nodes': [{'number': i+1, 'positionM': [x, 0., 0.], 'restrained': [False]*6, 'load': [0.]*6}
                  for i, x in enumerate((0., 2., 0., 2.))],
        'members': [{'number': i+1, 'id': name, 'componentId': name, 'occurrencePath': [name],
                     'nodes': [i*2+1, i*2+2], 'material': 1, 'section': 1,
                     'frame': {'x': [1., 0., 0.], 'y': [0., 1., 0.], 'z': [0., 0., 1.], 'lengthM': 2.}}
                    for i, name in enumerate(('a', 'b'))],
        'materials': [{'number': 1, 'youngPa': 1000., 'poisson': .25, 'densityKgM3': 1.}],
        'sections': [{'number': 1, 'areaM2': 1., 'iyM4': .1, 'izM4': .1, 'torsionM4': .1, 'shearFactor': 1.}]},
        'patches': [{'id': 'physical-bead', 'first': {'kind': 'span', 'memberId': 'a'},
                     'second': {'kind': 'span', 'memberId': 'b'}, 'centerM': [1., 0., 0.],
                     'normal': [0., 1., 0.], 'along': [1., 0., 0.], 'widthM': 2., 'lengthM': 1.,
                     'thicknessM': .2, 'youngPa': 1000., 'poisson': .25}]}


def motions(p, field):
    return [field(n['positionM'], i) for i, n in enumerate(p['mesh']['nodes'])]


class WeldSpanTests(unittest.TestCase):
    def close(self, actual, expected, scale=None):
        self.assertLessEqual(abs(actual-expected), 1e-9*max(abs(expected) if scale is None else scale, 1e-30))

    def test_endpoint_and_timoshenko_shear_closed_form_in_both_planes(self):
        for xi in (0., 1.):
            n = beam_span_shape(2., 3/8, 3/8, xi)
            for i, row in enumerate(n):
                for j, v in enumerate(row):
                    self.assertEqual(v, float(j == i+6*xi))
        n = beam_span_shape(2., 3/8, 3/8, .25)
        q = [0.]*6+[0., 19/6000, 0., 0., 0., 1/500]
        result = [sum(a*b for a, b in zip(row, q, strict=True)) for row in n]
        self.close(result[1], 17/48000)
        self.close(result[5], 7/8000)
        q = [0.]*6+[0., 0., 19/6000, 0., -1/500, 0.]
        result = [sum(a*b for a, b in zip(row, q, strict=True)) for row in n]
        self.close(result[2], 17/48000)
        self.close(result[4], -7/8000)

    def test_normal_translation_independent_force_and_energy_input_immutable(self):
        p = fixture()
        before = copy.deepcopy(p)
        result = WeldSpanKernel(p).evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [0., .001, 0., 0., 0., 0.]))[0]
        self.close(result['forceOnFirstN'][1], 10.)
        self.close(result['energyJ'], 1/200)
        self.close(sum(row[1] for row in result['second']), -10.)
        self.assertFalse(result['structuralCertification'])
        self.assertEqual(p, before)

    def test_slip_and_axial_strain_closed_integrals(self):
        p = fixture()
        k = WeldSpanKernel(p)
        a = k.evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [.001, 0., 0., 0., 0., 0.]))[0]
        self.close(a['forceOnFirstN'][0], 4.)
        self.close(a['energyJ'], 1/500)
        b = k.evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [.001*x[0], 0., 0., 0., 0., 0.]))[0]
        self.close(b['forceOnFirstN'][0], 4.)
        self.close(b['energyJ'], 1/375)

    def test_pure_bending_sixth_degree_energy_integral(self):
        p = fixture()
        r = WeldSpanKernel(p).evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [0., .0005*x[0]**2, 0., 0., 0., .001*x[0]]))[0]
        self.close(r['forceOnFirstN'][1], 20/3)
        self.close(r['momentAtCenterNm'][2]+r['forceOnFirstN'][1], 10.)
        self.close(r['energyJ'], 1/250)

    def test_torsion_field_and_zero_force(self):
        p = fixture()
        r = WeldSpanKernel(p).evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [0., 0., 0., .001, 0., 0.]))[0]
        self.close(r['forceOnFirstN'][1], 0., 1.)
        self.close(r['momentAtCenterNm'][0], 5/6)
        self.close(r['energyJ'], 1/2400)

    def test_eccentric_adjoint_is_not_equal_force_rigid_split(self):
        p = fixture()
        p['patches'][0]['centerM'] = [1., .2, 0.]
        r = WeldSpanKernel(p).evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [.001, 0., 0., 0., 0., 0.]))[0]
        for row in r['first'][:2]:
            self.close(row[0], 2.)
            self.close(row[5], -6/35)
        self.close(r['first'][0][1], 8/35)
        self.close(r['first'][1][1], -8/35)
        self.close(2*r['first'][1][1]+sum(row[5] for row in r['first']), -4/5)

    def test_common_arbitrary_rigid_motion_has_no_energy_or_force(self):
        p = fixture()
        p['patches'][0]['centerM'] = [1., .2, 0.]
        field = lambda x, i: [.003+.002*x[2]+.004*x[1], -.001-.004*x[0]-.003*x[2], .005+.003*x[1]-.002*x[0], .003, .002, -.004]
        r = WeldSpanKernel(p).evaluate(motions(p, field))[0]
        self.assertLess(r['energyJ'], 1e-25)
        for v in r['forceOnFirstN']:
            self.close(v, 0., 1e-4)

    def test_sign_side_exchange_zero_and_world_frame_transform(self):
        p = fixture()
        q = motions(p, lambda x, i: [0.]*6 if i < 2 else [.001, .002, -.001, 0., 0., 0.])
        k = WeldSpanKernel(p)
        a, b = k.evaluate(q)[0], k.evaluate([[-v for v in row] for row in q])[0]
        self.close(a['energyJ'], b['energyJ'])
        for av, bv in zip(a['forceOnFirstN'], b['forceOnFirstN'], strict=True):
            self.close(av, -bv)
        swapped = copy.deepcopy(p)
        w = swapped['patches'][0]
        w['first'], w['second'] = w['second'], w['first']
        c = WeldSpanKernel(swapped).evaluate(q)[0]
        self.close(c['energyJ'], a['energyJ'])
        self.close(c['forceOnFirstN'][1], -a['forceOnFirstN'][1])
        self.assertEqual(k.evaluate([[0.]*6 for _ in q])[0]['energyJ'], 0.)
        rotate = lambda v: [v[2], v[0], v[1]]
        transformed = copy.deepcopy(p)
        for node in transformed['mesh']['nodes']:
            x = node['positionM']
            node['positionM'] = rotate([x[0]+3, x[1]-2, x[2]+5])
        for e in transformed['mesh']['members']:
            for axis in 'xyz':
                e['frame'][axis] = rotate(e['frame'][axis])
        w = transformed['patches'][0]
        w['centerM'], w['normal'], w['along'] = rotate([4., -2., 5.]), rotate(w['normal']), rotate(w['along'])
        rotated_q = [rotate(row[:3])+rotate(row[3:]) for row in q]
        c = WeldSpanKernel(transformed).evaluate(rotated_q)[0]
        self.close(c['energyJ'], a['energyJ'])
        for actual, expected in zip(c['forceOnFirstN'], rotate(a['forceOnFirstN']), strict=True):
            self.close(actual, expected)

    def test_same_mesh_domain_partition_does_not_multiply_energy_or_initial_strain(self):
        p = fixture()
        q = motions(p, lambda x, i: [0.]*6 if i < 2 else [0., .0005*x[0]**2, 0., 0., 0., .001*x[0]])
        a, b = fixture(), fixture()
        a['patches'][0].update(widthM=.7, centerM=[.35, 0., 0.])
        b['patches'][0].update(widthM=1.3, centerM=[1.35, 0., 0.])
        self.close(WeldSpanKernel(a).evaluate(q)[0]['energyJ']+WeldSpanKernel(b).evaluate(q)[0]['energyJ'], 1/250)
        p['initialStrain'] = .001
        with self.assertRaises(ValueError):
            WeldSpanKernel(p)

    def test_union_of_boundaries_actual_internal_motion_and_missing_motion_refusal(self):
        p = fixture()
        mesh = p['mesh']
        mesh['nodes'] += [{'number': 5, 'positionM': [.7, 0., 0.], 'restrained': [False]*6, 'load': [0.]*6},
                          {'number': 6, 'positionM': [1.3, 0., 0.], 'restrained': [False]*6, 'load': [0.]*6}]
        a, b = mesh['members']
        mesh['members'] = []
        for i, (e, ends, length) in enumerate(((a, [1, 5], .7), (a, [5, 2], 1.3), (b, [3, 6], 1.3), (b, [6, 4], .7)), 1):
            row = copy.deepcopy(e)
            row.update(number=i, nodes=ends)
            row['frame']['lengthM'] = length
            mesh['members'].append(row)
        k = WeldSpanKernel(p)
        self.assertEqual(k.cell_counts, [3])
        with self.assertRaises(ValueError):
            k.evaluate([[0.]*6 for _ in range(4)])
        q = [[0.]*6 for _ in range(6)]
        q[5][1] = .001
        self.assertGreater(k.evaluate(q)[0]['energyJ'], 0.)
        q = motions(p, lambda x, i: [0., .001 if i in (2, 3, 5) else 0., 0., 0., 0., 0.])
        self.close(k.evaluate(q)[0]['energyJ'], 1/200)

    def test_stiffness_energy_virtual_work_and_global_balance(self):
        p = fixture()
        q = motions(p, lambda x, i: [i*.0001, x[0]*.0003, -.0004*i, .0002, -.0001*i, .0005])
        k = WeldSpanKernel(p)
        r = k.evaluate(q)[0]
        flat = [v for row in q for v in row]
        internal = [sum(v*x for v, x in zip(row, flat, strict=True)) for row in k.stiffness]
        self.close(sum(v*x for v, x in zip(flat, internal, strict=True))/2, r['energyJ'])
        for i, value in enumerate(internal):
            self.close(value, -r['first'][i//6][i % 6]-r['second'][i//6][i % 6], 20.)
        for i, row in enumerate(k.stiffness):
            for j, value in enumerate(row):
                self.close(value, k.stiffness[j][i], 1e5)
        for axis in range(3):
            self.close(sum(row[axis] for row in r['first']+r['second']), 0., 20.)
        moment = [0., 0., 0.]
        for node, a, b in zip(p['mesh']['nodes'], r['first'], r['second'], strict=True):
            x = node['positionM']
            f = [av+bv for av, bv in zip(a, b, strict=True)]
            moment[0] += f[3]+x[1]*f[2]-x[2]*f[1]
            moment[1] += f[4]+x[2]*f[0]-x[0]*f[2]
            moment[2] += f[5]+x[0]*f[1]-x[1]*f[0]
        for value in moment:
            self.close(value, 0., 20.)

    def test_section_node_snapshot_support_and_strict_input_failures(self):
        p = fixture()
        p['patches'][0]['first'] = {'kind': 'section', 'node': 1}
        k = WeldSpanKernel(p)
        p['patches'][0]['youngPa'] = 1.
        r = k.evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [0., .001, 0., 0., 0., 0.]))[0]
        self.close(r['first'][0][1], 10.)
        self.close(r['first'][0][5], 10.)
        changes = [lambda p: p['patches'][0].update(widthM=3.), lambda p: p['patches'][0].update(youngPa=float('nan')),
                   lambda p: p['patches'][0].update(poisson='0.25'), lambda p: p['patches'][0].update(first={'kind': 'span', 'memberId': 'missing'}),
                   lambda p: p['patches'][0].update(along=[0., 0., 1.]), lambda p: p.update(patches=p['patches']*65),
                   lambda p: p['mesh'].update(nodes=p['mesh']['nodes']*33), lambda p: p.update(patches=p['patches']*2),
                   lambda p: p['mesh']['members'][0].update(nodes=[1, 99]),
                   lambda p: p['mesh']['members'][0]['frame'].update(lengthM='2')]
        for change in changes:
            p = fixture()
            change(p)
            with self.assertRaises((ValueError, TypeError, KeyError)):
                WeldSpanKernel(p)
        p = fixture()
        p['patches'].append(dict(p['patches'][0], id='overlapping-physical-area'))
        with self.assertRaises(ValueError):
            WeldSpanKernel(p)
        p = fixture()
        p['mesh']['originalNodeCount'] = 2
        p['patches'][0]['first'] = {'kind': 'section', 'node': 3}
        with self.assertRaises(ValueError):
            WeldSpanKernel(p)
        p = fixture()
        a, b = p['mesh']['members']
        p['mesh']['members'] = [a, dict(a, number=2), dict(b, number=3)]
        with self.assertRaises(ValueError):
            WeldSpanKernel(p)
        p = fixture()
        p['mesh']['nodes'][0]['restrained'][0] = True
        k = WeldSpanKernel(p)
        with self.assertRaises(ValueError):
            k.evaluate([[.001, 0., 0., 0., 0., 0.]]*4)
        with self.assertRaises(ValueError):
            k.evaluate([[0., float('inf'), 0., 0., 0., 0.]]*4)

    def test_opposite_element_direction_preserves_world_curvature(self):
        p = fixture()
        p['mesh']['members'][1].update(nodes=[4, 3], frame={'x': [-1., 0., 0.], 'y': [0., 1., 0.], 'z': [0., 0., -1.], 'lengthM': 2.})
        r = WeldSpanKernel(p).evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [0., .0005*x[0]**2, 0., 0., 0., .001*x[0]]))[0]
        self.close(r['forceOnFirstN'][1], 20/3)
        self.close(r['energyJ'], 1/250)



class OccurrencePathInputTests(unittest.TestCase):
    def test_refuses_string_occurrence_path(self):
        p = fixture()
        p['mesh']['members'][0]['occurrencePath'] = 'a'
        with self.assertRaises(ValueError):
            WeldSpanKernel(p)

    def test_refuses_dictionary_occurrence_path(self):
        p = fixture()
        p['mesh']['members'][0]['occurrencePath'] = {'a': 7}
        with self.assertRaises(ValueError):
            WeldSpanKernel(p)

    def test_retains_valid_occurrence_path_array_and_independent_force_energy(self):
        p = fixture()
        before = copy.deepcopy(p)
        self.assertEqual(p['mesh']['members'][0]['occurrencePath'], ['a'])
        r = WeldSpanKernel(p).evaluate(motions(p, lambda x, i: [0.]*6 if i < 2 else [0., .001, 0., 0., 0., 0.]))[0]
        self.assertLessEqual(abs(r['forceOnFirstN'][1]-10), 1e-9*10)
        self.assertLessEqual(abs(r['energyJ']-1/200), 1e-9/200)
        self.assertEqual(p, before)


if __name__ == '__main__':
    unittest.main()
