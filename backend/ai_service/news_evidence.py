"""Publication-time eligibility for free RSS data; no predicted price claims."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import re


def eligible_headlines(items, now=None, max_age_hours=72):
    now = now or datetime.now(timezone.utc)
    valid, seen = [], set()
    for item in items:
        title = re.sub(r"\s+", " ", str(item.get("title", "")).strip())
        key = title.casefold()
        if not title or key in seen:
            continue
        try:
            published = parsedate_to_datetime(item.get("pub_date", ""))
            if published.tzinfo is None:
                continue
            age = (now - published).total_seconds() / 3600
            if age < 0 or age > max_age_hours:
                continue
        except (TypeError, ValueError, OverflowError):
            continue
        seen.add(key)
        valid.append({**item, "title": title, "observed_at": published.astimezone(timezone.utc).isoformat()})
    return valid


def news_evidence(items, source, classifier_available, now=None):
    now = now or datetime.now(timezone.utc)
    valid = eligible_headlines(items, now)
    return {"available": bool(valid) and classifier_available, "source": source,
            "kind": "classifier_score_not_return_probability", "headline_count": len(valid),
            "observed_at": max((item["observed_at"] for item in valid), default=None),
            "available_at": now.isoformat(), "max_age_hours": 72,
            "predictive_validation": "not_established"}
