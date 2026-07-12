import psycopg2
conn = psycopg2.connect('postgresql://postgres:postgres@127.0.0.1:5433/upstox_bot')
cur = conn.cursor()
cur.execute("SELECT ts, open, high, low, close, volume FROM candles WHERE symbol='BHARTIARTL'")
rows = cur.fetchall()
for r in rows:
    if r[2] > 3000:
        print('Bad candle:', r)
