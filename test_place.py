import requests

url = "http://localhost:8000/api/place_order"
payload = {
    "symbol": "2330",
    "action": "Buy",
    "price": 900,
    "qty": 1,
    "order_type": "ROD"
}
res = requests.post(url, json=payload)
print(res.json())
