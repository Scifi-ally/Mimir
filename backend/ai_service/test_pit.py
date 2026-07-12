import unittest
from unittest.mock import patch, MagicMock
import asyncio
import sys
import os

# Add parent directory to path so we can import main
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from main import BatchRequest, CandidateRequest, infer_batch

class TestPITScoring(unittest.IsolatedAsyncioTestCase):
    @patch('main.os.getenv')
    @patch('main.psycopg2')
    @patch('main.technical_pattern_engine')
    @patch('main.chronos_service')
    async def test_pit_filters_future_data(self, mock_chronos, mock_tech, mock_psycopg2, mock_getenv):
        # Ensure DB URL is present so it attempts to connect
        mock_getenv.return_value = "postgresql://dummy"

        # Mock ML responses
        mock_tech_res = MagicMock()
        mock_tech_res.bullish_probability = 0.8
        mock_tech_res.confidence = 0.9
        mock_tech_res.detected_patterns = []
        mock_tech_res.source = "mock"
        mock_tech.infer.return_value = mock_tech_res
        
        mock_cr = MagicMock()
        mock_cr.median_forecast = []
        mock_cr.quantile_forecasts = {}
        mock_cr.trend = "up"
        mock_cr.forecast_return_pct = 0.05
        mock_cr.source = "mock"
        mock_chronos.infer.return_value = mock_cr

        # Mock DB connection
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_psycopg2.connect.return_value = mock_conn
        mock_conn.cursor.return_value = mock_cursor

        # Fake db returns sentiment = 0.5 when queried
        mock_cursor.fetchone.return_value = (0.5,)

        req = BatchRequest(candidates=[
            CandidateRequest(
                symbol="RELIANCE",
                ohlcv=[[1.0, 2.0, 3.0, 4.0, 100.0], [2.0, 3.0, 4.0, 5.0, 200.0]],
                as_of_date="2024-01-01T00:00:00"
            )
        ])

        # Execute
        res = await infer_batch(req)

        # Assert DB was queried
        mock_cursor.execute.assert_called()
        query, params = mock_cursor.execute.call_args[0]
        
        # Verify PIT date was passed as a parameter
        self.assertIn("filed_date <= %s", query)
        self.assertEqual(params[1], "2024-01-01T00:00:00")
        
        # Verify the sentiment composite was used in score (sentiment score = 0.5)
        self.assertEqual(res.results[0].sentiment_score, 0.5)
        
        # If the DB returned None (e.g. all data is in the future), it should default to 0.0
        mock_cursor.fetchone.return_value = None
        res2 = await infer_batch(req)
        self.assertEqual(res2.results[0].sentiment_score, 0.0)

if __name__ == '__main__':
    unittest.main()
