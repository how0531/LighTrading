import os
import sys
import time
from dotenv import load_dotenv
import shioaji as sj

load_dotenv("lightning_trader/backend/.env")

api = sj.Shioaji(simulation=True)
api.login(
    api_key=os.getenv("SHIOAJI_API_KEY"),
    secret_key=os.getenv("SHIOAJI_SECRET_KEY")
)

contract = api.Contracts.Stocks["2890"]
order = api.Order(
    price=30.0,
    quantity=1,
    action=sj.constant.Action.Buy,
    price_type=sj.constant.StockPriceType.LMT,
    order_type=sj.constant.OrderType.ROD,
    account=api.list_accounts()[0]
)

print("Placing external order...")
trade = api.place_order(contract, order)
print(trade)

time.sleep(3)
api.logout()
