import json
import datetime
import requests


class Helper:
    def __init__(self):
        self.api = "BT8UUAJIJ09B1IQF"
    #
    # def read(self):
    #     with open("stocks.json", "r") as file:
    #         data = json.load(file)
    #     return {i: list(v) for i, v in data.items() if i != "Counter"}
    #
    # def write(self):
    #     with open("stocks.json", "w", encoding="utf-8") as file:
    #         json.dump(self.data, file, indent=4)

    def get_stock_data(self, symbol, start_date, end_date):
        start_date = datetime.datetime.strptime(start_date, "%Y-%m-%d").date()
        end_date = datetime.datetime.strptime(end_date, "%Y-%m-%d").date()
        if start_date > end_date:
            raise ValueError("Start date cannot be in the future.")
        url = (
            "https://www.alphavantage.co/query"
            "?function=TIME_SERIES_DAILY"
            f"&symbol={symbol}"
            "&outputsize=full"
            f"&apikey={self.api}"
        )
        resp = requests.get(url)
        data = resp.json()
        time_series = data.get("Time Series (Daily)")
        if time_series is None:
            raise RuntimeError(f"Unexpected response: {data}")
        date_close_pairs = []
        for date_str, daily in time_series.items():
            date_obj = datetime.datetime.strptime(date_str, "%Y-%m-%d").date()
            if start_date <= date_obj <= end_date:
                close_price = float(daily["4. close"])
                date_close_pairs.append((int(datetime.datetime.combine(date_obj, datetime.time()).timestamp()), close_price))
        date_close_pairs.sort(key=lambda x: x[0])
        return date_close_pairs
