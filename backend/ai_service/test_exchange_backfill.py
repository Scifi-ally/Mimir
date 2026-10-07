from datetime import date
from urllib.error import HTTPError

import pytest

import exchange_backfill as module


def test_resumable_collection_marks_missing_files_without_imputation(tmp_path, monkeypatch):
    def collect(directory, day):
        if day.day == 6:
            raise HTTPError("official-source", 404, "missing", {}, None)
        return {"date": day.isoformat()}
    monkeypatch.setattr(module, "collect_session", collect)
    monkeypatch.setattr(module.time, "sleep", lambda *_: None)
    result = module.backfill(tmp_path, date(2026, 1, 5), date(2026, 1, 7))
    assert result["verified_sessions"] == 2
    assert result["state"] == "completed_with_gaps"
    assert result["missing_or_unavailable"][0]["date"] == "2026-01-06"
    assert not result["point_in_time_receipts_verified"]
    assert not (tmp_path / "collector.lock").exists()
    assert not (tmp_path / "backfill.lock").exists()


def test_denied_source_stops_without_retry_storm(tmp_path, monkeypatch):
    def collect(*_):
        raise HTTPError("official-source", 429, "rate-limited", {}, None)
    monkeypatch.setattr(module, "collect_session", collect)
    with pytest.raises(ValueError, match="stopped without bypass"):
        module.backfill(tmp_path, date(2026, 1, 5), date(2026, 1, 7))
    assert not (tmp_path / "backfill.lock").exists()
