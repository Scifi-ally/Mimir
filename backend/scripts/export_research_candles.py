"""Export local recorded candles in a READ ONLY database transaction. No broker access."""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ai_service"))
from env_loader import parse_env_file


def export_history(output: Path) -> None:
    import psycopg2
    root = Path(__file__).resolve().parents[2]
    values = {}
    for path in (root / ".env", root / "backend/.env", root / "backend/.env.local", root / ".env.local"):
        values.update(parse_env_file(str(path)))
    url = os.getenv("DATABASE_URL") or values.get("DATABASE_URL")
    if not url:
        raise ValueError("Configured local database required")
    data = {}
    with psycopg2.connect(url, connect_timeout=10) as connection:
        connection.set_session(readonly=True)
        with connection.cursor() as cursor:
            cursor.execute("""SELECT instrument_key, extract(epoch from timestamp)*1000,
                open, high, low, close, volume FROM candles WHERE interval='day'
                AND (instrument_key LIKE 'NSE_EQ|%%' OR instrument_key='NSE_INDEX|Nifty 50')
                ORDER BY instrument_key, timestamp""")
            for key, timestamp, opening, high, low, close, volume in cursor:
                name = "NIFTY" if key == "NSE_INDEX|Nifty 50" else key
                data.setdefault(name, []).append([int(timestamp), opening, high, low, close, volume])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, allow_nan=False), encoding="utf-8")
    print(json.dumps({"instruments": len(data), "bars": sum(map(len, data.values())), "output": str(output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(".codex-logs/research-recorded-candles.json"))
    export_history(parser.parse_args().out)
