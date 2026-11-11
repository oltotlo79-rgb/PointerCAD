"""Fixed JSON entry for the W20-A native contact path; no generated Python.

This adapter retains the fixed reference facets and small-displacement limits.
Only a complete native history is a result. Failure records remain diagnostics.
"""

import hashlib
import json
import math
from pathlib import Path

from solidContactSolver import FixedContactPatch, SolidContactRun, solveSolidContactIncrement


SCHEMA = 'pointercad-solid-contact/1'


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('solid-contact-driver: duplicate JSON field')
        result[key] = value
    return result


def _constant(_):
    raise ValueError('solid-contact-driver: nonfinite JSON number')


def _object(value, names):
    if not isinstance(value, dict) or set(value) != set(names):
        raise ValueError('solid-contact-driver: object fields differ')
    return value


def _array(value, minimum, maximum):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError('solid-contact-driver: array extent differs')
    return value


def _number(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError('solid-contact-driver: finite number required')
    return value


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('solid-contact-driver: integer outside range')
    return value


def _text(value, maximum=500):
    if not isinstance(value, str) or not value or value != value.strip() or len(value.encode('utf-16-le')) // 2 > maximum:
        raise ValueError('solid-contact-driver: explicit bounded identity/source required')
    return value


def _hash(value):
    if len(_text(value, 64)) != 64 or any(char not in '0123456789abcdef' for char in value):
        raise ValueError('solid-contact-driver: invalid digest')
    return value


def _history(value, count, steps, used):
    result = {}
    for row in _array(value, 0, count * 3):
        _object(row, ('node', 'axis', 'values'))
        key = (_integer(row['node'], 0, count - 1), _integer(row['axis'], 0, 2))
        if key in used:
            raise ValueError('solid-contact-driver: repeated or conflicting history DOF')
        used.add(key)
        result[key] = [_number(item) for item in _array(row['values'], steps, steps)]
    return result


def read_input(raw):
    if not isinstance(raw, bytes):
        raise ValueError('solid-contact-driver: actual JSON bytes required')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs, parse_constant=_constant)
    _object(value, ('schema', 'units', 'source', 'preparationJson', 'preparationSha256', 'meshes', 'nodes',
                    'elements', 'bodies', 'material', 'prescribed', 'loads', 'steps', 'maxIterations', 'solveSource', 'patches'))
    if value['schema'] != SCHEMA or value['units'] != 'N-mm-MPa':
        raise ValueError('solid-contact-driver: unsupported schema/units')
    _text(value['solveSource'])
    _hash(value['preparationSha256'])
    preparation_bytes = value['preparationJson'].encode('utf-8')
    if hashlib.sha256(preparation_bytes).hexdigest() != value['preparationSha256']:
        raise ValueError('solid-contact-driver: actual preparation bytes differ')
    preparation = json.loads(preparation_bytes, object_pairs_hook=_pairs, parse_constant=_constant)
    if (preparation.get('kind') != 'cad-solid-contact-prepared' or 'preparationSha256' in preparation
            or preparation['source'] != value['source'] or preparation['nodesMm'] != value['nodes']
            or preparation['tetrahedra'] != value['elements']):
        raise ValueError('solid-contact-driver: preparation binding differs')
    source = _object(value['source'], ('documentId', 'revision', 'bodies'))
    _text(source['documentId'])
    _integer(source['revision'], 0, 2**53 - 1)
    source_bodies = _array(source['bodies'], 1, 1000)
    identifiers = set()
    for body in source_bodies:
        _object(body, ('bodyFeatureId', 'bodyKey', 'inputSha256', 'meshSha256'))
        identifier = _text(body['bodyFeatureId'])
        if identifier in identifiers:
            raise ValueError('solid-contact-driver: duplicate body source')
        identifiers.add(identifier)
        _text(body['bodyKey'])
        _hash(body['inputSha256'])
        _hash(body['meshSha256'])
    nodes = [[_number(axis) for axis in _array(point, 3, 3)] for point in _array(value['nodes'], 4, 1_000_000)]
    bodies = {}
    for body in _array(value['bodies'], len(source_bodies), len(source_bodies)):
        _object(body, ('id', 'nodes'))
        identifier = _text(body['id'])
        if identifier in bodies or identifier not in identifiers:
            raise ValueError('solid-contact-driver: duplicate/unknown body map')
        bodies[identifier] = [_integer(node, 0, len(nodes) - 1) for node in _array(body['nodes'], 4, len(nodes))]
    if sorted(node for mapped in bodies.values() for node in mapped) != list(range(len(nodes))):
        raise ValueError('solid-contact-driver: incomplete body node partition')
    meshes = _array(value['meshes'], len(source_bodies), len(source_bodies))
    flattened_elements = []
    for mesh_source, source_body in zip(meshes, source_bodies):
        _object(mesh_source, ('bodyFeatureId', 'mesh'))
        if mesh_source['bodyFeatureId'] != source_body['bodyFeatureId']:
            raise ValueError('solid-contact-driver: unordered mesh sources')
        mesh = mesh_source['mesh']
        mesh_stamp = mesh['input']['source']
        if (mesh['inputSha256'] != source_body['inputSha256'] or mesh_stamp['documentId'] != source['documentId']
                or mesh_stamp['revision'] != source['revision'] or mesh_stamp['bodyKey'] != source_body['bodyKey']
                or mesh_stamp['featureId'] != source_body['bodyFeatureId']):
            raise ValueError('solid-contact-driver: volume mesh belongs to another source')
        mapped = bodies[source_body['bodyFeatureId']]
        if [axis for node in mapped for axis in nodes[node]] != mesh['coordinates']:
            raise ValueError('solid-contact-driver: actual volume nodes differ')
        for offset in range(0, len(mesh['tetrahedra']), 4):
            flattened_elements.append([mapped[_integer(node, 0, len(mapped) - 1)] for node in mesh['tetrahedra'][offset:offset + 4]])
    if flattened_elements != value['elements']:
        raise ValueError('solid-contact-driver: actual volume elements differ')
    material = _object(value['material'], ('youngMPa', 'poisson', 'source'))
    _text(material['source'])
    if _number(material['youngMPa']) <= 0 or not -1 < _number(material['poisson']) < .5:
        raise ValueError('solid-contact-driver: invalid explicit elastic constants')
    steps = _integer(value['steps'], 1, 200)
    maximum = _integer(value['maxIterations'], 1, 2**53 - 1)
    used = set()
    prescribed = _history(value['prescribed'], len(nodes), steps, used)
    loads = _history(value['loads'], len(nodes), steps, used)
    contacts, coverage, patch_ids, physical_slaves = [], set(), set(), set()
    planned = {pair['id']: pair for pair in preparation['plan']['contacts']}
    if len(planned) != len(preparation['plan']['contacts']):
        raise ValueError('solid-contact-driver: duplicate prepared contacts')
    for patch in _array(value['patches'], 1, 100_000):
        _object(patch, ('id', 'contactId', 'masterTriangle', 'slaveTriangle', 'masterBody', 'slaveBody', 'masterFace',
                        'slaveFace', 'masterNodes', 'slaveNodes', 'normal', 'initialGapMm', 'knNPerMm3', 'ktNPerMm3',
                        'referenceLengthMm', 'referenceForceN', 'source', 'mu', 'sourceId'))
        _text(patch['source'])
        if patch['id'] in patch_ids or patch['contactId'] not in planned:
            raise ValueError('solid-contact-driver: repeated/unknown patch')
        patch_ids.add(patch['id'])
        pair = planned[patch['contactId']]
        if (patch['masterBody'] != pair['master']['bodyFeatureId'] or patch['slaveBody'] != pair['slave']['bodyFeatureId']
                or patch['masterFace'] != pair['master']['faceKey'] or patch['slaveFace'] != pair['slave']['faceKey']
                or patch['masterTriangle'] not in pair['master']['triangleIndices']
                or patch['slaveTriangle'] not in pair['slave']['triangleIndices']
                or patch['initialGapMm'] != pair['gapMm'] or patch['mu'] != pair['frictionCoefficient']
                or patch['sourceId'] != pair['frictionSourceId']):
            raise ValueError('solid-contact-driver: patch differs from prepared contact')
        if pair['method'] != 'surface-to-surface' or patch['normal'] != pair['masterNormals'][pair['master']['triangleIndices'].index(patch['masterTriangle'])]:
            raise ValueError('solid-contact-driver: prepared method/normal differs')
        physical_slave = (patch['slaveBody'], patch['slaveTriangle'])
        if physical_slave in physical_slaves:
            raise ValueError('solid-contact-driver: duplicate physical slave facet')
        physical_slaves.add(physical_slave)
        for side in ('master', 'slave'):
            key = (patch['contactId'], side, patch[side + 'Triangle'])
            if key in coverage:
                raise ValueError('solid-contact-driver: repeated integration coverage')
            coverage.add(key)
            mesh = next(item['mesh'] for item in meshes if item['bodyFeatureId'] == patch[side + 'Body'])
            triangle = _integer(patch[side + 'Triangle'], 0, len(mesh['boundaryTriangles']) // 3 - 1)
            if patch[side + 'Nodes'] != mesh['boundaryTriangles'][3 * triangle:3 * triangle + 3]:
                raise ValueError('solid-contact-driver: body-local facet order differs')
        definition = {key: patch[key] for key in ('id', 'masterBody', 'slaveBody', 'masterFace', 'slaveFace',
                      'masterNodes', 'slaveNodes', 'normal', 'initialGapMm', 'knNPerMm3', 'ktNPerMm3',
                      'referenceLengthMm', 'referenceForceN', 'mu', 'sourceId')}
        fixed = FixedContactPatch(definition, nodes, bodies)
        scale = max(math.dist(point, fixed.master[0]) for point in fixed.master)
        matched_vertices = set()
        for point in fixed.slave:
            distance = math.fsum((point[axis] - fixed.master[0][axis]) * fixed.normal[axis] for axis in range(3))
            projected = [point[axis] - distance * fixed.normal[axis] for axis in range(3)]
            matches = [index for index, master_point in enumerate(fixed.master) if math.dist(projected, master_point) <= 1e-10 * scale]
            if len(matches) != 1 or matches[0] in matched_vertices:
                raise ValueError('solid-contact-driver: same-partition full facet mapping required')
            matched_vertices.add(matches[0])
        contacts.append(definition)
    for contact_id, pair in planned.items():
        for side in ('master', 'slave'):
            for triangle in pair[side]['triangleIndices']:
                if (contact_id, side, triangle) not in coverage:
                    raise ValueError('solid-contact-driver: incomplete integration coverage')
    plan = {'nodes': nodes, 'elements': value['elements'], 'bodies': bodies, 'youngMPa': material['youngMPa'],
            'poisson': material['poisson'], 'steps': steps, 'maxIterations': maximum,
            'prescribed': prescribed, 'loads': loads, 'contacts': contacts}
    return value, plan, hashlib.sha256(raw).hexdigest()


def _step_result(record, patches):
    output = []
    for patch in patches:
        native = record['contacts'][patch.identifier]
        points = []
        if set(native['points']) != set(patch.points):
            raise ValueError('solid-contact-driver: incomplete native integration points')
        for index, key in enumerate(patch.points):
            point = native['points'][key]
            law, physical = point['law'], point['physical']
            points.append({'point': index, 'status': law['status'], 'gapMm': physical['gapMm'],
                           'pressureMPa': physical['pressureMPa'], 'normalForceN': physical['normalForceN'],
                           'tangentialForceN': law['tangentialForceN'], 'elasticSlipMm': law['elasticSlipMm'],
                           'addedDissipationNmm': law['addedDissipationNmm'], 'accumulatedDissipationNmm': law['accumulatedDissipationNmm'],
                           'elasticEnergyNmm': law['elasticEnergyNmm'], 'releasedElasticEnergyNmm': law['releasedElasticEnergyNmm'],
                           'areaMm2': physical['areaMm2'], 'pressureGapNPerMm': physical['pressureGapNPerMm'],
                           'forceGapNmm': physical['forceGapNmm'], 'dimensionlessForceGap': physical['dimensionlessForceGap']})
        output.append({'id': patch.identifier, 'normalResultantN': native['normalResultantN'], 'points': points})
    return {**{key: record[key] for key in ('step', 'displacementMm', 'internalForcesN', 'externalForcesN',
                                          'freeResidual', 'nativeEquationCount', 'nativeCallbacks')}, 'patches': output}


def run_from_file(input_path, output_base):
    """Only fixed paths supplied by the runtime call this function."""
    raw = Path(input_path).read_bytes()
    value, plan, input_sha = read_input(raw)
    run = None
    try:
        import oofem as fem
        run = SolidContactRun(fem, plan, output_base)
        steps = [_step_result(solveSolidContactIncrement(run), run.patches) for _ in range(plan['steps'])]
        run.close()
        result = {'kind': 'solid-contact-analysis', 'schema': SCHEMA, 'units': 'N-mm-MPa', 'source': value['source'],
                  'inputSha256': input_sha, 'preparationSha256': value['preparationSha256'], 'iterationLimit': plan['maxIterations'],
                  'nativeIterationCount': None, 'strictComplementarityQualified': False, 'steps': steps}
        return json.dumps({'success': True, 'result': result}, allow_nan=False, separators=(',', ':'))
    except Exception as error:
        if run is not None:
            try:
                run.close()
            except Exception as cleanup:
                error.add_note('Native cleanup also failed: ' + repr(cleanup))
        failure = getattr(error, 'failure', None)
        last = {'failure': failure, 'lastAccepted': run.records[-1] if run is not None and run.records else None}
        # ensure_ascii keeps the character bound identical in Python and JS.
        encoded = json.dumps(last, allow_nan=False, ensure_ascii=True, separators=(',', ':'))
        reason = str(error).encode('unicode_escape').decode('ascii')[:4096].strip() or 'Native contact calculation failed'
        diagnostic = {'schema': SCHEMA, 'inputSha256': input_sha, 'preparationSha256': value['preparationSha256'],
                      'source': value['source'], 'step': failure['step'] if failure is not None else None,
                      'reason': reason, 'iterationLimit': plan['maxIterations'], 'nativeIterationCount': None,
                      'nativeCallbacks': dict(run.counters) if run is not None else None,
                      'rawBeforeFailure': encoded[:32768], 'rawTruncated': len(encoded) > 32768}
        return json.dumps({'success': False, 'diagnostic': diagnostic}, allow_nan=False, separators=(',', ':'))
