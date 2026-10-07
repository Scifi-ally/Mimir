"""Execute historical selection against a real in-memory relational database."""
import sqlite3
from historical_sentiment import recorded_sentiment


class CursorAdapter:
    def __init__(self, database):
        self.cursor = database.cursor()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.cursor.close()

    def execute(self, sql, parameters):
        self.cursor.execute(sql.replace("%s", "?"), parameters)

    def fetchone(self):
        return self.cursor.fetchone()


class ConnectionAdapter:
    def __init__(self, database):
        self.database = database

    def cursor(self):
        return CursorAdapter(self.database)


def test_later_backfill_cannot_leak_into_an_earlier_decision():
    database = sqlite3.connect(":memory:")
    database.execute("CREATE TABLE fundamental_snapshots (symbol TEXT, field_name TEXT, value REAL, filed_date TEXT, fetched_at TEXT)")
    database.executemany("INSERT INTO fundamental_snapshots VALUES (?,?,?,?,?)", [
        ("REAL_EQ", "sentiment_composite", .3, "2026-01-01", "2026-01-02"),
        ("REAL_EQ", "sentiment_composite", .9, "2026-01-03", "2026-01-09"),
        ("GLOBAL", "sentiment_world", -.2, "2026-01-01", "2026-01-02"),
        ("GLOBAL", "sentiment_world", -.9, "2026-01-03", "2026-01-09"),
    ])
    connection = ConnectionAdapter(database)
    assert recorded_sentiment(connection, "REAL_EQ", "2026-01-04") == (.3, -.2)
    assert recorded_sentiment(connection, "REAL_EQ", "2026-01-10") == (.9, -.9)
    database.close()
