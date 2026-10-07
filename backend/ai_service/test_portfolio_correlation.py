import numpy as np
import pandas as pd

from portfolio_research import correlated_or_unknown


def test_sparse_pair_check_matches_reference_full_matrix_with_gaps():
    random = np.random.default_rng(73)
    base = random.normal(size=60)
    window = pd.DataFrame(dict(A=base, B=base + random.normal(scale=.1, size=60), C=random.normal(size=60), D=-base))
    window.loc[3:8, "B"] = np.nan
    reference = window.corr(min_periods=40)
    for name in ("B", "C", "D"):
        assert correlated_or_unknown(window, name, ["A"]) == (reference.loc[name, "A"] > .8)
    assert not correlated_or_unknown(window, "A", [])


def test_insufficient_overlap_missing_symbol_or_constant_returns_fail_closed():
    window = pd.DataFrame(dict(A=np.arange(60), B=np.ones(60)))
    assert correlated_or_unknown(window, "B", ["A"])
    assert correlated_or_unknown(window.iloc[:39], "A", ["B"])
    assert correlated_or_unknown(window, "unknown", ["A"])
