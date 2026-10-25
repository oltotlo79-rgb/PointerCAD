"""Finite elastic effective weld-throat layer between two Beam3d section frames.

Explicit rectangular effective area, thickness and isotropic E/nu; normal E/t
and shear G/t spring densities. This is a small-displacement compliant joint
idealization, NOT a solid weld stress field, rigid bond, strength or failure
criterion. No geometry/material inference, preload, damage or plasticity.
Both frame rotations act at the SAME spatial quadrature point. Consequently
global rigid motion costs no energy and the joint wrenches balance in force
and moment, including eccentric reference nodes. Existing contact residual
and mechanism refusals remain unchanged. Units: m, N, Pa, rad.
"""
import json
import math
from beam_contact import run_beam_contact, validate_contact_plan, _solve_contact_system


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value) and abs(value) <= 1e30


def _vector(value):
    return isinstance(value, list) and len(value) == 3 and all(_finite(v) for v in value)


def validate_welds(plan):
    if not isinstance(plan, dict) or set(plan) != {'schema', 'contact', 'welds'} or plan['schema'] != 'pointercad-weld-layer-plan/1':
        raise ValueError('weld-shape: unsupported plan')
    validate_contact_plan(plan['contact'])
    positions = {n['number']: n['positionM'] for n in plan['contact']['nodes'][:plan['contact']['originalNodeCount']]}
    welds = plan['welds']
    if not isinstance(welds, list) or not 1 <= len(welds) <= 64:
        raise ValueError('weld-count: expected 1..64')
    ids = set()
    patches = {}
    fields = {'id', 'nodeA', 'nodeB', 'centerM', 'normal', 'along', 'widthM', 'lengthM', 'thicknessM', 'youngPa', 'poisson'}
    for weld in welds:
        if not isinstance(weld, dict) or set(weld) != fields:
            raise ValueError('weld-shape: unknown or absent weld fields')
        identity, a, b = weld['id'], weld['nodeA'], weld['nodeB']
        if not isinstance(identity, str) or not 1 <= len(identity) <= 64 or identity in ids:
            raise ValueError('weld-id: missing or duplicate')
        if type(a) is not int or type(b) is not int or a == b or a not in positions or b not in positions:
            raise ValueError('weld-node: distinct original node identities required')
        if not all(_vector(weld[k]) for k in ('centerM', 'normal', 'along')):
            raise ValueError('weld-frame: finite spatial frame required')
        n, s = weld['normal'], weld['along']
        if abs(math.hypot(*n) - 1) > 1e-10 or abs(math.hypot(*s) - 1) > 1e-10 or abs(sum(x*y for x, y in zip(n, s))) > 1e-10:
            raise ValueError('weld-frame: orthonormal normal and along required')
        if any(not _finite(weld[k]) or not 1e-30 < weld[k] <= 1e30 for k in ('widthM', 'lengthM', 'thicknessM', 'youngPa')):
            raise ValueError('weld-number: bounded positive dimensions and E required')
        if not _finite(weld['poisson']) or not 0 <= weld['poisson'] < 0.5:
            raise ValueError('weld-material: only isotropic 0 <= nu < 0.5 supported')
        # Same-pair patches are separate physical intervals, never a filled envelope.
        pair = tuple(sorted((a, b)))
        for previous in patches.get(pair, []):
            if any(abs(x-y) > 1e-10 for key in ('normal', 'along') for x, y in zip(weld[key], previous[key])):
                raise ValueError('weld-scope: same-pair patches require aligned frames')
            delta = [x-y for x, y in zip(weld['centerM'], previous['centerM'])]
            station = sum(x*y for x, y in zip(delta, s))
            tolerance = 1e-10 * max(weld['widthM'], weld['lengthM'], previous['widthM'], previous['lengthM'])
            if math.hypot(*(x-station*y for x, y in zip(delta, s))) > tolerance:
                raise ValueError('weld-scope: same-pair patches require one coplanar centerline')
            pn, ps = previous['normal'], previous['along']
            pq = [pn[1]*ps[2]-pn[2]*ps[1], pn[2]*ps[0]-pn[0]*ps[2], pn[0]*ps[1]-pn[1]*ps[0]]
            radius = (weld['widthM']*sum(x*x for x in s)
                      + previous['widthM']*abs(sum(x*y for x, y in zip(ps, s)))
                      + previous['lengthM']*abs(sum(x*y for x, y in zip(pq, s)))) / 2
            # Project the full other rectangle, including its tiny accepted frame tilt.
            # A roundoff-size apparent gap is not evidence of disjoint physical area.
            scale = radius + sum((abs(x)+abs(y))*abs(z) for x, y, z in zip(weld['centerM'], previous['centerM'], s))
            if abs(station) <= radius + 32*math.ulp(1.0)*scale:
                raise ValueError('weld-duplicate: overlap or unresolved patch separation')
        ids.add(identity)
        patches.setdefault(pair, []).append(weld)
    return positions


def _skew(np, r):
    x, y, z = r
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]])


def weld_operators(np, plan):
    """Four-point area quadrature is exact for this quadratic energy; no mesh tuning."""
    positions = validate_welds(plan)
    size = 6 * len(plan['contact']['nodes'])
    operators = []
    for weld in plan['welds']:
        n, s = np.array(weld['normal']), np.array(weld['along'])
        q = np.cross(n, s)
        e, nu, thickness = weld['youngPa'], weld['poisson'], weld['thicknessM']
        g = e / (2 * (1 + nu))
        density = (g * np.eye(3) + (e - g) * np.outer(n, n)) / thickness
        weight = weld['widthM'] * weld['lengthM'] / 4
        if not math.isfinite(weight) or weight <= 0 or not np.isfinite(density).all():
            raise ValueError('weld-scale: unrepresentable layer stiffness')
        points = []
        for i, j in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
            point = np.array(weld['centerM']) + i * weld['widthM'] / math.sqrt(12) * s + j * weld['lengthM'] / math.sqrt(12) * q
            row = np.zeros((3, size))
            for key, sign in (('nodeA', -1.0), ('nodeB', 1.0)):
                node = weld[key]
                start = 6 * (node - 1)
                row[:, start:start + 3] = sign * np.eye(3)
                row[:, start + 3:start + 6] = -sign * _skew(np, point - positions[node])
            points.append((row, weight * density))
        operators.append((weld, points))
    return operators


def solve_weld_contact_system(np, plan, native_stiffness, moment_length, *, constant_force=None):
    operators = weld_operators(np, plan)
    size = 6 * len(plan['contact']['nodes'])
    stiffness = np.array(native_stiffness, dtype=float, copy=True)
    if stiffness.shape != (size, size) or not np.isfinite(stiffness).all():
        raise ValueError('weld-stiffness: invalid native matrix')
    for _, points in operators:
        for row, weighted in points:
            stiffness += row.T @ weighted @ row
    if not np.isfinite(stiffness).all():
        raise ValueError('weld-stiffness: unrepresentable combined stiffness')
    contact = (_solve_contact_system(np, plan['contact'], stiffness, moment_length)
               if constant_force is None else _solve_contact_system(np, plan['contact'], stiffness, moment_length,
                                                                    constant_force=constant_force))
    states = []
    for state in contact['states']:
        displacement = np.zeros(size)
        for node in state['nodes']:
            start = 6 * (node['number'] - 1)
            displacement[start:start + 6] = node['displacementM'] + node['rotationRad']
        joints = []
        for weld, points in operators:
            internal = np.zeros(size)
            energy = 0.0
            for row, weighted in points:
                relative = row @ displacement
                internal += row.T @ (weighted @ relative)
                energy += float(relative @ weighted @ relative) / 2
            # Force of the joint ON each node is minus its internal resisting vector.
            a, b = 6 * (weld['nodeA'] - 1), 6 * (weld['nodeB'] - 1)
            if not np.isfinite(internal).all() or not math.isfinite(energy):
                raise ValueError('weld-result: nonfinite wrench or energy')
            joints.append({'id': weld['id'], 'forceOnAN': (-internal[a:a+3]).tolist(),
                           'momentOnANm': (-internal[a+3:a+6]).tolist(),
                           'forceOnBN': (-internal[b:b+3]).tolist(),
                           'momentOnBNm': (-internal[b+3:b+6]).tolist(), 'elasticEnergyJ': energy})
        states.append({'loadFactor': state['loadFactor'], 'welds': joints})
    return {'schema': 'pointercad-weld-layer-result/1', 'contact': contact, 'states': states}


def run_beam_weld_contact():
    with open('/pcad_fem/weld-contact-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    validate_welds(plan)
    return run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
                            solve_weld_contact_system(np, plan, stiffness, length))
