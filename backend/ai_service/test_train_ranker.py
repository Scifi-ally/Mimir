"""Regression tests for leakage-safe learned-ranker training windows."""

import sys
import unittest
from pathlib import Path

# Support both `python test_train_ranker.py` from this directory and the
# repository-root test invocation used by CI.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_ranker import _timestamp_ms, purged_chronological_split


def row(day: int, resolution_day: int, suffix: int) -> dict:
    return {
        "ts": f"2026-01-{day:02d}T09:15:00+05:30",
        "resolutionTs": f"2026-01-{resolution_day:02d}T15:30:00+05:30",
        "features": [float(suffix)],
        "label": suffix % 2,
        "retPct": 0.1,
    }


class PurgedChronologicalSplitTests(unittest.TestCase):
    def test_keeps_timestamp_groups_together_and_purges_overlapping_outcomes(self) -> None:
        # Seven entry days, two simultaneous candidates each. The first pair
        # resolves after the train/calibration boundary and must not teach the
        # calibration-period model anything about that future outcome.
        rows = []
        for day in range(1, 8):
            resolution_day = 5 if day == 1 else day
            rows.extend([row(day, resolution_day, day * 10), row(day, resolution_day, day * 10 + 1)])

        train, calib, test, meta = purged_chronological_split(
            rows, train_frac=0.4, calib_frac=0.3, embargo_hours=0,
        )

        calib_start = _timestamp_ms(meta["train_boundary"], "ts")
        test_start = _timestamp_ms(meta["test_boundary"], "ts")
        self.assertGreater(meta["purged_train"], 0)
        self.assertTrue(all(_timestamp_ms(r["resolutionTs"], "resolutionTs") < calib_start for r in train))
        self.assertTrue(all(_timestamp_ms(r["resolutionTs"], "resolutionTs") < test_start for r in calib))
        self.assertTrue(train and calib and test)
        self.assertLess(max(_timestamp_ms(r["ts"], "ts") for r in train), calib_start)
        self.assertLess(max(_timestamp_ms(r["ts"], "ts") for r in calib), test_start)


if __name__ == "__main__":
    unittest.main()
