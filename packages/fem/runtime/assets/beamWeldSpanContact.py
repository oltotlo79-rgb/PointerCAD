"""Internal straight-span layer plus the existing contact solve, no bolt/prestrain.

nativeK comes from run_beam_contact(contact, solve_system=callback); this pure
entry does not itself run native OOFEM. Old contact /1 records remain node-only.
"""
import copy
from beamContact import validate_contact_plan, _solve_contact_system, _symmetric
from beamWeldSpan import WeldSpanKernel, _data

PLAN_SCHEMA = 'pointercad-weld-span-plan/1'
RESULT_SCHEMA = 'pointercad-weld-span-result/1'


def solve_weld_span_contact_system(np, plan, nativeK, momentLength):
    if not _data(plan) or type(plan) is not dict or set(plan) != {'schema', 'contact', 'patches'} or plan['schema'] != PLAN_SCHEMA:
        raise ValueError('weld-span-contact: unsupported plan; bolt and initial strain are not implicit')
    owned = copy.deepcopy(plan)
    contact = owned['contact']
    expected_length = validate_contact_plan(contact)
    if type(momentLength) not in (int, float) or momentLength != expected_length:
        raise ValueError('weld-span-contact: native moment length mismatch')
    mesh = {key: contact[key] for key in ('nodes', 'members', 'materials', 'sections', 'originalNodeCount')}
    kernel = WeldSpanKernel({'mesh': mesh, 'patches': owned['patches']})
    size = 6*len(contact['nodes'])
    native = np.array(nativeK, dtype=float, copy=True)
    if native.shape != (size, size) or not np.isfinite(native).all():
        raise ValueError('weld-span-contact: invalid native matrix shape or finite values')
    native = _symmetric(np, native, 'native span stiffness', allow_zero=True)
    # Native elastic K can have rigid-body null modes, but must not have a
    # negative energy mode that a positive layer could otherwise conceal.
    scale = float(np.linalg.norm(native, ord=np.inf))
    if np.min(np.linalg.eigvalsh(native)) < -np.finfo(float).eps*size*scale*64:
        raise ValueError('weld-span-contact: negative native stiffness')
    stiffness = native + np.array(kernel.stiffness, dtype=float)
    if not np.isfinite(stiffness).all():
        raise ValueError('weld-span-contact: nonfinite combined stiffness')
    captures = []

    def capture(load_factor, full):
        index = len(captures)
        if index >= len(contact['loadFactors']) or load_factor != contact['loadFactors'][index]:
            raise ValueError('weld-span-contact: full state load factor/order mismatch')
        vector = np.array(full, dtype=float, copy=True)
        if vector.shape != (size,) or not np.isfinite(vector).all():
            raise ValueError('weld-span-contact: missing/nonfinite full mesh state')
        if any(fixed and vector[6*i+axis] != 0 for i, node in enumerate(contact['nodes'])
               for axis, fixed in enumerate(node['restrained'])):
            raise ValueError('weld-span-contact: full state violates support')
        captures.append((load_factor, vector))

    old_result = _solve_contact_system(np, contact, stiffness, momentLength, capture_full_state=capture)
    if (len(captures) != len(contact['loadFactors']) or old_result.get('schema') != 'pointercad-oofem-contact-result/1'
            or len(old_result['states']) != len(captures)):
        raise ValueError('weld-span-contact: missing full mesh captures or contact states')
    states = []
    for (factor, full), old in zip(captures, old_result['states'], strict=True):
        if old['loadFactor'] != factor or len(old['nodes']) != contact['originalNodeCount']:
            raise ValueError('weld-span-contact: contact ownership/order changed')
        motions = full.reshape(len(contact['nodes']), 6).tolist()
        records = [{'number': node['number'], 'displacementM': motion[:3], 'rotationRad': motion[3:]}
                   for node, motion in zip(contact['nodes'], motions, strict=True)]
        states.append({'loadFactor': factor, 'meshNodes': records, 'welds': kernel.evaluate(motions)})
    return {'schema': RESULT_SCHEMA, 'contact': old_result, 'states': states}


def run_beam_weld_span_contact():
    """Fixed runtime entry; validate the owned plan before native assembly."""
    import json
    from beamContact import run_beam_contact
    with open('/pcad_fem/weld-span-contact-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    if not _data(plan) or type(plan) is not dict or set(plan) != {'schema', 'contact', 'patches'} or plan['schema'] != PLAN_SCHEMA:
        raise ValueError('weld-span-contact: unsupported runtime plan')
    owned = copy.deepcopy(plan)
    validate_contact_plan(owned['contact'])
    mesh = {key: owned['contact'][key] for key in ('nodes', 'members', 'materials', 'sections', 'originalNodeCount')}
    WeldSpanKernel({'mesh': mesh, 'patches': owned['patches']})
    return run_beam_contact(plan=owned['contact'], solve_system=lambda np, unused, stiffness, length:
                            solve_weld_span_contact_system(np, owned, stiffness, length))
