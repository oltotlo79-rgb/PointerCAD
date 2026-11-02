"""Internal, bounded straight Beam3d span kernel, SI units; no native solve or saved schema.

OOFEM 214b161ed Beam3d N includes Timoshenko section rotations. Each point is
mapped to the ACTUAL containing element, not the original member's outer ends.
Joint loads are the transpose of that map. Initial strain is not an argument.
"""
import copy
import math


def _fail():
    raise ValueError('weld-span: invalid, unsupported or unbounded input')


def _finite(x):
    return type(x) in (int, float) and math.isfinite(x) and abs(x) <= 1e30


def _positive(x):
    return _finite(x) and x > 1e-30


def _data(x, depth=0):
    if depth > 24:
        return False
    if x is None or type(x) in (str, bool):
        return True
    if type(x) in (int, float):
        return _finite(x)
    if type(x) is list:
        return len(x) <= 4096 and all(_data(v, depth+1) for v in x)
    if type(x) is dict:
        return all(type(k) is str and _data(v, depth+1) for k, v in x.items())
    return False


def _keys(x, names):
    if type(x) is not dict or set(x) != set(names):
        _fail()


def _vector(x, size):
    if type(x) is not list or len(x) != size or not all(_finite(v) for v in x):
        _fail()


def _dot(a, b):
    return sum(x*y for x, y in zip(a, b, strict=True))


def _add(a, b):
    return [x+y for x, y in zip(a, b, strict=True)]


def _sub(a, b):
    return [x-y for x, y in zip(a, b, strict=True)]


def _scale(a, k):
    return [x*k for x in a]


def _cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def _zeros(n, m):
    return [[0.0]*m for _ in range(n)]


def _unit(x):
    _vector(x, 3)
    if abs(_dot(x, x)-1) > 1e-10:
        _fail()


def beam_span_shape(length, ky, kz, xi):
    """6x12 fixed Beam3d interpolation; x is the analysis axis, not CAD local Z."""
    if not _positive(length) or not all(_finite(x) for x in (ky, kz, xi)) or min(ky, kz, xi) < 0 or xi > 1:
        _fail()
    n = _zeros(6, 12)
    n[0][0] = n[3][3] = 1-xi
    n[0][6] = n[3][9] = xi
    for k, t, r, sign in ((kz, 1, 5, 1), (ky, 2, 4, -1)):
        c, x2, x3 = 1+2*k, xi*xi, xi**3
        n[t][t] = (c-2*k*xi-3*x2+2*x3)/c
        n[t][r] = sign*length*((1+k)*xi-(2+k)*x2+x3)/c
        n[t][t+6] = (2*k*xi+3*x2-2*x3)/c
        n[t][r+6] = -sign*length*(k*xi+(1-k)*x2-x3)/c
        n[r][t] = -sign*6*xi*(1-xi)/(length*c)
        n[r][r] = (c-2*(2+k)*xi+3*x2)/c
        n[r][t+6] = sign*6*xi*(1-xi)/(length*c)
        n[r][r+6] = (-2*(1-k)*xi+3*x2)/c
    if not all(_finite(x) for row in n for x in row):
        _fail()
    return n


def _validate_mesh(mesh):
    _keys(mesh, ('nodes', 'members', 'materials', 'sections', 'originalNodeCount'))
    if (not 2 <= len(mesh['nodes']) <= 128 or not 1 <= len(mesh['members']) <= 512 or not mesh['materials'] or not mesh['sections']
            or type(mesh['originalNodeCount']) is not int or not 2 <= mesh['originalNodeCount'] <= len(mesh['nodes'])):
        _fail()
    for i, node in enumerate(mesh['nodes'], 1):
        _keys(node, ('number', 'positionM', 'restrained', 'load'))
        _vector(node['positionM'], 3)
        _vector(node['load'], 6)
        if type(node['number']) is not int or node['number'] != i or max(map(abs, node['positionM'])) > 1e9 or len(node['restrained']) != 6 or any(type(v) is not bool for v in node['restrained']):
            _fail()
    for i, m in enumerate(mesh['materials'], 1):
        _keys(m, ('number', 'youngPa', 'poisson', 'densityKgM3'))
        if type(m['number']) is not int or m['number'] != i or not _positive(m['youngPa']) or not _positive(m['densityKgM3']) or not _finite(m['poisson']) or not -1 < m['poisson'] < .5:
            _fail()
    for i, s in enumerate(mesh['sections'], 1):
        _keys(s, ('number', 'areaM2', 'iyM4', 'izM4', 'torsionM4', 'shearFactor'))
        if type(s['number']) is not int or s['number'] != i or any(not _positive(s[k]) for k in s if k != 'number'):
            _fail()
    groups = {}
    for i, e in enumerate(mesh['members'], 1):
        _keys(e, ('number', 'id', 'componentId', 'occurrencePath', 'nodes', 'material', 'section', 'frame'))
        f = e['frame']
        _keys(f, ('x', 'y', 'z', 'lengthM'))
        if (type(e['number']) is not int or e['number'] != i or type(e['id']) is not str or not e['id']
                or type(e['componentId']) is not str or not e['componentId'] or type(e['occurrencePath']) is not list or not e['occurrencePath']
                or any(type(v) is not str or not v for v in e['occurrencePath']) or len(e['nodes']) != 2
                or any(type(v) is not int or not 1 <= v <= len(mesh['nodes']) for v in e['nodes'])
                or e['nodes'][0] == e['nodes'][1] or type(e['material']) is not int or not 1 <= e['material'] <= len(mesh['materials'])
                or type(e['section']) is not int or not 1 <= e['section'] <= len(mesh['sections'])):
            _fail()
        delta = _sub(mesh['nodes'][e['nodes'][1]-1]['positionM'], mesh['nodes'][e['nodes'][0]-1]['positionM'])
        length = math.hypot(*delta)
        for axis in 'xyz':
            _unit(f[axis])
        if (length <= 1e-9 or not _positive(f['lengthM']) or abs(f['lengthM']-length) > 1e-9*length
                or math.hypot(*_sub(_scale(delta, 1/length), f['x'])) > 1e-10
                or abs(_dot(f['x'], f['y'])) > 1e-10 or math.hypot(*_sub(_cross(f['x'], f['y']), f['z'])) > 1e-10):
            _fail()
        group = groups.setdefault(e['id'], [])
        for old in group:
            if (any(old[k] != e[k] for k in ('componentId', 'occurrencePath', 'material', 'section'))
                    or math.hypot(*_sub(old['frame']['x'], f['x'])) > 1e-10 or math.hypot(*_sub(old['frame']['y'], f['y'])) > 1e-10):
                _fail()
        group.append(e)
    for group in groups.values():
        if len(group) > 32:
            _fail()
        ordered = sorted(group, key=lambda e: _dot(mesh['nodes'][e['nodes'][0]-1]['positionM'], e['frame']['x']))
        if any(a['nodes'][1] != b['nodes'][0] for a, b in zip(ordered, ordered[1:])):
            _fail()


def _side_key(side):
    return 'm:'+side['memberId'] if side['kind'] == 'span' else 'n:'+str(side['node'])


def _elements(mesh, side):
    if side['kind'] == 'section':
        _keys(side, ('kind', 'node'))
        if type(side['node']) is not int or not 1 <= side['node'] <= mesh['originalNodeCount']:
            _fail()
        return []
    _keys(side, ('kind', 'memberId'))
    if side['kind'] != 'span' or type(side['memberId']) is not str:
        _fail()
    result = [e for e in mesh['members'] if e['id'] == side['memberId']]
    if not result:
        _fail()
    return result


def _point_map(mesh, side, point):
    if side['kind'] == 'section':
        r = _sub(point, mesh['nodes'][side['node']-1]['positionM'])
        h = _zeros(3, 6)
        for j in range(3):
            h[j][j] = 1.0
            axis = [0.0]*3
            axis[j] = 1.0
            v = _cross(axis, r)
            for i in range(3):
                h[i][j+3] = v[i]
        return list(range(6*(side['node']-1), 6*side['node'])), h
    candidates = []
    for e in _elements(mesh, side):
        p = mesh['nodes'][e['nodes'][0]-1]['positionM']
        x = _dot(_sub(point, p), e['frame']['x'])
        if 0 <= x <= e['frame']['lengthM']:
            candidates.append((e, p, x))
    if not candidates:
        _fail()
    e, p, x = candidates[0]
    f, m, s = e['frame'], mesh['materials'][e['material']-1], mesh['sections'][e['section']-1]
    r = _sub(point, _add(p, _scale(f['x'], x)))
    den = m['youngPa']/(2*(1+m['poisson']))*s['shearFactor']*s['areaM2']*f['lengthM']**2
    n = beam_span_shape(f['lengthM'], 6*m['youngPa']*s['iyM4']/den, 6*m['youngPa']*s['izM4']/den, x/f['lengthM'])
    axes, h = [f[k] for k in 'xyz'], _zeros(3, 12)
    for j in range(12):
        local = [0.0]*12
        for a in range(3):
            local[(j//3)*3+a] = axes[a][j % 3]
        motion = [_dot(row, local) for row in n]
        u = [sum(axes[a][i]*motion[a] for a in range(3)) for i in range(3)]
        theta = [sum(axes[a][i]*motion[a+3] for a in range(3)) for i in range(3)]
        v = _add(u, _cross(theta, r))
        for i in range(3):
            h[i][j] = v[i]
    if not all(_finite(x) for row in h for x in row):
        _fail()
    return [6*(node-1)+i for node in e['nodes'] for i in range(6)], h


class WeldSpanKernel:
    """Owned copies of prepared geometry and operators; evaluate requires every mesh motion."""
    def __init__(self, value):
        if not _data(value):
            _fail()
        _keys(value, ('mesh', 'patches'))
        plan = copy.deepcopy(value)
        self._mesh, patches = plan['mesh'], plan['patches']
        mesh = self._mesh
        _validate_mesh(mesh)
        if not 1 <= len(patches) <= 64:
            _fail()
        self.stiffness = _zeros(6*len(mesh['nodes']), 6*len(mesh['nodes']))
        self._operators, self.cell_counts = [], []
        ids = set()
        gauss = [(sign*math.sqrt((3+branch*2*math.sqrt(6/5))/7), (18-branch*math.sqrt(30))/36)
                 for branch in (-1, 1) for sign in (-1, 1)]
        for pi, patch in enumerate(patches):
            _keys(patch, ('id', 'centerM', 'normal', 'along', 'widthM', 'lengthM', 'thicknessM', 'youngPa', 'poisson', 'first', 'second'))
            if type(patch['id']) is not str or not 1 <= len(patch['id']) <= 64 or patch['id'] in ids:
                _fail()
            ids.add(patch['id'])
            _vector(patch['centerM'], 3)
            _unit(patch['normal'])
            _unit(patch['along'])
            if (abs(_dot(patch['normal'], patch['along'])) > 1e-10 or any(not _positive(patch[k]) for k in ('widthM', 'lengthM', 'thicknessM', 'youngPa'))
                    or not _finite(patch['poisson']) or not 0 <= patch['poisson'] < .5 or _side_key(patch['first']) == _side_key(patch['second'])):
                _fail()
            q = _cross(patch['normal'], patch['along'])
            left, right = -patch['widthM']/2, patch['widthM']/2
            breaks = {left, right}
            for side in (patch['first'], patch['second']):
                elements = _elements(mesh, side)
                if not elements:
                    continue
                axis = elements[0]['frame']['x']
                if abs(abs(_dot(axis, patch['along']))-1) > 1e-10 or abs(_dot(axis, q)) > 1e-10:
                    _fail()
                origin = mesh['nodes'][elements[0]['nodes'][0]-1]['positionM']
                extent = [_dot(_sub(mesh['nodes'][node-1]['positionM'], origin), axis) for e in elements for node in e['nodes']]
                ends = [_dot(_sub(_add(patch['centerM'], _scale(patch['along'], sign*patch['widthM']/2)), origin), axis) for sign in (-1, 1)]
                if min(ends) < min(extent) or max(ends) > max(extent):
                    _fail()
                stations = [_dot(_sub(mesh['nodes'][node-1]['positionM'], patch['centerM']), patch['along']) for e in elements for node in e['nodes']]
                breaks.update(t for t in stations if left < t < right)
            for other in patches[:pi]:
                if sorted(map(_side_key, (patch['first'], patch['second']))) != sorted(map(_side_key, (other['first'], other['second']))):
                    continue
                delta = _sub(patch['centerM'], other['centerM'])
                station = _dot(delta, patch['along'])
                if (math.hypot(*_sub(patch['normal'], other['normal'])) > 1e-10 or math.hypot(*_sub(patch['along'], other['along'])) > 1e-10
                        or math.hypot(*_sub(delta, _scale(patch['along'], station))) > 1e-10*max(patch['widthM'], patch['lengthM'], other['widthM'], other['lengthM'])):
                    _fail()
                radius = (patch['widthM']+other['widthM'])/2
                rounding = 32*math.ulp(1.0)*(radius+sum((abs(a)+abs(b))*abs(s) for a, b, s in zip(patch['centerM'], other['centerM'], patch['along'], strict=True)))
                if abs(station) <= radius+rounding:
                    _fail()
            ordered = sorted(breaks)
            if len(ordered) > 64:
                _fail()
            shear = patch['youngPa']/(2*(1+patch['poisson']))
            density = [[((shear if i == j else 0)+(patch['youngPa']-shear)*patch['normal'][i]*patch['normal'][j])/patch['thicknessM'] for j in range(3)] for i in range(3)]
            if not all(_finite(x) for row in density for x in row):
                _fail()
            points = []
            for a, b in zip(ordered, ordered[1:]):
                half, mid = (b-a)/2, (a+b)/2
                if half <= 0:
                    _fail()
                for gx, gw in gauss:
                    for sign in (-1, 1):
                        point = _add(patch['centerM'], _add(_scale(patch['along'], mid+gx*half), _scale(q, sign*patch['lengthM']/math.sqrt(12))))
                        ia, ha = _point_map(mesh, patch['first'], point)
                        ib, hb = _point_map(mesh, patch['second'], point)
                        indices = ia+ib
                        row = [[-v for v in x]+y for x, y in zip(ha, hb, strict=True)]
                        weight = half*gw*patch['lengthM']/2
                        weighted = [[v*weight for v in r] for r in density]
                        if not _positive(weight) or not all(_finite(x) for r in weighted for x in r):
                            _fail()
                        for i, gi in enumerate(indices):
                            for j, gj in enumerate(indices):
                                self.stiffness[gi][gj] += sum(row[r][i]*weighted[r][s]*row[s][j] for r in range(3) for s in range(3))
                        points.append((point, ia, ha, ib, hb, weighted))
            self._operators.append((patch, points))
            self.cell_counts.append(len(ordered)-1)
        if not all(_finite(x) for r in self.stiffness for x in r):
            _fail()

    def evaluate(self, motions):
        mesh = self._mesh
        if not _data(motions) or len(motions) != len(mesh['nodes']):
            _fail()
        for node, motion in zip(mesh['nodes'], motions, strict=True):
            _vector(motion, 6)
            if any(fixed and v != 0 for fixed, v in zip(node['restrained'], motion, strict=True)):
                _fail()
        flat = [v for row in motions for v in row]
        results = []
        for patch, points in self._operators:
            first, second = _zeros(len(mesh['nodes']), 6), _zeros(len(mesh['nodes']), 6)
            energy, force, moment = 0.0, [0.0]*3, [0.0]*3
            for point, ia, ha, ib, hb, weighted in points:
                a, b = [[_dot(row, [flat[i] for i in indices]) for row in h] for indices, h in ((ia, ha), (ib, hb))]
                d = _sub(b, a)
                f = [_dot(row, d) for row in weighted]
                energy += _dot(d, f)/2
                force = _add(force, f)
                moment = _add(moment, _cross(_sub(point, patch['centerM']), f))
                for indices, h, result, sign in ((ia, ha, first, 1), (ib, hb, second, -1)):
                    for j, index in enumerate(indices):
                        result[index//6][index % 6] += sign*sum(h[r][j]*f[r] for r in range(3))
            if energy < 0 or not all(_finite(v) for v in [energy]+force+moment+[v for r in first+second for v in r]):
                _fail()
            results.append({'id': patch['id'], 'first': first, 'second': second, 'forceOnFirstN': force,
                            'momentAtCenterNm': moment, 'energyJ': energy, 'structuralCertification': False})
        return results
