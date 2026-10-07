from datetime import date

import pytest

from corporate_accounting import apply_event, decode_action, empty_ledger
from nse_corporate_archive import validate_events
from test_corporate_accounting import holding, event


def test_fully_stated_cash_dividends_with_meeting_prefix_are_not_lost():
    terms = decode_action("Annual General Meeting/Dividend - Rs 4 Per Share/ Special Dividend - Rs 8 Per Share")
    assert terms == {"kind": "dividend", "cash_per_share": 12.0}
    ledger, _ = apply_event(empty_ledger(), holding(), event("Annual General Meeting/Dividend - Rs 4 Per Share"), "2026-10-01")
    assert ledger["entitlements"][0]["amount"] == 400
    assert ledger["settled_cash"] == 0


def test_meeting_notice_has_no_share_or_cash_entitlement():
    ledger, position = apply_event(empty_ledger(), holding(), event("ExtraOrdinaryGeneralMeeting"), "2026-10-01")
    assert position == holding()
    assert not ledger["entitlements"] and not ledger["review_failures"]
    for purpose in ("AGM/Dividend 150%", "Dividend - Rs 1 Per Share/Bonus 1:1", "AGM/Unknown terms", "Dividend - Rs 1 Per Share/Dividend - Rs 1 Per Share"):
        assert decode_action(purpose)["kind"] == "unsupported"


def test_only_complementary_meeting_metadata_can_be_merged_without_losing_raw_variants():
    row = dict(series="EQ", exDate="23-Dec-2024", isin="INE369C01017", symbol="NORBTEAEXP",
               subject="ExtraOrdinaryGeneralMeeting", recDate="23-Dec-2024", bcStartDate="-", bcEndDate="-")
    other = {**row, "recDate": "-", "bcStartDate": "24-Dec-2024", "bcEndDate": "30-Dec-2024"}
    parsed = validate_events([row, other], date(2024, 7, 1), date(2025, 6, 30))
    assert len(parsed) == 1
    assert parsed[0]["record_date_reported"] == "23-Dec-2024"
    assert parsed[0]["source_metadata_variants"] == [row, other]
    with pytest.raises(ValueError, match="Conflicting"):
        validate_events([row, {**other, "recDate": "24-Dec-2024"}], date(2024, 7, 1), date(2025, 6, 30))
