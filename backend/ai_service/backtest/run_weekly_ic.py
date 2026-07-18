"""Weekly Information Coefficient (IC) job.

Computes the REAL rank correlation between the model's composite score at
suggestion time (`ai_scores.composite_score`) and the realized outcome of that
suggestion (`signal_outcomes.pnl` normalized by entry price), then records it in
`alpha_score_ic_history`.

If there aren't enough closed outcomes to compute a meaningful IC, it logs and
writes NOTHING — it never fabricates metrics.
"""
import os
import asyncio
import datetime
import logging

try:
    import psycopg2
except ImportError:
    psycopg2 = None

import numpy as np
from scipy.stats import spearmanr

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai_service.backtest.weekly")

# Minimum number of paired (score, outcome) rows required before an IC is
# statistically meaningful enough to record.
MIN_SAMPLE_SIZE = 20

# Look back this many days for closed outcomes.
LOOKBACK_DAYS = 30


def _compute_ic(rows):
    """rows: list of (composite_score, entry_price, pnl, direction).
    Returns (ic_mean, ic_std, sample_size) or None if not computable."""
    scores = []
    returns = []
    for composite_score, entry_price, pnl, direction in rows:
        if entry_price is None or float(entry_price) == 0.0:
            continue
        # Realized return as a fraction of capital at entry. pnl already carries
        # the sign of the trade result (long or short), so it maps directly to
        # "did a higher score correspond to a better outcome".
        realized_return = float(pnl) / float(entry_price)
        scores.append(float(composite_score))
        returns.append(realized_return)

    n = len(scores)
    if n < MIN_SAMPLE_SIZE:
        return None
    if np.std(scores) == 0 or np.std(returns) == 0:
        return None

    corr, _ = spearmanr(scores, returns)
    if np.isnan(corr):
        return None

    # Bootstrap the standard error of the IC so the recorded ic_std reflects
    # real sampling uncertainty rather than a hardcoded guess.
    rng = np.random.default_rng(42)
    scores_arr = np.asarray(scores)
    returns_arr = np.asarray(returns)
    boots = []
    for _ in range(500):
        idx = rng.integers(0, n, n)
        c, _p = spearmanr(scores_arr[idx], returns_arr[idx])
        if not np.isnan(c):
            boots.append(c)
    ic_std = float(np.std(boots)) if boots else 0.0

    return float(corr), ic_std, n


async def main():
    if psycopg2 is None:
        logger.error("psycopg2 not installed; cannot compute IC history")
        return

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        logger.error("No DATABASE_URL found")
        return

    end_date = datetime.datetime.now()
    since = end_date - datetime.timedelta(days=LOOKBACK_DAYS)

    conn = None
    try:
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Join each closed outcome to the score the model gave that suggestion.
        cur.execute(
            """
            SELECT s.composite_score, o.entry_price, o.pnl, o.direction
            FROM signal_outcomes o
            JOIN ai_scores s ON s.suggestion_id = o.suggestion_id
            WHERE o.closed_at >= %s
              AND o.entry_price IS NOT NULL
              AND o.entry_price <> 0
            """,
            (since,),
        )
        rows = cur.fetchall()

        result = _compute_ic(rows)
        if result is None:
            logger.warning(
                "Insufficient closed outcomes (%d found, need >= %d) — "
                "not recording IC to avoid fabricated metrics",
                len(rows), MIN_SAMPLE_SIZE,
            )
            return

        ic_mean, ic_std, sample_size = result
        cur.execute(
            """
            INSERT INTO alpha_score_ic_history (computed_at, ic_mean, ic_std, sample_size)
            VALUES (%s, %s, %s, %s)
            """,
            (end_date, ic_mean, ic_std, sample_size),
        )
        conn.commit()
        cur.close()
        logger.info(
            "Recorded weekly IC: ic_mean=%.4f ic_std=%.4f n=%d",
            ic_mean, ic_std, sample_size,
        )
    except Exception as e:
        logger.error(f"Failed to record IC history: {e}")
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    asyncio.run(main())
