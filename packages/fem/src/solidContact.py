"""W18-A: fixed-reference, small-displacement frictionless P1 face contact.

Coordinates/displacements/gaps use mm, kn uses N/mm^3, and pressure N/mm^2.
The master and slave reference triangles must be parallel and their normal
projections contained in the master patch. Initial gap is the declared physical
gap, not an offset added to the reference-coordinate separation. Normals and
shape functions stay fixed. Finite sliding, curved/rotating normals, nonlinear
increment control and native cross-body matrix profiles are separate work.
"""

import math


def _finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'solid-contact: {name} must be a finite number')
    try:
        result = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError(f'solid-contact: {name} is not representable') from error
    if not math.isfinite(result):
        raise ValueError(f'solid-contact: {name} must be finite')
    return result


def _vector(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f'solid-contact: {name} needs three coordinates')
    return tuple(_finite(item, name) for item in value)


def _subtract(left, right):
    return tuple(_finite(a - b, 'coordinate difference') for a, b in zip(left, right))


def _dot(left, right):
    try:
        return _finite(math.fsum(a * b for a, b in zip(left, right)), 'dot product')
    except (OverflowError, ValueError) as error:
        raise ValueError('solid-contact: dot product is not representable') from error


def _cross(left, right):
    return (left[1] * right[2] - left[2] * right[1],
            left[2] * right[0] - left[0] * right[2],
            left[0] * right[1] - left[1] * right[0])


def _positive_product(*values):
    """Avoid squaring thin geometry or overflowing a representable product."""
    mantissa, exponent = 1.0, 0
    for value in values:
        if not value > 0 or not math.isfinite(value):
            raise ValueError('solid-contact: positive finite measure required')
        part, power = math.frexp(value)
        mantissa *= part
        exponent += power
        mantissa, power = math.frexp(mantissa)
        exponent += power
    try:
        result = math.ldexp(mantissa, exponent)
    except OverflowError as error:
        raise ValueError('solid-contact: measure is not representable') from error
    if not result > 0 or not math.isfinite(result):
        raise ValueError('solid-contact: measure is not representable')
    return result


def _triangle(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f'solid-contact: {name} needs three vertices')
    points = tuple(_vector(point, name) for point in value)
    first, second = _subtract(points[1], points[0]), _subtract(points[2], points[0])
    first_length, second_length = math.hypot(*first), math.hypot(*second)
    if not first_length > 0 or not second_length > 0:
        raise ValueError('solid-contact: triangle has zero area')
    first_unit = tuple(item / first_length for item in first)
    second_unit = tuple(item / second_length for item in second)
    cross = _cross(first_unit, second_unit)
    sine = math.hypot(*cross)
    if not sine > 0:
        raise ValueError('solid-contact: triangle has zero area')
    normal = tuple(item / sine for item in cross)
    area = _positive_product(0.5, first_length, second_length, sine)
    return points, first_unit, second_unit, first_length, second_length, sine, normal, area


def _barycentric(point, triangle):
    points, first, second, first_length, second_length, sine, normal, _ = triangle
    delta = _subtract(point, points[0])
    # Separate edge scales: a 1e-170 mm edge must not disappear by squaring it.
    v = _dot(_cross(tuple(item / first_length for item in delta), second), normal) / sine
    w = _dot(_cross(first, tuple(item / second_length for item in delta)), normal) / sine
    result = (1.0 - v - w, v, w)
    if any(not math.isfinite(item) for item in result):
        raise ValueError('solid-contact: projected coordinates are not representable')
    tolerance = 64 * math.ulp(1.0)
    if any(item < -tolerance or item > 1 + tolerance for item in result):
        raise ValueError('solid-contact: normal projection lies outside master patch')
    # Only absorb rounding at the boundary; never clamp a genuinely outside point.
    clamped = tuple(min(1.0, max(0.0, item)) for item in result)
    total = math.fsum(clamped)
    return tuple(item / total for item in clamped)


def _closed_polygon(gaps):
    """Clip the reference barycentric triangle by its affine physical gap."""
    original = [((1.0, 0.0, 0.0), gaps[0]), ((0.0, 1.0, 0.0), gaps[1]),
                ((0.0, 0.0, 1.0), gaps[2])]
    polygon = []
    for index, (current, current_gap) in enumerate(original):
        previous, previous_gap = original[index - 1]
        if (previous_gap < 0) != (current_gap < 0):
            scale = max(abs(previous_gap), abs(current_gap))
            fraction = (previous_gap / scale) / (previous_gap / scale - current_gap / scale)
            crossing = tuple(a + fraction * (b - a) for a, b in zip(previous, current))
            polygon.append(crossing)
        if current_gap < 0:
            polygon.append(current)
    return polygon


def contactResidualAndTangent(master, slave, normal, initialGapMm, knNPerMm3, displacementMm=None):
    """Return energy gradient/Hessian in master xyz then slave xyz node order.

    E = kn/2 * integral(min(g, 0)^2 dA), g = initialGap + C*u,
    C = [-Nm*n, +Ns*n]. Residual is the internal energy gradient; pressure
    is nonnegative compression. At exactly zero gap use the open-side tangent
    (zero). A partly closed triangle is clipped and integrated exactly for P1
    fields using degree-two quadrature, rather than a closest-point sample.
    Returned integration points cover the closed area only. vertexGapsMm also
    reports the whole triangle when it is open. No input is mutated.
    """
    master_data, slave_data = _triangle(master, 'master'), _triangle(slave, 'slave')
    direction = _vector(normal, 'normal')
    if abs(math.hypot(*direction) - 1.0) > 1e-12:
        raise ValueError('solid-contact: explicit unit normal required')
    for triangle in (master_data, slave_data):
        if math.hypot(*_cross(direction, triangle[6])) > 1e-12:
            raise ValueError('solid-contact: fixed parallel reference facets required')
    initial_gap = _finite(initialGapMm, 'initial gap')
    penalty = _finite(knNPerMm3, 'normal penalty')
    if not penalty > 0:
        raise ValueError('solid-contact: normal penalty must be positive')
    area = slave_data[7]
    _positive_product(area, penalty)
    if displacementMm is None:
        displacement = [0.0] * 18
    elif not isinstance(displacementMm, (list, tuple)) or len(displacementMm) != 18:
        raise ValueError('solid-contact: exactly eighteen displacements required')
    else:
        displacement = [_finite(item, 'displacement') for item in displacementMm]
    master_weights = []
    for point in slave_data[0]:
        separation = _dot(_subtract(point, master_data[0][0]), direction)
        projected = tuple(_finite(value - separation * axis, 'projection')
                          for value, axis in zip(point, direction))
        master_weights.append(_barycentric(projected, master_data))
    rows = []
    for vertex in range(3):
        rows.append([-weight * axis for weight in master_weights[vertex] for axis in direction]
                    + [float(node == vertex) * axis for node in range(3) for axis in direction])
    gaps = [_finite(initial_gap + _dot(row, displacement), 'physical gap') for row in rows]
    polygon = _closed_polygon(gaps)
    residual = [0.0] * 18
    tangent = [[0.0] * 18 for _ in range(18)]
    energy, closed_area, resultant = 0.0, 0.0, 0.0
    points = []
    quadrature = ((2 / 3, 1 / 6, 1 / 6), (1 / 6, 2 / 3, 1 / 6), (1 / 6, 1 / 6, 2 / 3))
    for index in range(1, len(polygon) - 1):
        a, b, c = polygon[0], polygon[index], polygon[index + 1]
        first = (b[1] - a[1], b[2] - a[2])
        second = (c[1] - a[1], c[2] - a[2])
        first_length, second_length = math.hypot(*first), math.hypot(*second)
        if first_length == 0 or second_length == 0:
            continue
        sine = abs((first[0] / first_length) * (second[1] / second_length)
                   - (first[1] / first_length) * (second[0] / second_length))
        if sine == 0:
            continue
        subarea = _positive_product(area, first_length, second_length, sine)
        weight = _positive_product(subarea, 1 / 3)
        closed_area += subarea
        for bary in quadrature:
            slave_shape = tuple(math.fsum(bary[j] * vertex[i] for j, vertex in enumerate((a, b, c)))
                                for i in range(3))
            master_shape = tuple(math.fsum(slave_shape[j] * master_weights[j][i] for j in range(3))
                                 for i in range(3))
            row = [-shape * axis for shape in master_shape for axis in direction]
            row += [shape * axis for shape in slave_shape for axis in direction]
            gap = _dot(slave_shape, gaps)
            if not gap < 0:
                raise ValueError('solid-contact: closed quadrature gap is not representable')
            pressure = _positive_product(penalty, -gap)
            force = _positive_product(pressure, weight)
            stiffness = _positive_product(penalty, weight)
            energy = _finite(energy + _positive_product(0.5, force, -gap), 'energy')
            resultant = _finite(resultant + force, 'resultant')
            for i in range(18):
                residual[i] = _finite(residual[i] - force * row[i], 'residual')
                for j in range(18):
                    tangent[i][j] = _finite(tangent[i][j] + stiffness * row[i] * row[j], 'tangent')
            points.append({'slaveShape': slave_shape, 'masterShape': master_shape,
                           'areaWeightMm2': weight, 'gapMm': gap, 'pressureMPa': pressure})
    if any(gap < 0 for gap in gaps) and closed_area == 0:
        raise ValueError('solid-contact: closed patch is not representable')
    return {'residualN': residual, 'tangentNPerMm': tangent, 'energyNmm': energy,
            'areaMm2': area, 'closedAreaMm2': closed_area, 'vertexGapsMm': gaps,
            'compressiveResultantN': resultant, 'integrationPoints': points,
            'zeroGapPolicy': 'open-side-zero-tangent'}


def contactEquationMap(fem, domain, numbering, bodyNodes, contactNodes, equationCount):
    """Resolve six (body ID, local node index) identities to 18 real equations.

    bodyNodes maps each body ID to its original-node-order sequence of
    {'nativeNode': positive int, 'fixed': three bools}. Native numbers must be
    globally unique; local indexes may repeat in different bodies. Read actual
    OOFEM DOFs through the provided numbering, retaining 0 only for constrained
    axes. This does not extend the native skyline sparsity profile.
    """
    if type(equationCount) is not int or equationCount < 0:
        raise ValueError('solid-contact: invalid equation count')
    if not isinstance(bodyNodes, dict) or not bodyNodes:
        raise ValueError('solid-contact: body-node mapping required')
    if not isinstance(contactNodes, (list, tuple)) or len(contactNodes) != 6:
        raise ValueError('solid-contact: six body-local contact nodes required')
    dofs = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
    equations, native_seen, equation_seen = {}, set(), set()
    for body, nodes in bodyNodes.items():
        if not isinstance(body, str) or not body or not isinstance(nodes, (list, tuple)) or not nodes:
            raise ValueError('solid-contact: invalid body identity or node mapping')
        for index, record in enumerate(nodes):
            if not isinstance(record, dict):
                raise ValueError('solid-contact: invalid native node record')
            native, fixed = record.get('nativeNode'), record.get('fixed')
            if type(native) is not int or native < 1 or native in native_seen:
                raise ValueError('solid-contact: native node mapping must be unique and positive')
            if not isinstance(fixed, (list, tuple)) or len(fixed) != 3 or any(type(item) is not bool for item in fixed):
                raise ValueError('solid-contact: three explicit restraint flags required')
            native_seen.add(native)
            try:
                manager = domain.giveDofManager(native)
                row = [numbering.giveDofEquationNumber(manager.giveDofWithID(dof)) for dof in dofs]
            except Exception as error:
                raise ValueError('solid-contact: native DOF mapping unavailable') from error
            for axis, equation in enumerate(row):
                if type(equation) is not int or equation < 0 or equation > equationCount:
                    raise ValueError('solid-contact: native equation outside declared range')
                if (equation == 0) != fixed[axis]:
                    raise ValueError('solid-contact: native equation disagrees with restraint')
                if equation and equation in equation_seen:
                    raise ValueError('solid-contact: distinct native DOFs alias one free equation')
                if equation:
                    equation_seen.add(equation)
            equations[(body, index)] = row
    result = []
    for reference in contactNodes:
        if (not isinstance(reference, (list, tuple)) or len(reference) != 2
                or not isinstance(reference[0], str) or type(reference[1]) is not int
                or reference[1] < 0 or tuple(reference) not in equations):
            raise ValueError('solid-contact: unknown body-local node identity')
        result.extend(equations[tuple(reference)])
    return result
