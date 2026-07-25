import os
import json
import asyncio
import random
from typing import List, Dict, Any, Callable
import datetime
import pandas as pd
from scipy.stats import spearmanr
import numpy as np
import logging

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from main import CandidateRequest, infer_batch, BatchRequest

logger = logging.getLogger("ai_service.backtest")

def calculate_ic(scores: pd.Series, forward_returns: pd.Series) -> float:
    """Calculate Information Coefficient using Spearman rank correlation."""
    if len(scores) < 2 or scores.std() == 0 or forward_returns.std() == 0:
        return 0.0
    corr, _ = spearmanr(scores, forward_returns)
    return float(corr) if not np.isnan(corr) else 0.0

def _get_quintile(rank: float, total: int) -> str:
    if total < 5: return "Q3"
    q_size = total / 5
    if rank <= q_size: return "Q1"
    if rank <= q_size * 2: return "Q2"
    if rank <= q_size * 3: return "Q3"
    if rank <= q_size * 4: return "Q4"
    return "Q5"

async def run_backtest(
    symbols: List[str],
    start_date: str,
    end_date: str,
    fetch_ohlcv_fn: Callable[[str, str], List[List[float]]],
    fetch_forward_returns_fn: Callable[[str, str], Dict[str, float]],
    score_func: Callable[[List[CandidateRequest]], List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Runs a historical backtest of the scoring model.
    fetch_ohlcv_fn: async fn(symbol, date) -> OHLCV up to that date.
    fetch_forward_returns_fn: async fn(symbol, date) -> {'1d': pct, '5d': pct, '20d': pct}
    """
    
    dates = pd.date_range(start=start_date, end=end_date, freq='B') # Business days
    
    real_results = []
    random_results = []
    
    for date in dates:
        date_str = date.strftime('%Y-%m-%dT00:00:00')
        logger.info(f"Evaluating for {date_str}")
        
        candidates = []
        for sym in symbols:
            # Fetch truncated historical data (PIT)
            ohlcv = await fetch_ohlcv_fn(sym, date_str)
            if ohlcv and len(ohlcv) >= 50:
                candidates.append(CandidateRequest(
                    symbol=sym,
                    ohlcv=ohlcv,
                    as_of_date=date_str
                ))
        
        if not candidates:
            continue
            
        # Get AI Scores
        if score_func:
            scores_res = await score_func(candidates)
        else:
            # Default to infer_batch
            req = BatchRequest(candidates=candidates)
            res = await infer_batch(req)
            scores_res = [{"symbol": r.symbol, "score": r.composite_score} for r in res.results]
            
        # Also fetch forward returns
        df_rows = []
        for item in scores_res:
            sym = item["symbol"]
            score = item["score"]
            fwd = await fetch_forward_returns_fn(sym, date_str)
            if fwd:
                df_rows.append({
                    "symbol": sym,
                    "score": score,
                    "fwd_1d": fwd.get("1d", 0.0),
                    "fwd_5d": fwd.get("5d", 0.0),
                    "fwd_20d": fwd.get("20d", 0.0),
                })
        
        if len(df_rows) < 5:
            continue
            
        df = pd.DataFrame(df_rows)
        
        # Rank logic for real scores
        df["rank"] = df["score"].rank(ascending=False, method="first")
        total = len(df)
        df["quintile"] = df["rank"].apply(lambda r: _get_quintile(r, total))
        
        # Calculate daily IC for real
        ic_1d = calculate_ic(df["score"], df["fwd_1d"])
        ic_5d = calculate_ic(df["score"], df["fwd_5d"])
        ic_20d = calculate_ic(df["score"], df["fwd_20d"])
        
        real_results.append({
            "date": date_str,
            "ic_1d": ic_1d, "ic_5d": ic_5d, "ic_20d": ic_20d,
            "quintiles": df.groupby("quintile")[["fwd_1d", "fwd_5d", "fwd_20d"]].mean().to_dict('index')
        })
        
        # Random Control
        df_rand = df.copy()
        df_rand["score"] = np.random.permutation(df_rand["score"].values)
        df_rand["rank"] = df_rand["score"].rank(ascending=False, method="first")
        df_rand["quintile"] = df_rand["rank"].apply(lambda r: _get_quintile(r, total))
        
        r_ic_1d = calculate_ic(df_rand["score"], df_rand["fwd_1d"])
        r_ic_5d = calculate_ic(df_rand["score"], df_rand["fwd_5d"])
        r_ic_20d = calculate_ic(df_rand["score"], df_rand["fwd_20d"])
        
        random_results.append({
            "date": date_str,
            "ic_1d": r_ic_1d, "ic_5d": r_ic_5d, "ic_20d": r_ic_20d,
            "quintiles": df_rand.groupby("quintile")[["fwd_1d", "fwd_5d", "fwd_20d"]].mean().to_dict('index')
        })

    if not real_results:
        return {"error": "No valid dates/data processed"}
        
    def aggregate_results(res_list):
        df_res = pd.DataFrame(res_list)
        ic_mean = df_res[["ic_1d", "ic_5d", "ic_20d"]].mean().to_dict()
        ic_std = df_res[["ic_1d", "ic_5d", "ic_20d"]].std().to_dict()
        ir = {k: (ic_mean[k] / ic_std[k] if ic_std[k] > 0 else 0.0) for k in ic_mean}
        
        # Aggregate quintile returns
        q_returns = {"Q1": {}, "Q2": {}, "Q3": {}, "Q4": {}, "Q5": {}}
        for r in res_list:
            for q in q_returns:
                if q in r["quintiles"]:
                    for horizon in ["fwd_1d", "fwd_5d", "fwd_20d"]:
                        if horizon not in q_returns[q]:
                            q_returns[q][horizon] = []
                        q_returns[q][horizon].append(r["quintiles"][q][horizon])
                        
        for q in q_returns:
            for horizon in q_returns[q]:
                q_returns[q][horizon] = np.mean(q_returns[q][horizon])
                
        return {
            "ic_mean": ic_mean,
            "ic_std": ic_std,
            "ir": ir,
            "quintile_returns": q_returns
        }

    real_agg = aggregate_results(real_results)
    rand_agg = aggregate_results(random_results)
    
    report = {
        "period": f"{start_date} to {end_date}",
        "universe_size": len(symbols),
        "sample_size": len(real_results),
        "real": real_agg,
        "random_control": rand_agg
    }
    return report

if __name__ == "__main__":
    # Example local runner
    pass
