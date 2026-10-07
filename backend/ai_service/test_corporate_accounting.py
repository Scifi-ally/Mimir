import pytest

from corporate_accounting import apply_event, decode_action, empty_ledger, settle_cash, settle_shares


def holding():
    return dict(isin="INE203G01019", entry_date="2026-09-30", quantity=100, entry=100.0, stop=95.0, reference=100.0)


def event(purpose):
    return dict(event_id="actual-event", isin="INE203G01019", ex_date="2026-10-01", purpose=purpose)


def test_dividend_is_receivable_not_spendable_cash_and_not_fake_stop_loss():
    original = holding()
    ledger, position = apply_event(empty_ledger(), original, event("Dividend - Rs 1.50 Per Share"), "2026-10-01")
    assert ledger["settled_cash"] == 0
    assert position["dividend_entitlement"] == 150
    assert position["stop"] == 93.5
    assert original["stop"] == 95
    assert apply_event(ledger, position, event("Dividend - Rs 1.50 Per Share"), "2026-10-01") == (ledger, position)


def test_exdate_buyer_has_no_dividend_entitlement():
    position = {**holding(), "entry_date": "2026-10-01"}
    assert apply_event(empty_ledger(), position, event("Dividend - Rs 1.50 Per Share"), "2026-10-01") == (empty_ledger(), position)


def test_share_event_does_not_make_undelivered_shares_tradable():
    ledger, position = apply_event(empty_ledger(), holding(), event("BONUS 1:1"), "2026-10-01")
    assert ledger["entitlements"][0]["total_shares_after"] == "200"
    assert position["quantity"] == 100
    assert position["corporate_delivery_pending"]
    assert ledger["review_failures"]
    assert position["stop"] == 47.5


def test_split_ratio_and_complex_terms_remain_explicit():
    assert decode_action("FVSPLT FRM RS 10 TO RS 2")["share_multiplier"] == "5"
    for purpose in ("DEMERGER", "RGHTS 2:21 @PRM RS 748/-", "DIVIDEND 150%", "Dividend + Bonus 1:1"):
        ledger, _ = apply_event(empty_ledger(), holding(), event(purpose), "2026-10-01")
        assert ledger["review_failures"][0]["reason"] == "unsupported_corporate_terms"


def test_settlement_requires_actual_cash_proof_and_is_idempotent():
    ledger, _ = apply_event(empty_ledger(), holding(), event("DIV - RS 1.50 PER SH"), "2026-10-01")
    with pytest.raises(ValueError):
        settle_cash(ledger, "actual-event", 150, {}, "2026-10-02")
    proof = dict(verified=True, source="broker_cash_statement", receipt_sha256="retained-receipt", date="2026-10-02")
    paid = settle_cash(ledger, "actual-event", 135, proof, "2026-10-02")
    assert paid["settled_cash"] == 135  # Actual credit may differ due to withholding.
    assert settle_cash(paid, "actual-event", 135, proof, "2026-10-02") == paid
    with pytest.raises(ValueError):
        settle_cash(paid, "actual-event", 150, proof, "2026-10-02")


def test_verified_share_credit_conserves_entry_cost_and_releases_only_once():
    ledger, position = apply_event(empty_ledger(), holding(), event("BONUS 1:1"), "2026-10-01")
    proof = dict(verified=True, source="broker_demat_statement", receipt_sha256="unit-test-receipt", date="2026-10-02")
    with pytest.raises(ValueError):
        settle_shares(ledger, position, "actual-event", 200, {}, "2026-10-02")
    ledger, position = settle_shares(ledger, position, "actual-event", 200, proof, "2026-10-02")
    assert position["quantity"] * position["entry"] == 10000
    assert not position["corporate_delivery_pending"]
    assert not ledger["review_failures"]
    assert settle_shares(ledger, position, "actual-event", 200, proof, "2026-10-02") == (ledger, position)


def test_fractional_entitlement_cannot_be_rounded_to_create_tradable_shares():
    ledger, position = apply_event(empty_ledger(), {**holding(), "quantity": 101}, event("BONUS 1:2"), "2026-10-01")
    assert ledger["entitlements"][0]["total_shares_after"] == "303/2"
    proof = dict(verified=True, source="broker_demat_statement", receipt_sha256="unit-test-receipt", date="2026-10-02")
    for quantity in (151, 152):
        with pytest.raises(ValueError):
            settle_shares(ledger, position, "actual-event", quantity, proof, "2026-10-02")
