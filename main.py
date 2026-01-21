#!/usr/bin/env python3
from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd

# Plotly is only needed when you choose "Plot"
try:
    import plotly.graph_objects as go
    HAS_PLOTLY = True
except Exception:
    HAS_PLOTLY = False


# =========================
# EDIT THESE DEFAULTS
# =========================
SIMS_DEFAULT = 1000          # random search tries (start here; raise later if you want)
SEED_DEFAULT = 42
FEE_DEFAULT = 0.001          # per side (0.1%)
DD_WEIGHT_DEFAULT = 0.75     # drawdown penalty weight
TRADE_PENALTY_DEFAULT = 0.002  # mild penalty per trade/year (keeps it from overtrading too hard)

# "Don't do nothing forever" controls:
MAX_IDLE_DAYS_DEFAULT = 15   # max trading days without ANY trade (buy or sell)
MIN_HOLD_DAYS_DEFAULT = 2    # minimum days to hold before selling (prevents instant flip-flop)
MAX_HOLD_DAYS_DEFAULT = 60   # force exit if held too long
COOLDOWN_DAYS_DEFAULT = 1    # days after selling before a new buy (unless forced by max-idle)


# =========================
# Paths / discovery
# =========================
def project_dir() -> Path:
    return Path(__file__).resolve().parent

def stock_data_dir() -> Path:
    return project_dir() / "stock_data"

def train_data_dir() -> Path:
    d = project_dir() / "train_data"
    d.mkdir(parents=True, exist_ok=True)
    return d

def find_stock_csv(ticker: str) -> Optional[Path]:
    t = (ticker or "").strip()
    if not t:
        return None
    t_upper = t.upper()

    d = stock_data_dir()
    if not d.exists():
        return None

    direct = d / f"{t_upper}.csv"
    if direct.exists():
        return direct

    for p in d.glob("*.csv"):
        if p.stem.strip().upper() == t_upper:
            return p
    return None

def output_paths_for(csv_path: Path) -> Dict[str, Path]:
    out_dir = train_data_dir()
    stem = csv_path.stem
    return {
        "dir": out_dir,
        "labeled": out_dir / csv_path.name,                 # EXACT same filename as input
        "trades": out_dir / f"{stem}_best_trades.csv",      # best trades
        "summary": out_dir / f"{stem}_summary.txt",
    }


# =========================
# Data loading
# =========================
def _clean_money_series(s: pd.Series) -> pd.Series:
    ss = s.astype(str).str.strip()
    ss = ss.str.replace(r"^\((.*)\)$", r"-\1", regex=True)
    ss = ss.str.replace("$", "", regex=False).str.replace(",", "", regex=False).str.replace(" ", "", regex=False)
    return pd.to_numeric(ss, errors="coerce")

def load_prices(csv_path: Path, date_col: str = "Date", close_col: str = "Close/Last") -> pd.DataFrame:
    df = pd.read_csv(str(csv_path))
    if df.empty:
        raise ValueError(f"CSV is empty: {csv_path}")

    df.columns = [str(c).strip() for c in df.columns]

    # Auto-detect close column if needed
    if close_col not in df.columns:
        for cand in ["Close/Last", "Close", "Adj Close", "AdjClose", "Last"]:
            if cand in df.columns:
                close_col = cand
                break

    if date_col not in df.columns:
        raise ValueError(f"Date column '{date_col}' not found. Columns: {list(df.columns)}")
    if close_col not in df.columns:
        raise ValueError(f"Close column '{close_col}' not found. Columns: {list(df.columns)}")

    out = df[[date_col, close_col]].copy()
    out = out.rename(columns={date_col: "Date", close_col: "Close"})

    # MM/DD/YYYY first, fallback generic
    sdate = out["Date"].astype(str).str.strip()
    dt = pd.to_datetime(sdate, errors="coerce", format="%m/%d/%Y")
    if dt.isna().mean() > 0.2:
        dt = pd.to_datetime(sdate, errors="coerce")
    out["Date"] = dt

    out["Close"] = _clean_money_series(out["Close"])

    out = out.dropna(subset=["Date", "Close"])
    out = out.sort_values("Date").drop_duplicates(subset=["Date"], keep="last").reset_index(drop=True)

    if len(out) < 100:
        print("Warning: very little data loaded. Results may be noisy.")

    return out


# =========================
# Indicators precompute (fast random search)
# =========================
def precompute_indicators(close: pd.Series) -> Dict[str, Dict[int, pd.Series]]:
    """
    Precompute lots of rolling stats so sims don't recompute them.
    Returns dicts: sma[window], rsi[window], zret[window]
    """
    sma: Dict[int, pd.Series] = {}
    rsi: Dict[int, pd.Series] = {}
    zret: Dict[int, pd.Series] = {}

    # Simple moving averages
    for w in range(3, 201):
        sma[w] = close.rolling(w).mean()

    # RSI
    delta = close.diff()
    up = delta.clip(lower=0)
    down = (-delta).clip(lower=0)
    for w in range(5, 31):
        roll_up = up.ewm(alpha=1 / w, adjust=False).mean()
        roll_down = down.ewm(alpha=1 / w, adjust=False).mean()
        rs = roll_up / roll_down
        rsi[w] = 100 - (100 / (1 + rs))

    # Z-score of returns (mean reversion signal)
    ret = close.pct_change()
    for w in range(10, 81):
        mu = ret.rolling(w).mean()
        sd = ret.rolling(w).std()
        zret[w] = (ret - mu) / sd

    return {"sma": sma, "rsi": rsi, "zret": zret}


# =========================
# Strategy + Backtest (no monthly/weekly buckets)
# =========================
@dataclass(frozen=True)
class FreeStrategy:
    fast: int
    slow: int
    rsi_w: int
    rsi_buy: float
    rsi_sell: float
    z_w: int
    z_buy: float
    z_sell: float
    stop_loss: float
    take_profit: float

    min_hold: int
    max_hold: int
    cooldown: int
    max_idle: int

    fee: float
    dd_weight: float
    trade_penalty: float


@dataclass
class FreeResult:
    strat: FreeStrategy
    score: float
    total_return: float
    cagr: float
    max_dd: float
    trades: pd.DataFrame
    trades_per_year: float


def max_drawdown(equity: List[float]) -> float:
    peak = float("-inf")
    mdd = 0.0
    for v in equity:
        peak = max(peak, v)
        if peak > 0:
            mdd = max(mdd, (peak - v) / peak)
    return mdd


def annualized_return(start_val: float, end_val: float, start_date: pd.Timestamp, end_date: pd.Timestamp) -> float:
    days = max(1, (end_date - start_date).days)
    years = days / 365.25
    if years <= 0 or start_val <= 0:
        return 0.0
    return (end_val / start_val) ** (1.0 / years) - 1.0


def backtest_free(df: pd.DataFrame, ind: Dict[str, Dict[int, pd.Series]], s: FreeStrategy) -> FreeResult:
    dates = df["Date"].to_list()
    close = df["Close"]

    sma_fast = ind["sma"][s.fast]
    sma_slow = ind["sma"][s.slow]
    rsi = ind["rsi"][s.rsi_w]
    z = ind["zret"][s.z_w]

    fee = max(0.0, s.fee)

    cash = 1.0
    shares = 0.0
    holding = False
    entry_price = 0.0
    entry_i = -1
    last_trade_i = 0
    cooldown_until = -1

    equity_curve: List[float] = []
    trades_rows: List[Dict] = []

    for i in range(len(df)):
        price = float(close.iat[i])

        # equity mark-to-market
        equity = cash if not holding else shares * price
        equity_curve.append(equity)

        # skip until indicators are available
        if pd.isna(sma_fast.iat[i]) or pd.isna(sma_slow.iat[i]) or pd.isna(rsi.iat[i]) or pd.isna(z.iat[i]):
            continue

        # Determine forced action if too long with no trade
        idle_days = i - last_trade_i
        force_trade = idle_days >= max(1, s.max_idle)

        # Respect cooldown after sells (unless forced by max idle)
        can_buy = (i >= cooldown_until)

        if not holding:
            # ENTRY
            trend_ok = sma_fast.iat[i] > sma_slow.iat[i]
            meanrev_ok = z.iat[i] <= s.z_buy
            rsi_ok = rsi.iat[i] <= s.rsi_buy

            enter = (can_buy and ((trend_ok and rsi_ok) or meanrev_ok)) or (force_trade and can_buy)

            if enter:
                shares = (cash * (1.0 - fee)) / price
                cash = 0.0
                holding = True
                entry_price = price
                entry_i = i
                last_trade_i = i
        else:
            # EXIT
            hold_days = i - entry_i
            if hold_days < 0:
                hold_days = 0

            stop_hit = price <= entry_price * (1.0 - s.stop_loss)
            tp_hit = price >= entry_price * (1.0 + s.take_profit)

            trend_bad = sma_fast.iat[i] < sma_slow.iat[i]
            meanrev_exit = z.iat[i] >= s.z_sell
            rsi_exit = rsi.iat[i] >= s.rsi_sell

            exit_signal = (trend_bad and rsi_exit) or meanrev_exit or stop_hit or tp_hit
            force_exit = force_trade and (hold_days >= s.min_hold)
            time_exit = hold_days >= s.max_hold

            if (exit_signal and hold_days >= s.min_hold) or force_exit or time_exit or (i == len(df) - 1):
                cash = shares * price * (1.0 - fee)
                shares = 0.0
                holding = False
                last_trade_i = i
                cooldown_until = i + max(0, s.cooldown)

                trades_rows.append({
                    "BuyDate": dates[entry_i].date(),
                    "SellDate": dates[i].date(),
                    "BuyPrice": float(entry_price),
                    "SellPrice": float(price),
                    "HoldDays": int(hold_days),
                    "ExitReason": "signal" if (exit_signal and hold_days >= s.min_hold) else ("forced" if force_exit else ("max_hold" if time_exit else "eos")),
                    "Equity": float(cash),
                    "TradeReturn": (cash / equity_curve[entry_i] - 1.0) if entry_i >= 0 else None,
                })

    final_equity = cash if not holding else shares * float(close.iat[-1])
    total_return = final_equity - 1.0
    cagr = annualized_return(1.0, final_equity, df["Date"].iat[0], df["Date"].iat[-1])
    mdd = max_drawdown(equity_curve)

    years = max(1e-9, (df["Date"].iat[-1] - df["Date"].iat[0]).days / 365.25)
    trades_per_year = (len(trades_rows) / years) if years > 0 else 0.0

    # Score: reward CAGR, penalize drawdown, mildly penalize excessive churn
    score = cagr - s.dd_weight * mdd - s.trade_penalty * trades_per_year

    return FreeResult(
        strat=s,
        score=score,
        total_return=total_return,
        cagr=cagr,
        max_dd=mdd,
        trades=pd.DataFrame(trades_rows),
        trades_per_year=trades_per_year,
    )


def sample_free_strategy(rng: random.Random, fee: float, dd_weight: float, trade_penalty: float,
                         max_idle: int, min_hold: int, max_hold: int, cooldown: int) -> FreeStrategy:
    fast = rng.randint(5, 50)
    slow = rng.randint(fast + 5, 200)

    rsi_w = rng.randint(7, 30)
    rsi_buy = rng.uniform(20, 45)
    rsi_sell = rng.uniform(55, 80)

    z_w = rng.randint(10, 80)
    z_buy = rng.uniform(-2.5, -0.5)
    z_sell = rng.uniform(-0.5, 1.5)

    stop_loss = rng.uniform(0.03, 0.15)
    take_profit = rng.uniform(0.05, 0.30)

    return FreeStrategy(
        fast=fast, slow=slow,
        rsi_w=rsi_w, rsi_buy=rsi_buy, rsi_sell=rsi_sell,
        z_w=z_w, z_buy=z_buy, z_sell=z_sell,
        stop_loss=stop_loss, take_profit=take_profit,
        min_hold=min_hold, max_hold=max_hold, cooldown=cooldown, max_idle=max_idle,
        fee=fee, dd_weight=dd_weight, trade_penalty=trade_penalty
    )


def search_best_free(df: pd.DataFrame, sims: int, seed: int,
                     fee: float, dd_weight: float, trade_penalty: float,
                     max_idle: int, min_hold: int, max_hold: int, cooldown: int) -> List[FreeResult]:
    rng = random.Random(seed)
    ind = precompute_indicators(df["Close"])

    best: List[FreeResult] = []
    for _ in range(max(1, sims)):
        s = sample_free_strategy(rng, fee, dd_weight, trade_penalty, max_idle, min_hold, max_hold, cooldown)
        r = backtest_free(df, ind, s)

        if len(best) < 10:
            best.append(r)
            best.sort(key=lambda x: x.score, reverse=True)
        else:
            if r.score > best[-1].score:
                best[-1] = r
                best.sort(key=lambda x: x.score, reverse=True)

    return best


def label_signals(prices: pd.DataFrame, trades: pd.DataFrame) -> pd.DataFrame:
    out = prices.copy().sort_values("Date").reset_index(drop=True)
    out["Buy"] = 0
    out["Sell"] = 0
    out["Signal"] = 0

    if trades is None or trades.empty:
        return out

    t = trades.copy()
    t["BuyDate"] = pd.to_datetime(t["BuyDate"], errors="coerce")
    t["SellDate"] = pd.to_datetime(t["SellDate"], errors="coerce")

    dates = out["Date"]

    def mark_on_or_before(d: pd.Timestamp, col: str, sig: int):
        if pd.isna(d):
            return
        idxs = out.index[dates <= d]
        if len(idxs) == 0:
            return
        idx = int(idxs[-1])
        out.at[idx, col] = 1
        out.at[idx, "Signal"] = sig

    for _, r in t.iterrows():
        mark_on_or_before(r["BuyDate"], "Buy", 1)
        mark_on_or_before(r["SellDate"], "Sell", -1)

    return out


# =========================
# Plotting
# =========================
def plot_from_files(csv_path: Path):
    if not HAS_PLOTLY:
        print("Plotly not installed. Run: python -m pip install plotly")
        return

    prices = load_prices(csv_path)
    outs = output_paths_for(csv_path)
    trades_path = outs["trades"]

    if not trades_path.exists():
        print(f"No trades file found: {trades_path}")
        print("Run TEST/TRAIN first.")
        return

    trades = pd.read_csv(trades_path)
    if trades.empty:
        print("Trades file is empty.")
        return

    trades["BuyDate"] = pd.to_datetime(trades["BuyDate"], errors="coerce")
    trades["SellDate"] = pd.to_datetime(trades["SellDate"], errors="coerce")

    price_by_date = prices.set_index("Date")["Close"]

    def close_on_or_before(d: pd.Timestamp) -> Optional[float]:
        if pd.isna(d):
            return None
        if d in price_by_date.index:
            return float(price_by_date.loc[d])
        prev = price_by_date.loc[price_by_date.index <= d]
        if prev.empty:
            return None
        return float(prev.iloc[-1])

    buys_x, buys_y = [], []
    sells_x, sells_y = [], []

    for _, r in trades.iterrows():
        bd, sd = r["BuyDate"], r["SellDate"]
        by, sy = close_on_or_before(bd), close_on_or_before(sd)
        if by is not None and not pd.isna(bd):
            buys_x.append(bd); buys_y.append(by)
        if sy is not None and not pd.isna(sd):
            sells_x.append(sd); sells_y.append(sy)

    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=prices["Date"], y=prices["Close"],
        mode="lines", name="Close",
        hovertemplate="Date=%{x|%Y-%m-%d}<br>Close=%{y:.2f}<extra></extra>"
    ))
    fig.add_trace(go.Scatter(
        x=buys_x, y=buys_y, mode="markers",
        name="Buy", marker=dict(size=9, color="green"),
        hovertemplate="BUY<br>Date=%{x|%Y-%m-%d}<br>Close=%{y:.2f}<extra></extra>"
    ))
    fig.add_trace(go.Scatter(
        x=sells_x, y=sells_y, mode="markers",
        name="Sell", marker=dict(size=9, color="red"),
        hovertemplate="SELL<br>Date=%{x|%Y-%m-%d}<br>Close=%{y:.2f}<extra></extra>"
    ))

    fig.update_layout(
        title=f"{csv_path.stem} - Free Trading Strategy (buy/sell markers)",
        xaxis_title="Date",
        yaxis_title="Price",
        hovermode="x unified",
        dragmode="pan",
    )
    fig.show()


# =========================
# Runner (VS Code friendly)
# =========================
def prompt_ticker_until_found() -> Optional[Path]:
    while True:
        t = input("Enter stock ticker (blank to exit): ").strip()
        if t == "":
            return None
        p = find_stock_csv(t)
        if p is None:
            print(f"Could not find '{t}'. Looking in: {stock_data_dir()}")
            continue
        return p

def run_test(csv_path: Path):
    prices = load_prices(csv_path)

    best10 = search_best_free(
        df=prices,
        sims=SIMS_DEFAULT,
        seed=SEED_DEFAULT,
        fee=FEE_DEFAULT,
        dd_weight=DD_WEIGHT_DEFAULT,
        trade_penalty=TRADE_PENALTY_DEFAULT,
        max_idle=MAX_IDLE_DAYS_DEFAULT,
        min_hold=MIN_HOLD_DAYS_DEFAULT,
        max_hold=MAX_HOLD_DAYS_DEFAULT,
        cooldown=COOLDOWN_DAYS_DEFAULT,
    )
    best = best10[0]
    outs = output_paths_for(csv_path)

    best.trades.to_csv(outs["trades"], index=False)
    labeled = label_signals(prices, best.trades)
    labeled.to_csv(outs["labeled"], index=False)

    with open(outs["summary"], "w", encoding="utf-8") as f:
        f.write("Best free-trading strategy (no monthly/weekly quota)\n\n")
        f.write(str(best.strat) + "\n\n")
        f.write(f"Score: {best.score}\n")
        f.write(f"Total return: {best.total_return}\n")
        f.write(f"CAGR: {best.cagr}\n")
        f.write(f"Max drawdown: {best.max_dd}\n")
        f.write(f"Trades: {len(best.trades)}\n")
        f.write(f"Trades/year: {best.trades_per_year}\n\n")
        f.write(f"Trades CSV: {outs['trades']}\n")
        f.write(f"Labeled CSV (same filename as input): {outs['labeled']}\n")

    print("\nTop strategies:")
    for i, r in enumerate(best10, 1):
        print(
            f"{i:2d}) score={r.score: .6f} | total={r.total_return*100: .2f}% | "
            f"CAGR={r.cagr*100: .2f}% | maxDD={r.max_dd*100: .2f}% | "
            f"trades={len(r.trades)} | trades/yr={r.trades_per_year: .2f}"
        )

    print("\nSaved:")
    print(f"  Trades:  {outs['trades']}")
    print(f"  Labeled: {outs['labeled']}")
    print(f"  Summary: {outs['summary']}")

def main():
    print("\n=== StockBot Runner (no quotas) ===")
    print("1) Test/Train (find best buy/sell timing without monthly/weekly quotas)")
    print("2) Plot existing trades (interactive)")
    print("Blank exits.\n")

    while True:
        choice = input("Choose 1 or 2 (blank to exit): ").strip()
        if choice == "":
            return
        if choice not in ("1", "2"):
            print("Please enter 1, 2, or blank.")
            continue

        csv_path = prompt_ticker_until_found()
        if csv_path is None:
            return

        if choice == "1":
            run_test(csv_path)
        else:
            plot_from_files(csv_path)

        print("\nDone.\n")

if __name__ == "__main__":
    main()
