"""Exact absolute-tolerance comparisons and finite, three-valued quantifiers.

Imports stay inside the calculation entry points: the dispatch registry can be
inspected without loading the optional, bundled symbolic runtime.
"""

MAX_QUANTIFIER_SAMPLES = 1000


def approximately_equal(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    """a approximately equals b iff |a-b| <= the explicit absolute tolerance."""
    import sympy as s
    from cas_sequences import scalar, sequence_budget

    if len(operands) != 3:
        raise problem('domain', 'Approximate equality requires an explicit absolute tolerance')
    start = len(decoder.domain_conditions)
    with sequence_budget(decoder):
        arguments = [decoder.node(child, scope, depth+1) for child in operands]
        # Reject known invalid types/values in every position before an unknown
        # operand can defer the comparison (and conceal a negative tolerance).
        for argument in arguments:
            if not isinstance(argument, s.Expr) or isinstance(argument, s.MatrixBase):
                raise problem('domain', 'Approximate equality requires scalar operands')
            if argument.is_finite is False or argument.has(s.nan, s.zoo, s.oo, -s.oo):
                raise problem('domain', 'Approximate equality requires finite operands')
        a, b, tolerance = arguments
        if tolerance.is_real is False or tolerance.is_nonnegative is False:
            raise problem('domain', 'The absolute tolerance must be a finite nonnegative real number')
        for argument in arguments:
            scalar(argument, problem)
        if tolerance.is_real is not True or tolerance.is_nonnegative is not True:
            raise problem('unevaluated', 'The absolute tolerance needs established real, nonnegative values')
        if decoder.domain_conditions[start:]:
            raise problem('unevaluated', 'The comparison has unresolved original domain conditions')
        # No binary float, rounding, or implicit relative tolerance participates.
        result = s.Le(s.Abs(a-b), tolerance)
        if result is not s.true and result is not s.false:
            raise problem('unevaluated', 'The absolute difference cannot be compared with the tolerance')
        return result


def finite_quantifier(decoder, value, outer_scope, depth, fields, reference_key, problem):
    """Enumerate original predicates in lexical scope, keeping unknown distinct."""
    import sympy as s
    from sympy.core.relational import Relational
    from sympy.logic.boolalg import BooleanFunction
    from cas_sequences import MAX_WORK, sequence_budget

    bindings = value['bindings']
    if type(bindings) is not list or not 1 <= len(bindings) <= 15:
        raise problem('syntax', 'A quantifier needs between one and fifteen bindings')
    keys = []
    for binding in bindings:
        fields(binding, ('variable', 'domain'))
        key = reference_key(binding['variable'])
        if key[0] != 'bound' or key in keys:
            raise problem('syntax', 'Quantified variables need distinct bound identities')
        domain = binding['domain']
        if type(domain) is not dict or domain.get('kind') != 'set':
            raise problem('syntax', 'A quantifier requires an explicit set domain')
        fields(domain, ('kind', 'value'))
        keys.append(key)
    universal = value['operation'] == 'for-all'
    identity = s.true if universal else s.false
    decisive = s.false if universal else s.true
    samples = 0

    def visit(index, scope):
        nonlocal samples
        decoder.sequence_work += 1
        if decoder.sequence_work > MAX_WORK:
            raise problem('budget', 'Quantifier work exceeds the cumulative calculation budget')
        original_nodes = decoder.nodes
        start = len(decoder.domain_conditions)
        try:
            if index == len(bindings):
                result = decoder.node(value['body'], scope, depth+1)
                if decoder.domain_conditions[start:]:
                    raise problem('unevaluated', 'A quantified predicate has unresolved original conditions')
                if result is s.true or result is s.false:
                    return result
                if isinstance(result, (Relational, BooleanFunction)):
                    return None
                raise problem('domain', 'A quantified predicate must be a proposition, not a scalar')
            # Earlier bindings are visible; this variable is introduced only
            # after its own set has been decoded in the enclosing scope.
            domain = decoder.node(bindings[index]['domain']['value'], scope, depth+1)
            if not isinstance(domain, s.Set):
                raise problem('domain', 'A quantifier domain must be a set')
            if decoder.domain_conditions[start:]:
                raise problem('unevaluated', 'A quantifier set has unresolved original conditions')
            # The bundled runtime does not advertise EmptySet as iterable.
            # Its quantifiers nevertheless have exact vacuous truth values.
            if domain.is_empty is True:
                return identity
            if domain.is_finite_set is not True or domain.is_iterable is not True:
                raise problem('unevaluated', 'Only explicitly enumerable finite sets can be quantified')
            if isinstance(domain, s.FiniteSet) and len(domain) > MAX_QUANTIFIER_SAMPLES:
                raise problem('budget', 'A quantifier exceeds one thousand finite samples')
            result = identity
            for element in domain:
                samples += 1
                if samples > MAX_QUANTIFIER_SAMPLES:
                    raise problem('budget', 'A quantifier exceeds one thousand finite samples')
                nested = dict(scope)
                nested[keys[index]] = element
                try:
                    term = visit(index+1, nested)
                except problem as error:
                    if error.code != 'unevaluated':
                        raise
                    term = None
                # Keep checking after a witness/counterexample: later original
                # predicates may contain undefined operands or exceed a budget.
                if term is decisive:
                    result = decisive
                elif term is None and result is not decisive:
                    result = None
            if decoder.domain_conditions[start:]:
                raise problem('unevaluated', 'The quantifier has unresolved original domain conditions')
            return result
        finally:
            # Structural limits apply to each source evaluation. Repetition and
            # nested indexed calculations share sequence_work and size guards.
            decoder.nodes = original_nodes

    with sequence_budget(decoder):
        result = visit(0, dict(outer_scope))
    if result is None:
        raise problem('unevaluated', 'The finite quantifier still has an undecided predicate')
    return result


IMPLEMENTATIONS = {'approximately-equal': approximately_equal}
QUANTIFIERS = {'for-all': finite_quantifier, 'exists': finite_quantifier}
