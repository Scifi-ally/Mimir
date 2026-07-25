import datetime
import numpy as np
from walk_forward_harness import generate_folds

def test_leakage_detection():
    # Synthetic dataset
    rows = []
    base_ts = datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc).timestamp()
    DAY = 86400
    
    # Generate 400 days of data, 1 row per day
    # Structural break happens at "2024-11-20T00:00:00Z" which is day 324 (roughly 10.5 months)
    for i in range(400):
        ts = base_ts + i * DAY
        res_ts = ts + 5 * DAY
        label = np.random.randint(2)
        leaky_feature = label 
        
        rows.append({
            "ts": datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(),
            "resolutionTs": datetime.datetime.fromtimestamp(res_ts, datetime.timezone.utc).isoformat(),
            "label": label,
            "features": [leaky_feature]
        })
        
    folds = generate_folds(
        rows,
        max_label_horizon_days=5,
        embargo_window_days=1,
        test_window_days=30,
        min_train_days=180
    )
    
    assert len(folds) > 0
    
    # Check that for the first fold, train_end is 180.
    # purge_start = 180.
    train_idx, test_idx = folds[0]
    max_train_res = max([datetime.datetime.fromisoformat(rows[i]["resolutionTs"]).timestamp() for i in train_idx])
    purge_start = base_ts + 180 * DAY
    
    assert max_train_res < purge_start, f"Leakage detected! max train res {max_train_res} >= purge_start {purge_start}"
    print("Test passed: Purged Walk-Forward successfully removed overlapping rows.")
    
    # Check structural breaks. We expect folds to stop before the break, 
    # then reset, and the first fold of the NEXT epoch should start after the break.
    break_ts = datetime.datetime.fromisoformat("2024-11-20T00:00:00+00:00").timestamp()
    
    for fold_idx, (tr_idx, te_idx) in enumerate(folds):
        train_start = datetime.datetime.fromisoformat(rows[tr_idx[0]]["ts"]).timestamp()
        train_end = datetime.datetime.fromisoformat(rows[tr_idx[-1]]["ts"]).timestamp()
        test_start = datetime.datetime.fromisoformat(rows[te_idx[0]]["ts"]).timestamp()
        test_end = datetime.datetime.fromisoformat(rows[te_idx[-1]]["ts"]).timestamp()
        
        crosses_break = (train_start < break_ts) and (test_end > break_ts)
        assert not crosses_break, f"Fold {fold_idx} crosses structural break!"

    print("Test passed: Walk-forward harness respects structural breaks by isolating epochs.")

if __name__ == "__main__":
    test_leakage_detection()
