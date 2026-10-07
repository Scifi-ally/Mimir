import copy

from delivery_cost_study import reproduce_upstox


def reference():
    return {"development": [{"strategy": "known", "statistics": {"total_return_pct": -2., "trades": 4,
        "max_drawdown_pct": -3., "fees_inr": 12.}, "missing_held_position_sessions": 0}]}


def test_fee_comparison_must_reproduce_current_broker_before_other_profiles_are_trusted():
    old = reference()
    trials = [{**copy.deepcopy(old["development"][0]), "fee_profile": "upstox_delivery"}]
    assert reproduce_upstox(old, trials) == []
    trials[0]["statistics"]["total_return_pct"] = 20
    assert reproduce_upstox(old, trials) == ["known:total_return_pct"]
    trials[0]["fee_profile"] = "dhan_delivery"
    assert reproduce_upstox(old, trials) == ["known:statistics_availability"]
