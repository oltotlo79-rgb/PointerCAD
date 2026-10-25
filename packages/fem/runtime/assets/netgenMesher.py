"""Fixed native Netgen PLC adapter. Input is data, never Python source.

Only caller-validated planar, closed single-domain contracts are enabled.
PLC2 permits concavity, through-holes and negatively oriented cavity shells.
No OCC plugin, implicit geometry construction, material or load assignment.
"""
import json
import math


def read_meshing_controls(value):
    if (type(value) is not dict
            or set(value) != {'targetSizeMm', 'grading', 'maximumOptimizationPasses', 'quality'}):
        raise ValueError('tetra-mesh: meshing controls schema')
    size, grading, passes = value['targetSizeMm'], value['grading'], value['maximumOptimizationPasses']
    quality = value['quality']
    if (type(size) not in (int, float) or not math.isfinite(size) or not 0 < size <= 1e9
            or type(grading) not in (int, float) or not math.isfinite(grading) or not 0 < grading <= 1
            or type(passes) is not int or not 0 <= passes <= 3):
        raise ValueError('tetra-mesh: bounded meshing controls required')
    if type(quality) is not dict or set(quality) != {'minimumMeanRatio', 'maximumEdgeRatio'}:
        raise ValueError('tetra-mesh: meshing quality schema')
    minimum, maximum = quality['minimumMeanRatio'], quality['maximumEdgeRatio']
    if (type(minimum) not in (int, float) or not math.isfinite(minimum) or not 0 <= minimum <= 1
            or type(maximum) not in (int, float) or not math.isfinite(maximum) or maximum < 1):
        raise ValueError('tetra-mesh: meshing quality limits')
    return size, grading, passes, minimum, maximum


def meets_quality(result, minimum, maximum):
    xyz, cells = result['coordinates'], result['tetrahedra']
    accepted = True
    for offset in range(0, len(cells), 4):
        points = [xyz[3 * node:3 * node + 3] for node in cells[offset:offset + 4]]
        edges = [tuple(points[j][k] - points[i][k] for k in range(3))
                 for i, j in ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))]
        if any(not math.isfinite(component) for edge in edges for component in edge):
            raise ValueError('tetra-mesh: unrepresentable quality difference')
        scale = max(abs(component) for edge in edges for component in edge)
        if scale <= 0:
            raise ValueError('tetra-mesh: zero quality extent')
        normalized = [tuple(component / scale for component in edge) for edge in edges]
        u, v, w = normalized[:3]
        determinant = (u[0] * (v[1] * w[2] - v[2] * w[1])
                       - u[1] * (v[0] * w[2] - v[2] * w[0])
                       + u[2] * (v[0] * w[1] - v[1] * w[0]))
        lengths = [math.hypot(*edge) for edge in normalized]
        shortest = min(lengths)
        if determinant <= 0 or shortest <= 0:
            raise ValueError('tetra-mesh: unresolved quality orientation or edge')
        mean_ratio = 12 * math.cbrt(determinant / 2) ** 2 / sum(
            component * component for edge in normalized for component in edge)
        edge_ratio = max(lengths) / shortest
        if not math.isfinite(mean_ratio) or not math.isfinite(edge_ratio) or mean_ratio <= 0:
            raise ValueError('tetra-mesh: unrepresentable native quality')
        accepted = accepted and mean_ratio >= minimum and edge_ratio <= maximum
    return accepted


def run_tetra_mesh():
    from netgen import config
    from netgen.meshing import Mesh, MeshPoint, Pnt, FaceDescriptor, Element2D, MeshingParameters

    if (config.NETGEN_VERSION_GIT != "v6.2.2606-5-g654ed121"
            or config.NETGEN_VERSION_PYTHON != "6.2.2606.post5.dev0"
            or config.USE_OCC is not False or config.USE_MPI is not False
            or config.USE_GUI is not False
            or config.PYTHON_VERSION.split(".")[:2] != ["3", "13"]):
        raise ValueError("tetra-mesh: unexpected native build identity")
    with open('/pcad_fem/tetra-input.json', encoding='utf-8') as handle:
        data = json.load(handle)
    planar = data.get('schema') == 'pointercad-plc/2'
    fields = {'schema', 'source', 'units', 'coordinates', 'triangles', 'tags', 'tagCount'}
    if planar:
        fields.add('shells')
    controls = None
    if 'meshing' in data:
        fields.add('meshing')
        controls = read_meshing_controls(data['meshing'])
    if (set(data) != fields or data['units'] != 'mm'
            or (not planar and data['schema'] != 'pointercad-convex-plc/1')):
        raise ValueError('tetra-mesh: input schema')
    xyz, flat, tags, count = data['coordinates'], data['triangles'], data['tags'], data['tagCount']
    if (not 12 <= len(xyz) <= 3072 or len(xyz) % 3 or not 12 <= len(flat) <= 6144
            or len(flat) % 3 or len(tags) != len(flat) // 3
            or type(count) is not int or not (1 if planar else 4) <= count <= len(tags)
            or any(type(x) not in (int, float) or not math.isfinite(x) for x in xyz)
            or any(type(n) is not int or not 0 <= n < len(xyz) // 3 for n in flat)
            or any(type(tag) is not int or not 0 <= tag < count for tag in tags)):
        raise ValueError('tetra-mesh: invalid bounded PLC arrays')
    if planar:
        shells = data['shells']
        if type(shells) is not list or not 1 <= len(shells) <= len(flat) // 12:
            raise ValueError('tetra-mesh: bounded shell table required')
        seen, previous, outer_count = set(), -1, 0
        for shell in shells:
            if (type(shell) is not dict or set(shell) != {'role', 'triangles'}
                    or shell['role'] not in ('outer', 'cavity')
                    or type(shell['triangles']) is not list or len(shell['triangles']) < 4):
                raise ValueError('tetra-mesh: shell schema')
            members = shell['triangles']
            if (any(type(n) is not int or not 0 <= n < len(flat) // 3 for n in members)
                    or any(a >= b for a, b in zip(members, members[1:]))
                    or members[0] <= previous or seen.intersection(members)):
                raise ValueError('tetra-mesh: shell partition')
            seen.update(members)
            previous = members[0]
            outer_count += shell['role'] == 'outer'
        if len(seen) != len(flat) // 3 or outer_count != 1:
            raise ValueError('tetra-mesh: incomplete single-domain shell partition')
    original_points = [tuple(xyz[i:i + 3]) for i in range(0, len(xyz), 3)]
    mesh = Mesh(dim=3)
    try:
        ids = [mesh.Add(MeshPoint(Pnt(*p))) for p in original_points]
        # All supplied triangles point out of material. Cavity normals point
        # into the void: do not reverse them or create a second material domain.
        descriptors = [mesh.Add(FaceDescriptor(surfnr=i + 1, domin=1, domout=0, bc=i + 1))
                       for i in range(count)]
        for offset in range(0, len(flat), 3):
            mesh.Add(Element2D(index=descriptors[tags[offset // 3]],
                               vertices=[ids[n] for n in flat[offset:offset + 3]]))
        before = [(int(e.index), tuple(v.nr for v in e.vertices)) for e in mesh.Elements2D()]
        def snapshot():
            points = [tuple(float(x) for x in p.p) for p in mesh.Points()]
            elements = [(int(e.index), tuple(v.nr - 1 for v in e.vertices)) for e in mesh.Elements3D()]
            boundary = [(int(e.index), tuple(v.nr for v in e.vertices)) for e in mesh.Elements2D()]
            descriptor_values = [(fd.surfnr, fd.domin, fd.domout, fd.bc) for fd in mesh.FaceDescriptors()]
            if (not elements or len(points) > 10000 or len(elements) > 50000
                    or points[:len(original_points)] != original_points or boundary != before
                    or descriptor_values != [(i, 1, 0, i) for i in range(1, count + 1)]):
                raise ValueError('tetra-mesh: native boundary, labels or bounds changed')
            tetrahedra = []
            orientation = None
            for domain, nodes in elements:
                if domain != 1 or len(nodes) != 4 or len(set(nodes)) != 4 or any(n < 0 or n >= len(points) for n in nodes):
                    raise ValueError('tetra-mesh: native element topology')
                a, b, c, d = [points[n] for n in nodes]
                u, v, w = ([p[k] - a[k] for k in range(3)] for p in (b, c, d))
                det = (u[0] * (v[1] * w[2] - v[2] * w[1])
                       - u[1] * (v[0] * w[2] - v[2] * w[0])
                       + u[2] * (v[0] * w[1] - v[1] * w[0]))
                if not math.isfinite(det) or abs(det) <= 1e-15:
                    raise ValueError('tetra-mesh: native degenerate element')
                sign = 1 if det > 0 else -1
                if orientation is not None and sign != orientation:
                    raise ValueError('tetra-mesh: inconsistent native element orientation')
                orientation = sign
                # One explicit permutation converts the native convention to the public positive convention.
                tetrahedra.extend(nodes if sign > 0 else (nodes[1], nodes[0], nodes[2], nodes[3]))
            return {'coordinates': [x for p in points for x in p], 'tetrahedra': tetrahedra,
                    'boundaryTriangles': [n - 1 for _, nodes in boundary for n in nodes],
                    'boundaryTags': [tag - 1 for tag, _ in boundary]}

        if controls is None:
            # Preserve Netgen's actual default generation and optimization sequence.
            mesh.GenerateVolumeMesh()
            return json.dumps(snapshot(), allow_nan=False, separators=(',', ':'))
        size, grading, passes, minimum, maximum = controls
        mesh.GenerateVolumeMesh(maxh=size, grading=grading, optsteps3d=0)
        for attempt in range(passes + 1):
            result = snapshot()
            if meets_quality(result, minimum, maximum):
                return json.dumps(result, allow_nan=False, separators=(',', ':'))
            if attempt < passes:
                # Continue this mesh, never regenerate identical input or restart the Worker deadline.
                mesh.OptimizeVolumeMesh(MeshingParameters(maxh=size, grading=grading,
                                                          optimize3d='ms', optsteps3d=1))
        raise ValueError('tetra-mesh: quality target unmet after bounded optimization')
    finally:
        # Release the Python holder; the existing one-shot Worker owns interpreter/native termination.
        # This does not claim unloading the native module inside a still-running interpreter.
        del mesh
