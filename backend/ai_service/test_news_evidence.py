from datetime import datetime, timezone
from news_evidence import eligible_headlines, news_evidence

NOW = datetime(2026, 10, 4, 10, 0, tzinfo=timezone.utc)


def test_news_rejects_missing_dates_future_dates_stale_and_duplicates():
    items = [
        {"title": "Recorded earnings released", "pub_date": "Sun, 04 Oct 2026 09:00:00 +0000"},
        {"title": " RECORDED   EARNINGS RELEASED ", "pub_date": "Sun, 04 Oct 2026 09:00:00 +0000"},
        {"title": "Unknown time", "pub_date": ""},
        {"title": "Future leak", "pub_date": "Sun, 04 Oct 2026 11:00:00 +0000"},
        {"title": "Stale", "pub_date": "Mon, 28 Sep 2026 09:00:00 +0000"},
    ]
    valid = eligible_headlines(items, NOW)
    assert len(valid) == 1
    assert valid[0]["observed_at"] == "2026-10-04T09:00:00+00:00"


def test_feed_and_classifier_availability_are_independently_required():
    item = {"title": "Recorded story", "pub_date": "Sun, 04 Oct 2026 09:00:00 +0000"}
    assert news_evidence([], "actual RSS", True, NOW)["available"] is False
    assert news_evidence([item], "actual RSS", False, NOW)["available"] is False
    evidence = news_evidence([item], "actual RSS", True, NOW)
    assert evidence["available"] is True
    assert evidence["available_at"] >= evidence["observed_at"]
    assert evidence["predictive_validation"] == "not_established"
