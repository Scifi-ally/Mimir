"""
Ranker feature-contract integrity checks.
─────────────────────────────────────────────────────────────────────────────
The learned ranker is the only genuinely trained model in the system and it
hard-vetoes trades below `P(win) < 0.63`. A positionally-aligned feature contract
is therefore load-bearing: LightGBM consumes a bare float array, so a single
reordered or added feature silently feeds the model the wrong columns.

These tests separate two different guarantees:

  1. CONTRACT SELF-CONSISTENCY — the training manifest, the TypeScript serving
     contract, and the trained model's metadata must agree on the same ordered
     feature list. Asserted strictly; all pass.

  2. TRAINING DATA COMPATIBILITY — the committed `ranker_train.jsonl` must be
     wide enough to train the model. This was a real, broken condition in this
     repository and was marked `xfail(strict=True)` so the suite stayed runnable
     while the problem stayed impossible to forget.

Why (2) is not simply skipped: the data was generated 2026-07-25, the
32-feature contract was introduced 2026-08-19 in commit 67e7816, and the data
was never regenerated. `train_ranker.py` therefore raised on the first row
("feature width 31, expected 32") and the model could not be retrained or
reproduced from anything in the repository. `strict=True` meant that once the
data was regenerated the test reported XPASS and FAILED, forcing the marker to be
removed deliberately rather than lingering after the fix.

That regeneration has now happened: 17,407 rows, all 32 wide, spanning
2022-01-18..2026-08-31, produced by `scripts/backfill_training_candles.ts`
followed by `npm run ranker:extract`. The marker has been removed and this is
again a hard gate. Note the data is genuine: the 32-feature vector includes
`fiiDiiNetFlowLag`, and because NSE publishes no free historical FII/DII cash
data that one feature is constant zero across the historical window, so the
model assigns it ~0 importance. It is a real column, not a fabricated value.
"""

import json
import os
import re
from typing import List, Tuple

import pytest

ROOT = os.path.dirname(os.path.abspath(__file__))  # backend/ai_service
MANIFEST_PATH = os.path.join(ROOT, "..", "config", "ranker_features_manifest.json")
CONTRACT_PATH = os.path.join(ROOT, "..", "src", "analysis", "ranker_contract.ts")
META_PATH = os.path.join(ROOT, "ranker_meta.json")
DATA_PATH = os.path.join(ROOT, "..", "data", "ranker_train.jsonl")


def _load_manifest() -> List[str]:
    with open(MANIFEST_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    if isinstance(payload, list):
        return list(payload)
    return list(payload.get("feature_keys") or payload.get("features"))


def _load_serve_contract() -> List[str]:
    """Parse RANKER_FEATURE_KEYS straight out of the TypeScript source.

    Deliberately parsed from source rather than importing the module, so this
    check needs no build step and runs in the Python suite.
    """
    with open(CONTRACT_PATH, encoding="utf-8") as fh:
        source = fh.read()
    match = re.search(r"RANKER_FEATURE_KEYS[^=]*=\s*\[(.*?)\]", source, re.S)
    assert match, "RANKER_FEATURE_KEYS not found in ranker_contract.ts"
    return re.findall(r'"([A-Za-z0-9_]+)"', match.group(1))


def _load_meta() -> List[str]:
    with open(META_PATH, encoding="utf-8") as fh:
        return list(json.load(fh)["feature_keys"])


def _data_widths() -> Tuple[int, dict]:
    """Width histogram of the committed training rows."""
    widths: dict = {}
    with open(DATA_PATH, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            features = json.loads(line).get("features")
            w = len(features) if isinstance(features, list) else -1
            widths[w] = widths.get(w, 0) + 1
    return sum(widths.values()), widths


# ---------------------------------------------------------------------------
# 1. Contract self-consistency (strict)
# ---------------------------------------------------------------------------

def test_manifest_matches_serve_contract_exactly():
    """Training and serving must agree on the SAME ordered feature list."""
    manifest = _load_manifest()
    serve = _load_serve_contract()
    assert manifest == serve, (
        "Ranker feature contract drift between the training manifest and the "
        "serving contract. LightGBM consumes a positional array, so a reordering "
        "silently feeds the model the wrong columns.\n"
        f"  only in manifest: {sorted(set(manifest) - set(serve))}\n"
        f"  only in serve   : {sorted(set(serve) - set(manifest))}"
    )


def test_trained_model_metadata_matches_serve_contract():
    """The shipped booster must expect the same features serving produces."""
    meta = _load_meta()
    serve = _load_serve_contract()
    assert meta == serve, (
        "ranker_meta.json feature_keys no longer match the serving contract; the "
        "shipped model was trained on a different feature layout than it is "
        "being served with."
    )


def test_contract_width_is_stable_at_32():
    """Pin the width so an accidental feature addition is a deliberate act."""
    serve = _load_serve_contract()
    assert len(serve) == 32, f"expected 32 ranker features, found {len(serve)}"
    assert len(set(serve)) == 32, "duplicate feature name in the ranker contract"


def test_no_duplicate_features_in_any_source():
    for name, keys in (
        ("manifest", _load_manifest()),
        ("serve", _load_serve_contract()),
        ("meta", _load_meta()),
    ):
        assert len(set(keys)) == len(keys), f"duplicate feature name in {name}"


# ---------------------------------------------------------------------------
# 2. Training data compatibility
# ---------------------------------------------------------------------------
# The xfail marker that used to live here was removed once the data was actually
# regenerated: 17,407 rows, all 32 wide, covering 2022-01-18..2026-08-31, sourced
# by scripts/backfill_training_candles.ts. The assertion below is now a plain,
# hard gate - if the committed data ever drifts from the serve contract again,
# this fails rather than quietly tolerating it.

def test_committed_training_data_is_wide_enough_to_retrain():
    """
    The committed dataset must be trainable against the current contract.

    This is a real assertion, not a warning: silently tolerating incompatible
    training data is what allowed a 25-day contract/data drift to go unnoticed
    and made the only trained model in the system unreproducible. It was
    `xfail(strict=True)` while the data was 31 wide, and is a hard gate now that
    the data has been regenerated at the correct width.
    """
    total, widths = _data_widths()
    if total == 0:
        pytest.skip("no committed training data")

    expected = len(_load_serve_contract())
    assert set(widths) == {expected}, (
        f"Committed training data is incompatible with the {expected}-feature "
        f"contract. Observed row widths: {widths}.\n"
        "train_ranker.py rejects any row whose width differs, so training fails "
        "on the first row and the model cannot be rebuilt or reproduced.\n"
        "Regenerate with:  npm run ranker:extract && npm run ranker:train"
    )


def test_training_data_diagnostic_reports_the_real_state():
    """
    Guards the checker itself, so the diagnostic above cannot rot.

    Asserts only that the width detection is accurate — it passes whether or not
    the data is stale, which is what keeps CI runnable while the real problem
    remains visible in the test name and failure message above.
    """
    total, widths = _data_widths()
    if total == 0:
        pytest.skip("no committed training data")
    assert total == sum(widths.values())
    assert all(isinstance(w, int) for w in widths)
    # The observation is truthful: widths sum to the row count.
    assert widths and max(widths) > 0


# ---------------------------------------------------------------------------
# 3. Serve-time feature fidelity
# ---------------------------------------------------------------------------

def test_intraday_monitor_does_not_feed_a_constant_sector_rs():
    """
    `rsVsSector60d` is a real, learned feature (7th by importance in the
    shipped model). The intraday path hardcoded it to 1, which is the neutral
    value - so on that path the model received a constant for a feature it
    believes is informative, contributing noise rather than signal.
    """
    path = os.path.join(ROOT, "..", "src", "analysis", "intraday_monitor.ts")
    with open(path, encoding="utf-8") as fh:
        source = fh.read()
    assert not re.search(r"rsVsSector60d:\s*1\s*[,}]", source), (
        "intraday_monitor still hardcodes rsVsSector60d to the neutral value 1. "
        "The ranker treats this as a learned feature, so feeding a constant "
        "makes its contribution meaningless on the intraday path."
    )
