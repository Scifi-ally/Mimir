"""Read historical diagnostics only when both observation and ingestion were known."""


def recorded_sentiment(connection, symbol, as_of):
    with connection.cursor() as cursor:
        cursor.execute("""
            SELECT value FROM fundamental_snapshots
            WHERE symbol = %s AND field_name = 'sentiment_composite'
              AND filed_date <= %s AND fetched_at <= %s
            ORDER BY filed_date DESC, fetched_at DESC LIMIT 1
        """, (symbol, as_of, as_of))
        row = cursor.fetchone()
        composite = float(row[0]) if row else 0.0
        cursor.execute("""
            SELECT value FROM fundamental_snapshots
            WHERE field_name = 'sentiment_world'
              AND filed_date <= %s AND fetched_at <= %s
            ORDER BY filed_date DESC, fetched_at DESC LIMIT 1
        """, (as_of, as_of))
        row = cursor.fetchone()
        return composite, float(row[0]) if row else 0.0
