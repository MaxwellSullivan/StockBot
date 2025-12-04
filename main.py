import csv
import datetime as dt
from typing import List, Dict, Any, Optional, Tuple
import json
import os
import requests
from helper import Helper

DATA_FOLDER = "stock_data"
THRESHOLD_JSON = "threshold_combos.json"
START_WALLET = 4000.0


def ensure_stock_csv(symbol: str) -> str:
    symbol_upper = symbol.upper()
    os.makedirs(DATA_FOLDER, exist_ok=True)
    csv_path = os.path.join(DATA_FOLDER, f"{symbol_upper}.csv")
    if os.path.exists(csv_path):
        return csv_path
    today = dt.date.today()
    start_date = today - dt.timedelta(days=365)
    start_str = start_date.strftime("%Y-%m-%d")
    end_str = today.strftime("%Y-%m-%d")
    helper = Helper()
    try:
        pairs = helper.get_stock_data(symbol_upper, start_str, end_str)
    except RuntimeError:
        pairs = fetch_daily_compact(symbol_upper, helper.api, start_str, end_str)
    if not pairs:
        raise RuntimeError(f"No data returned from API for {symbol_upper}.")
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Date", "Close/Last"])
        for ts, close in pairs:
            date_obj = dt.datetime.fromtimestamp(ts).date()
            date_str = date_obj.strftime("%m/%d/%Y")
            writer.writerow([date_str, f"${close:.2f}"])
    return csv_path


def fetch_daily_compact(
    symbol: str,
    api_key: str,
    start_str: str,
    end_str: str,
) -> List[Tuple[int, float]]:
    start_date = dt.datetime.strptime(start_str, "%Y-%m-%d").date()
    end_date = dt.datetime.strptime(end_str, "%Y-%m-%d").date()
    url = (
        "https://www.alphavantage.co/query"
        "?function=TIME_SERIES_DAILY"
        f"&symbol={symbol}"
        "&outputsize=compact"
        f"&apikey={api_key}"
    )
    resp = requests.get(url)
    data = resp.json()
    time_series = data.get("Time Series (Daily)")
    if time_series is None:
        raise RuntimeError(f"Fallback request also failed: {data}")
    pairs: List[Tuple[int, float]] = []
    for date_str, daily in time_series.items():
        date_obj = dt.datetime.strptime(date_str, "%Y-%m-%d").date()
        if start_date <= date_obj <= end_date:
            close_price = float(daily["4. close"])
            ts = int(dt.datetime.combine(date_obj, dt.time()).timestamp())
            pairs.append((ts, close_price))
    pairs.sort(key=lambda x: x[0])
    return pairs


def load_prices_from_csv(csv_path: str) -> List[float]:
    prices: List[float] = []
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            close_str = row["Close/Last"]
            close_str = close_str.replace("$", "").replace(",", "").strip()
            prices.append(float(close_str))
    if not prices:
        raise RuntimeError(f"No prices found in {csv_path}")
    return prices


def clamp_min_max(value: int, min_val: int, max_val: int) -> int:
    return max(min_val, min(value, max_val))


def biased_trader(
    prices: List[float],
    start_wallet: float,
    sell_pct_thresh: float,
    buy_pct_thresh: float,
    max_lookback_days: int = 30,
    silent: bool = True,
    json_filename: Optional[str] = None,
) -> Dict[str, Any]:
    wallet = start_wallet
    shares: List[List[float]] = []  # [buy_price, amount]
    last_decision = "HOLD"
    last_amount = 0
    last_action_price = 0.0
    for i in range(1, len(prices)):
        price = prices[i]
        last_decision = "HOLD"
        last_amount = 0
        last_action_price = 0.0
        for lot in shares[:]:
            buy_price, amount = lot
            profit_pct = ((price - buy_price) / buy_price) * 100 if buy_price != 0 else 0.0
            if buy_price < price and profit_pct > sell_pct_thresh:
                wallet += amount * price
                shares.remove(lot)
                last_amount += amount
                last_action_price = price
                last_decision = "SELL"
        if wallet > price:
            highest_percent = 0.0  # most negative change (<= 0)
            max_back = clamp_min_max(max_lookback_days + 1, 1, i)
            for x in range(1, max_back):
                prev_price = prices[i - x]
                if price < prev_price:
                    drop_pct = ((price - prev_price) / prev_price) * 100  # negative
                    if drop_pct < highest_percent:
                        highest_percent = drop_pct
            if highest_percent < -buy_pct_thresh:
                amount = 0
                for _ in range(1, int(abs(highest_percent) + 1)):
                    if wallet > price:
                        wallet -= price
                        amount += 1
                if amount > 0:
                    shares.append([price, amount])
                    last_amount = amount
                    last_action_price = price
                    last_decision = "BUY"
    final_price = prices[-1]
    total_shares = sum(amount for _, amount in shares)
    final_value = wallet + total_shares * final_price
    profit = final_value - start_wallet
    result = {
        "final_wallet": wallet,
        "final_shares": shares,
        "final_value": final_value,
        "profit": profit,
        "sell_pct_thresh": sell_pct_thresh,
        "buy_pct_thresh": buy_pct_thresh,
        "last_decision": last_decision,
        "last_amount": last_amount,
        "last_action_price": last_action_price,
        "last_price": final_price,
    }
    if json_filename is not None:
        with open(json_filename, "w") as f:
            json.dump(result, f, indent=2)
    return result


def print_progress_bar(percent: int) -> None:
    bar_len = 30
    filled = int(bar_len * percent / 100)
    bar = "#" * filled + "-" * (bar_len - filled)
    print(f"\rCalculating [{bar}] {percent:3d}%", end="", flush=True)


def grid_search_thresholds_with_progress(
    prices: List[float],
    start_wallet: float,
) -> Tuple[Dict[str, Any], List[Dict[str, float]]]:
    sell_values = [i / 10.0 for i in range(1, 200 + 1)]
    buy_values = [i / 10.0 for i in range(1, 200 + 1)]
    total_iters = len(sell_values) * len(buy_values)
    best_combo: Dict[str, Any] = {}
    best_profit = float("-inf")
    combos: List[Dict[str, float]] = []
    count = 0
    last_percent_shown = -1
    for sell_thresh in sell_values:
        for buy_thresh in buy_values:
            count += 1
            percent = int(count * 100 / total_iters)
            if percent != last_percent_shown:
                print_progress_bar(percent)
                last_percent_shown = percent
            res = biased_trader(
                prices,
                start_wallet=start_wallet,
                sell_pct_thresh=sell_thresh,
                buy_pct_thresh=buy_thresh,
                silent=True,
                json_filename=None,
            )
            profit = res["profit"]
            combos.append({
                "sell_pct_thresh": sell_thresh,
                "buy_pct_thresh": buy_thresh,
                "profit": profit,
            })
            if profit > best_profit:
                best_profit = profit
                best_combo = {
                    "sell_pct_thresh": sell_thresh,
                    "buy_pct_thresh": buy_thresh,
                    "profit": profit,
                }
    print_progress_bar(100)
    print()  # newline
    combos.sort(key=lambda c: c["profit"], reverse=True)
    return best_combo, combos


def load_thresholds() -> Dict[str, Any]:
    try:
        with open(THRESHOLD_JSON, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_thresholds(data: Dict[str, Any]) -> None:
    with open(THRESHOLD_JSON, "w") as f:
        json.dump(data, f, indent=2)


def get_or_optimize_thresholds(
    symbol: str,
    prices: List[float],
    start_wallet: float,
) -> Tuple[float, float]:
    key = symbol.upper()
    all_thresh = load_thresholds()
    if key in all_thresh:
        entry = all_thresh[key]
        sell = float(entry["sell_pct_thresh"])
        buy = float(entry["buy_pct_thresh"])
        return sell, buy
    best_combo, _ = grid_search_thresholds_with_progress(prices, start_wallet)
    sell = float(best_combo["sell_pct_thresh"])
    buy = float(best_combo["buy_pct_thresh"])
    all_thresh[key] = {
        "sell_pct_thresh": sell,
        "buy_pct_thresh": buy,
    }
    save_thresholds(all_thresh)
    return sell, buy


def main():
    while True:
        symbol = input("Enter stock symbol (blank to quit): ").strip()
        if not symbol:
            break
        symbol_upper = symbol.upper()
        try:
            csv_path = ensure_stock_csv(symbol_upper)
            prices = load_prices_from_csv(csv_path)
            sell_thresh, buy_thresh = get_or_optimize_thresholds(
                symbol_upper, prices, START_WALLET
            )
            result = biased_trader(
                prices,
                start_wallet=START_WALLET,
                sell_pct_thresh=sell_thresh,
                buy_pct_thresh=buy_thresh,
                silent=True,
                json_filename=None,
            )
            decision = result["last_decision"]
            amount = result["last_amount"]
            if decision == "BUY" and amount > 0:
                print(f"{symbol_upper}: BUY {amount} shares")
            elif decision == "SELL" and amount > 0:
                print(f"{symbol_upper}: SELL {amount} shares")
            else:
                print(f"{symbol_upper}: HOLD")
        except Exception as e:
            print(f"Error for {symbol_upper}: {e}")


if __name__ == "__main__":
    main()
