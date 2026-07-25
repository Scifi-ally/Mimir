from __future__ import annotations

import datetime
from typing import Any, Dict, List, Tuple

def parse_iso(ts_str: str) -> float:
    # TS outputs e.g. '2026-06-24T20:39:30.369Z'
    s = ts_str.replace("Z", "+00:00")
    return datetime.datetime.fromisoformat(s).timestamp()

def generate_folds(
    rows: List[Dict[str, Any]],
    max_label_horizon_days: int = 5,
    embargo_window_days: int = 1,
    test_window_days: int = 30,
    min_train_days: int = 180,
) -> List[Tuple[List[int], List[int]]]:
    """
    Generate purged, embargoed walk-forward folds.
    Returns a list of (train_indices, test_indices).
    """
    if not rows:
        return []

    # Parse timestamps for all rows
    timestamps = []
    resolution_timestamps = []
    for r in rows:
        ts = parse_iso(r["ts"])
        res_ts = parse_iso(r.get("resolutionTs", r["ts"]))
        timestamps.append(ts)
        resolution_timestamps.append(res_ts)

    start_ts = timestamps[0]
    end_ts = timestamps[-1]
    
    DAY = 86400
    folds = []
    
    current_train_end = start_ts + (min_train_days * DAY)
    
    while current_train_end < end_ts:
        purge_start = current_train_end
        purge_end = purge_start + (max_label_horizon_days * DAY)
        embargo_end = purge_end + (embargo_window_days * DAY)
        test_start = embargo_end
        test_end = test_start + (test_window_days * DAY)
        
        if test_start >= end_ts:
            break
            
        train_indices = []
        test_indices = []
        
        for i, (ts, res_ts) in enumerate(zip(timestamps, resolution_timestamps)):
            # Train set: ts must be < purge_start
            if ts < purge_start:
                # PURGE: Drop training row if its label resolution falls at or after purge_start
                # This prevents the label from 'peeking' into the embargo/test period
                if res_ts < purge_start:
                    train_indices.append(i)
            # Test set: ts must be between test_start and test_end
            elif test_start <= ts < test_end:
                test_indices.append(i)
                
        if len(train_indices) > 0 and len(test_indices) > 0:
            folds.append((train_indices, test_indices))
            
        # Move forward (expanding window)
        current_train_end = test_end
        
    return folds
