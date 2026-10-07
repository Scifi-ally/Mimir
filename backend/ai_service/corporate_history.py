"""Validate retained corporate windows for exploratory historical research."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path

from corporate_accounting import decode_action


def corporate_digest(value: dict) -> str:
    return hashlib.sha256(json.dumps({k: v for k, v in value.items() if k != "sha256"}, sort_keys=True, allow_nan=False).encode()).hexdigest()


def load_frozen_corporate(directory: Path, research: dict) -> dict | None:
    expected = research["specification"].get("corporate_history_sha256")
    if expected is None:
        return None
    value = json.loads((directory / (research["experiment_id"] + ".corporate.json")).read_text(encoding="utf-8"))
    if corporate_digest(value) != expected or value.get("sha256") != expected:
        raise ValueError("Frozen corporate research inputs changed")
    return value


def load_corporate_history(directory: Path, start: str, end: str, additional_directory=None) -> dict:
    # Local import avoids the archive/strategy CLI module initialization cycle.
    from nse_corporate_archive import load_corporate_receipt
    windows = {}
    for root in [directory] + ([additional_directory] if additional_directory is not None else []):
        for path in (root / "corporate_receipts").glob("*.json"):
            receipt = load_corporate_receipt(root, path.stem)
            received = datetime.fromisoformat(receipt["observed_at"])
            if received.tzinfo is None:
                raise ValueError("Timezone-aware corporate receipt required")
            key = (receipt["from"], receipt["to"])
            if key not in windows or received > datetime.fromisoformat(windows[key]["observed_at"]):
                windows[key] = receipt
    cursor = datetime.fromisoformat(start).date()
    last = datetime.fromisoformat(end).date()
    if cursor > last:
        raise ValueError("Chronological corporate coverage required")
    identities, metadata, sources = {}, {}, []
    for (first, final), receipt in sorted(windows.items()):
        lower, upper = datetime.fromisoformat(first).date(), datetime.fromisoformat(final).date()
        if upper < datetime.fromisoformat(start).date() or lower > last:
            continue
        if lower > cursor:
            raise ValueError("Historical corporate response window has a gap")
        cursor = max(cursor, upper + timedelta(days=1))
        sources.append({"from": first, "to": final, "sha256": receipt["sha256"], "observed_at": receipt["observed_at"]})
        for event in receipt["events"]:
            if not start <= event["ex_date"] <= end:
                continue
            content = {k: event[k] for k in ("isin", "ex_date", "purpose")}
            event_id = corporate_digest(content)
            if event_id in metadata:
                for field in ("record_date_reported", "reported_broadcast_date"):
                    previous, current = metadata[event_id].get(field), event.get(field)
                    if previous not in (None, "", "-") and current not in (None, "", "-") and previous != current:
                        raise ValueError("Conflicting historical corporate metadata")
            metadata[event_id] = {**metadata.get(event_id, {}),
                **{key: value for key, value in event.items() if value not in (None, "", "-")}}
            identities[event_id] = {**content, "event_id": event_id}
    if cursor <= last:
        raise ValueError("Historical corporate response coverage incomplete")
    events = sorted(identities.values(), key=lambda e: (e["ex_date"], e["isin"], e["purpose"]))
    result = {"from": start, "to": end, "events": events, "receipts": sources,
              "response_window_coverage_verified": True, "event_omissions_independently_verified": False,
              "historical_announcement_times_verified": False, "settlement_times_verified": False,
              "term_counts": dict(Counter(decode_action(e["purpose"])["kind"] for e in events))}
    result["sha256"] = corporate_digest(result)
    return result
