"""Enumerate finite ranges containing indexed operations without losing lexical scope."""
import sympy as s
from cas_sequences import OPERATIONS, MAX_STEPS, MAX_WORK, sequence_budget, scalar


def contains_sequence(value):
    pending = [value]
    remaining = 16384
    while pending:
        remaining -= 1
        if remaining < 0:
            # Decoder will reject the structure using its ordinary node budget.
            return True
        item = pending.pop()
        if type(item) is dict:
            if item.get('kind') == 'operation' and item.get('operation') in OPERATIONS:
                return True
            pending.extend(item.values())
        elif type(item) is list:
            pending.extend(item)
    return False


def finite_sequence_range(decoder, value, outer_scope, depth, fields, reference_key, problem):
    bindings = value['bindings']
    keys = []
    for binding in bindings:
        fields(binding, ('variable', 'domain'))
        key = reference_key(binding['variable'])
        if key[0] != 'bound' or key in keys:
            raise problem('syntax', 'Invalid or duplicate bound identity')
        fields(binding['domain'], ('kind', 'lower', 'upper', 'step'))
        if binding['domain']['kind'] != 'range':
            raise problem('syntax', 'An indexed calculation requires explicit ranges')
        keys.append(key)
    product = value['operation'] == 'product'

    def visit(index, scope):
        decoder.sequence_work += 1
        if decoder.sequence_work > MAX_WORK:
            raise problem('budget', 'Indexed range work exceeds the cumulative budget')
        original_nodes = decoder.nodes
        start = len(decoder.domain_conditions)
        try:
            if index == len(bindings):
                result = scalar(decoder.node(value['body'], scope, depth+1), problem)
                if decoder.domain_conditions[start:]:
                    raise problem('unevaluated', 'An indexed term has unresolved original conditions')
                return result
            domain = bindings[index]['domain']
            # Bounds see the enclosing scope, not the variable they introduce.
            lower = decoder.node(domain['lower'], scope, depth+1)
            upper = decoder.node(domain['upper'], scope, depth+1)
            step = s.S.One if domain['step'] is None else decoder.node(domain['step'], scope, depth+1)
            if not isinstance(step, s.Integer) or step <= 0:
                raise problem('domain', 'A discrete step must be a positive integer')
            if any(not isinstance(bound, s.Integer) and bound not in (s.oo, -s.oo) for bound in (lower, upper)):
                raise problem('domain', 'Exact integer range bounds are required')
            if decoder.domain_conditions[start:]:
                raise problem('unevaluated', 'Range bounds have unresolved original conditions')
            if lower is s.oo or upper is -s.oo:
                return s.S.One if product else s.S.Zero
            if lower is -s.oo or upper is s.oo:
                raise problem('unevaluated', 'An infinite indexed range needs a convergence proof')
            if not isinstance(lower, s.Integer) or not isinstance(upper, s.Integer):
                raise problem('domain', 'Finite exact integer range bounds are required')
            count = max(0, (int(upper)-int(lower))//int(step)+1)
            if count > MAX_STEPS:
                raise problem('budget', 'An indexed range exceeds 4096 terms')
            result = s.S.One if product else s.S.Zero
            for offset in range(count):
                nested = dict(scope)
                nested[keys[index]] = lower+offset*step
                term = visit(index+1, nested)
                # Do not short circuit a zero product: later original terms may fail.
                result = scalar(result*term if product else result+term, problem)
            return result
        finally:
            decoder.nodes = original_nodes

    with sequence_budget(decoder):
        return visit(0, dict(outer_scope))
