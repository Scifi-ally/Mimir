import os
import numpy as np
import pandas as pd
import gymnasium as gym
from gymnasium import spaces
from stable_baselines3 import PPO
import logging
import yfinance as yf
from ta.momentum import RSIIndicator
from ta.trend import MACD

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("train_rl")

class StockTradingEnv(gym.Env):
    """
    A custom simple OpenAI gym environment for stock trading.
    """
    metadata = {'render.modes': ['human']}

    def __init__(self, df: pd.DataFrame, episode_length=252):
        super(StockTradingEnv, self).__init__()
        self.df = df
        self.episode_length = min(episode_length, len(df) - 1)
        self.max_steps = len(df) - 1
        self.start_step = 0
        self.current_step = 0
        
        # Actions: 0=Strong Sell, 1=Sell, 2=Hold, 3=Buy, 4=Strong Buy
        self.action_space = spaces.Discrete(5)
        
        # Observation: [Close, Volume, RSI, MACD, VIX, FII_DII_Net, PCR]
        self.observation_space = spaces.Box(low=-np.inf, high=np.inf, shape=(7,), dtype=np.float32)

    def _next_observation(self):
        row = self.df.iloc[self.current_step]
        close = row.get("close", 0.0)
        volume = row.get("volume", 0.0)
        rsi = row.get("rsi", 50.0)
        macd = row.get("macd", 0.0)
        vix = row.get("vix", 15.0)
        fii = row.get("fiiNet", 0.0)
        pcr = row.get("pcr", 1.0)
        
        obs = np.array([
            close / 10000.0 if close else 0.0,
            volume / 1000000.0 if volume else 0.0,
            rsi / 100.0 if not pd.isna(rsi) else 0.5,
            macd / 100.0 if not pd.isna(macd) else 0.0,
            vix / 50.0 if not pd.isna(vix) else 0.3,
            fii / 10000.0 if not pd.isna(fii) else 0.0,
            pcr / 3.0 if not pd.isna(pcr) else 0.33,
        ], dtype=np.float32)
        return obs

    def step(self, action):
        self.current_step += 1
        
        if self.current_step < self.max_steps:
            prev_row = self.df.iloc[self.current_step - 1]
            curr_row = self.df.iloc[self.current_step]
            current_price = prev_row["close"]
            next_price = curr_row["close"]

            # If the dataset stitches multiple tickers together, the return across
            # the seam between two different stocks is meaningless — zero it so the
            # agent never learns from a phantom overnight jump between symbols.
            same_symbol = (
                "symbol" not in self.df.columns
                or prev_row.get("symbol") == curr_row.get("symbol")
            )

            # Simple reward based on future return and our action
            if current_price > 0 and same_symbol:
                price_change = (next_price - current_price) / current_price
            else:
                price_change = 0.0

            action_mult = {0: -1.0, 1: -0.5, 2: 0.0, 3: 0.5, 4: 1.0}[int(action)]
            reward = price_change * action_mult
        else:
            reward = 0
            
        done = (self.current_step - self.start_step) >= self.episode_length or self.current_step >= self.max_steps
        obs = self._next_observation()
        
        return obs, reward, done, False, {}

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        if self.max_steps > self.episode_length:
            self.start_step = self.np_random.integers(0, self.max_steps - self.episode_length)
        else:
            self.start_step = 0
        self.current_step = self.start_step
        return self._next_observation(), {}

    def render(self, mode='human', close=False):
        pass

def fetch_data() -> pd.DataFrame:
    """Fetch NIFTY 50 top components historical data and merge with Macro data."""
    import sqlite3
    import time
    
    cache_path = os.path.join(os.path.dirname(__file__), "yfinance_cache.parquet")
    if os.path.exists(cache_path):
        if time.time() - os.path.getmtime(cache_path) < 86400:
            logger.info("Loading yfinance data from local cache.")
            return pd.read_parquet(cache_path)
            
    db_path = os.path.join(os.path.dirname(__file__), "..", "mimir.db")
    
    # 1. Try to fetch historical Macro Data from SQLite
    macro_df = pd.DataFrame()
    if os.path.exists(db_path):
        try:
            with sqlite3.connect(db_path) as conn:
                fii_query = "SELECT date, fiiNet FROM institutional_flows"
                fii_df = pd.read_sql_query(fii_query, conn)
                if not fii_df.empty:
                    fii_df['date'] = pd.to_datetime(fii_df['date']).dt.tz_localize(None)
                    fii_df.set_index('date', inplace=True)
                    macro_df = fii_df
        except Exception as e:
            logger.error(f"Failed to fetch FII data from sqlite: {e}")

    # 2. Fetch VIX from yfinance
    logger.info("Fetching historical India VIX...")
    vix_df = yf.download("^INDIAVIX", start="2018-01-01", progress=False)
    if not vix_df.empty:
        if isinstance(vix_df.columns, pd.MultiIndex):
            vix_df.columns = vix_df.columns.get_level_values(0)
        vix_df = vix_df[['Close']].rename(columns={'Close': 'vix'})
        vix_df.index = vix_df.index.tz_localize(None)
        
        if macro_df.empty:
            macro_df = vix_df
        else:
            macro_df = macro_df.join(vix_df, how='outer')

    tickers = ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS"]
    logger.info(f"Fetching historical data for {tickers}...")
    
    all_data = []
    
    for ticker in tickers:
        df = yf.download(ticker, start="2018-01-01", progress=False)
        if df.empty:
            continue
        
        # Flatten MultiIndex columns if present
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
            
        df = df.rename(columns={"Close": "close", "Volume": "volume"})
        df.index = df.index.tz_localize(None)
        
        # Calculate Technicals
        df['rsi'] = RSIIndicator(close=df['close'], window=14).rsi()
        macd = MACD(close=df['close'])
        df['macd'] = macd.macd_diff()
        
        # Join Macro Data
        if not macro_df.empty:
            # Prevent look-ahead bias: FII/DII is published post-market. 
            # Shift it so today's action only sees yesterday's flow.
            macro_for_join = macro_df.copy()
            if 'fiiNet' in macro_for_join.columns:
                macro_for_join['fiiNet'] = macro_for_join['fiiNet'].shift(1)
            df = df.join(macro_for_join, how='left')
            
        # Forward fill and fillna for missing macro data
        if 'vix' in df.columns:
            df['vix'] = df['vix'].ffill().fillna(15.0)
        else:
            df['vix'] = 15.0
            
        if 'fiiNet' in df.columns:
            df['fiiNet'] = df['fiiNet'].fillna(0.0)
        else:
            df['fiiNet'] = 0.0
            
        df['pcr'] = 1.0  # Default PCR since historical options data isn't in yfinance
        df['symbol'] = ticker  # tag rows so episodes never cross a stock boundary

        df = df.dropna(subset=['close', 'volume', 'rsi', 'macd'])
        all_data.append(df[['close', 'volume', 'rsi', 'macd', 'vix', 'fiiNet', 'pcr', 'symbol']])
        
    if not all_data:
        raise ValueError("Could not fetch any data from yfinance.")
        
    combined_df = pd.concat(all_data).reset_index(drop=True)
    try:
        combined_df.to_parquet(cache_path)
    except Exception as e:
        logger.warning(f"Failed to cache data to parquet: {e}")
        
    logger.info(f"Combined dataset length: {len(combined_df)}")
    return combined_df

def main(lifecycle_manager=None):
    logger.info("Starting RL model training script.")
    
    if lifecycle_manager:
        lifecycle_manager.set_state("TRAINING", progress=10)
        
    try:
        df = fetch_data()
        
        if lifecycle_manager:
            lifecycle_manager.set_state("TRAINING", progress=30)
            
        env = StockTradingEnv(df)
        model_path = os.path.join(os.path.dirname(__file__), "rl_model.zip")
        
        if os.path.exists(model_path):
            logger.info("Existing model found. Loading to fine-tune...")
            try:
                model = PPO.load(model_path, env=env)
            except Exception as e:
                logger.warning(f"Failed to load existing model (likely due to observation space change): {e}")
                logger.info("Initializing new PPO agent.")
                model = PPO("MlpPolicy", env, verbose=1)
        else:
            logger.info("Initializing new PPO agent.")
            model = PPO("MlpPolicy", env, verbose=1)
        
        if lifecycle_manager:
            lifecycle_manager.set_state("TRAINING", progress=40)
            
        logger.info("Training agent for 20,000 steps.")
        # Optional: Use a callback to update progress in lifecycle_manager
        model.learn(total_timesteps=20000)
        
        model.save(model_path)
        logger.info(f"Model saved to {model_path}.")
        
    except Exception as e:
        logger.exception("Error in RL training pipeline.")
        raise e

if __name__ == "__main__":
    main()
