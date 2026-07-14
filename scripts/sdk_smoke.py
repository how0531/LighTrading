#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sdk_smoke.py — 真 Shioaji SDK（模擬環境）行為冒煙腳本

═══════════════════════════════════════════════════════════════════════════
為什麼有這支腳本
───────────────────────────────────────────────────────────────────────────
本專案「所有後端測試」都對 lightning_trader/tests/fake_shioaji.py 這個
「假 SDK 替身」驗證。假 SDK 是我方對真 Shioaji 行為的『假設』——但真 SDK 在
模擬 / 正式環境的實際回報，過去已兩次與假設不符而造成資金 bug（去重失效導致
已實現損益翻倍、撤單非同步造成超額建倉）。

這支腳本在『有真 shioaji wheel + 模擬帳戶』的環境登入，依序做最小限度的
下單 / 查詢 / 改單 / 撤單，並把**真實回傳的欄位結構 dump 成 JSON**（敏感值遮蔽），
供人工對照 docs/SDK_GAP_TABLE.md 的「我方假設」欄，填入「真實行為」欄。

★ 這支腳本『不』在 CI / 開發機自動跑，也無法在無 shioaji 的環境跑。
  它是一次性的落差校驗工具，跑完把輸出貼進落差表即可。

═══════════════════════════════════════════════════════════════════════════
安全前提（務必先讀）
───────────────────────────────────────────────────────────────────────────
1. **僅限模擬（SIMULATION=true）**。腳本開頭硬檢查 .env 的 SIMULATION；
   非 true 一律 sys.exit(2) 拒跑。絕不在正式帳戶執行。
2. **掛遠價、避免成交**：預設抓合約 limit_down（買）/ limit_up（賣）為委託價，
   是當日「合法但幾乎不可能成交」的最遠價；qty 預設 1。目的是製造一筆「活躍
   但不成交」的委託，好觀察下單/改單/撤單三步的真實回報。
3. **自動撤單**：腳本結尾（含各步例外路徑）都會嘗試把自己掛的那筆單撤掉，
   不留活躍委託。即便如此，跑完仍請自行到券商端確認無殘留委託 / 部位。
4. 模擬環境的撮合與正式不完全相同——本腳本觀察的是『SDK 回傳的欄位結構與
   時序』，欄位語意結論以此為準；但「模擬 vs 正式」本身也是一個落差項，
   關鍵資金邏輯上線前仍建議在正式盤前用最小口數再校驗一次。

═══════════════════════════════════════════════════════════════════════════
使用方式
───────────────────────────────────────────────────────────────────────────
  # 1. 確認專案根目錄有 .env（可從 .env.example 複製），且：
  #      SIMULATION=true
  #      API_KEY=...        （或 SHIOAJI_API_KEY）
  #      SECRET_KEY=...      （或 SHIOAJI_SECRET_KEY）
  # 2. 確認已安裝真 shioaji：  pip show shioaji
  # 3. 於專案根目錄執行：
  #      python3 scripts/sdk_smoke.py
  #    可選環境變數覆寫：
  #      SMOKE_SYMBOL=2330   下單標的（預設 2330 台積電）
  #      SMOKE_QTY=1         口數（預設 1）
  #      SMOKE_ACTION=Buy    Buy / Sell（預設 Buy → 掛 limit_down 遠價）
  #      SMOKE_PRICE=0       手動指定委託價；>0 時覆寫「自動遠價」邏輯
  #                          （請自行確保是遠離市價的合法 tick 價）
  # 4. 把終端輸出（或搭配 `> smoke_out.txt` 存檔）逐項對照
  #    docs/SDK_GAP_TABLE.md，填「真實行為」欄。

免責：本腳本會對模擬帳戶送出真實 API 呼叫（下單/撤單）。執行者需自負在
正確（模擬）帳戶執行之責。作者不對誤用於正式帳戶造成的後果負責。
═══════════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────
# 敏感欄位遮蔽：key 名含以下任一子字串（不分大小寫）→ 值以 <masked:type> 取代
# ─────────────────────────────────────────────────────────────────────────
_SENSITIVE_HINTS = (
    "person_id", "account_id", "api_key", "apikey", "secret", "signature",
    "sign", "token", "ca_passwd", "password", "passwd", "cust", "id_card",
)


def _is_sensitive(key: str) -> bool:
    k = str(key).lower()
    return any(h in k for h in _SENSITIVE_HINTS)


def _mask_value(key, value):
    """敏感欄位只保留型別與長度線索，不外洩內容。"""
    if value is None:
        return None
    s = str(value)
    return f"<masked:{type(value).__name__}:len={len(s)}>"


def to_jsonable(obj, depth: int = 0, max_depth: int = 6):
    """把任意 shioaji 物件（多為 pydantic model / SimpleNamespace）遞迴轉成
    JSON-friendly 結構，並在每個欄位附上『型別』線索——欄位型別本身就是落差
    資訊（例如 deal_quantity 是 int 還是 str、ts 是秒/毫秒/奈秒）。

    - 敏感 key → 遮蔽
    - 逐值標註型別：純量回原值，容器遞迴，未知物件展開其公開屬性
    - 深度 / 型別防爆：避免無窮遞迴或把整棵 Contracts 樹拉出來
    """
    if depth > max_depth:
        return f"<max_depth:{type(obj).__name__}>"

    # 純量
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    if isinstance(obj, str):
        return obj
    # bytes
    if isinstance(obj, (bytes, bytearray)):
        return f"<bytes:len={len(obj)}>"
    # datetime 類
    if isinstance(obj, datetime):
        return {"__type__": "datetime", "value": obj.isoformat()}

    # dict
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if _is_sensitive(k):
                out[str(k)] = _mask_value(k, v)
            else:
                out[str(k)] = to_jsonable(v, depth + 1, max_depth)
        return out

    # list / tuple / set
    if isinstance(obj, (list, tuple, set)):
        seq = list(obj)
        # 避免超長序列（例如整批合約）淹沒輸出
        capped = seq[:20]
        rendered = [to_jsonable(v, depth + 1, max_depth) for v in capped]
        if len(seq) > len(capped):
            rendered.append(f"<...{len(seq) - len(capped)} more>")
        return rendered

    # pydantic v1 model：有 .dict()
    for meth in ("dict", "model_dump"):
        fn = getattr(obj, meth, None)
        if callable(fn):
            try:
                d = fn()
                if isinstance(d, dict):
                    return {
                        "__type__": type(obj).__name__,
                        **to_jsonable(d, depth + 1, max_depth),
                    }
            except Exception:
                pass

    # 一般物件：展開 __dict__ / vars，附型別標註
    data = None
    try:
        data = vars(obj)
    except TypeError:
        data = None

    if isinstance(data, dict) and data:
        rendered = {"__type__": type(obj).__name__}
        for k, v in data.items():
            if str(k).startswith("_"):
                continue
            if _is_sensitive(k):
                rendered[str(k)] = _mask_value(k, v)
            else:
                rendered[str(k)] = {
                    "_pytype": type(v).__name__,
                    "value": to_jsonable(v, depth + 1, max_depth),
                }
        return rendered

    # 最後手段：掃公開屬性（過濾 callable）
    rendered = {"__type__": type(obj).__name__}
    got_any = False
    for name in dir(obj):
        if name.startswith("_"):
            continue
        try:
            v = getattr(obj, name)
        except Exception:
            continue
        if callable(v):
            continue
        got_any = True
        if _is_sensitive(name):
            rendered[name] = _mask_value(name, v)
        else:
            rendered[name] = {
                "_pytype": type(v).__name__,
                "value": to_jsonable(v, depth + 1, max_depth),
            }
    if not got_any:
        return f"<{type(obj).__name__}:{str(obj)[:80]}>"
    return rendered


def dump(label: str, obj) -> None:
    """印一個標記段落 + JSON dump（敏感值已遮蔽）。"""
    print(f"\n===== {label} =====")
    try:
        print(json.dumps(to_jsonable(obj), ensure_ascii=False, indent=2, default=str))
    except Exception as e:
        print(f"[dump 失敗 fallback repr] {e}")
        print(repr(obj)[:2000])


def step(name: str):
    """裝飾用小工具：印步驟標頭。"""
    print("\n" + "#" * 72)
    print(f"# {name}")
    print("#" * 72)


# ─────────────────────────────────────────────────────────────────────────
# .env 讀取 + 硬安全檢查
# ─────────────────────────────────────────────────────────────────────────
def load_env_and_guard() -> dict:
    """讀 .env，硬檢查 SIMULATION=true，回傳設定 dict。非模擬 → 直接退出。"""
    try:
        from dotenv import load_dotenv  # python-dotenv，專案既有相依
        load_dotenv()
    except Exception as e:
        print(f"[警告] 無法載入 python-dotenv（{e}），改用現有環境變數。")

    def _env(*names, default=""):
        for n in names:
            v = os.getenv(n)
            if v:
                return v
        return default

    sim_raw = _env("SHIOAJI_SIMULATION", "SIMULATION", default="true")
    simulation = str(sim_raw).strip().lower() in ("true", "1", "yes")

    print("=" * 72)
    print("sdk_smoke.py — 真 Shioaji SDK 行為冒煙（模擬環境）")
    print(f"時間：{datetime.now().isoformat()}")
    print(f"SIMULATION（來自 .env）：{sim_raw!r} → simulation={simulation}")
    print("=" * 72)

    if not simulation:
        print("\n[拒絕執行] SIMULATION 非 true。")
        print("本腳本只允許在『模擬帳戶』執行，避免對正式帳戶送出下單/撤單。")
        print("請在 .env 設 SIMULATION=true 後再跑。")
        sys.exit(2)

    api_key = _env("SHIOAJI_API_KEY", "API_KEY")
    secret_key = _env("SHIOAJI_SECRET_KEY", "SECRET_KEY")
    if not api_key or not secret_key:
        print("\n[拒絕執行] 缺 API_KEY / SECRET_KEY（或 SHIOAJI_* 前綴）。")
        print("請在 .env 填入模擬帳戶金鑰後再跑。")
        sys.exit(2)

    return {
        "simulation": simulation,
        "api_key": api_key,
        "secret_key": secret_key,
        "symbol": _env("SMOKE_SYMBOL", default="2330"),
        "qty": int(_env("SMOKE_QTY", default="1") or "1"),
        "action": _env("SMOKE_ACTION", default="Buy"),
        "price_override": float(_env("SMOKE_PRICE", default="0") or "0"),
    }


# ─────────────────────────────────────────────────────────────────────────
# 遠價推導：取合約 limit_down（買）/ limit_up（賣），退回 snapshot 推估
# ─────────────────────────────────────────────────────────────────────────
def pick_far_price(api, contract, action_is_buy: bool, override: float) -> float:
    """挑一個『合法但幾乎不可能成交』的委託價。

    Buy → limit_down（當日最低合法價，沒人會掛更低賣單去撮它）
    Sell → limit_up（同理）
    這兩個值本身已是合法 tick 價，不需再處理 tick 進位。
    """
    if override and override > 0:
        print(f"[遠價] 使用手動 SMOKE_PRICE={override}")
        return override

    lu = float(getattr(contract, "limit_up", 0) or 0)
    ld = float(getattr(contract, "limit_down", 0) or 0)
    if action_is_buy and ld > 0:
        print(f"[遠價] Buy → 合約 limit_down={ld}")
        return ld
    if (not action_is_buy) and lu > 0:
        print(f"[遠價] Sell → 合約 limit_up={lu}")
        return lu

    # 合約沒帶漲跌停 → 用 snapshot 推估（reference ± 遠離）
    try:
        snaps = api.snapshots([contract])
        if snaps:
            s = snaps[0]
            ref = float(getattr(s, "reference", 0) or getattr(s, "close", 0) or 0)
            if ref > 0:
                far = round(ref * (0.85 if action_is_buy else 1.15), 2)
                print(f"[遠價] 由 snapshot reference={ref} 推估遠價={far}"
                      f"（注意：未套 tick 進位，若被拒單請改用 SMOKE_PRICE）")
                return far
    except Exception as e:
        print(f"[遠價] snapshot 推估失敗：{e}")

    print("[遠價] 無法自動推導遠價 → 請設 SMOKE_PRICE 明確指定後重跑。")
    return 0.0


# ─────────────────────────────────────────────────────────────────────────
# cleanup：撤掉本腳本掛的那筆單
# ─────────────────────────────────────────────────────────────────────────
def cleanup_cancel(api, trade, tag: str = "") -> None:
    """盡力把 trade 撤掉，並印撤單回傳；例外一律印出（欄位/時序都是落差資訊）。"""
    if trade is None:
        return
    try:
        step(f"CLEANUP：撤掉本腳本掛的委託 {tag}")
        for acc in api.list_accounts():
            try:
                api.update_status(acc)
            except Exception:
                pass
        ret = api.cancel_order(trade)
        dump("cancel_order（cleanup）回傳", ret)
    except Exception as e:
        print(f"[cleanup 撤單例外] {type(e).__name__}: {e}")


# ─────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────
def main() -> int:
    cfg = load_env_and_guard()

    # 真 shioaji（不 import 專案 core，避免 ShioajiClient 起 timer/callback 副作用）
    try:
        import shioaji as sj
        from shioaji.constant import (
            Action, OrderType, StockPriceType, StockOrderLot, StockOrderCond,
        )
    except Exception as e:
        print(f"\n[拒絕執行] 無法 import 真 shioaji：{e}")
        print("請先安裝真 shioaji wheel（pip install shioaji）後再跑。")
        return 2

    action_is_buy = str(cfg["action"]).strip().lower() != "sell"
    action = Action.Buy if action_is_buy else Action.Sell

    api = sj.Shioaji(simulation=True)
    my_trade = None

    # ── 登入 ──
    step("STEP 0：登入模擬帳戶 + list_accounts")
    try:
        accounts = api.login(api_key=cfg["api_key"], secret_key=cfg["secret_key"])
        dump("login() 回傳（帳號清單）", accounts)
        acc_list = api.list_accounts()
        dump("list_accounts() 回傳", acc_list)
        stock_acc = next((a for a in acc_list if "Stock" in a.__class__.__name__), None)
        futopt_acc = next((a for a in acc_list if "Future" in a.__class__.__name__), None)
        print(f"[帳號] stock_account={'有' if stock_acc else '無'} "
              f"futopt_account={'有' if futopt_acc else '無'}")
    except Exception as e:
        print(f"[登入例外] {type(e).__name__}: {e}")
        return 1

    # ── 取合約 ──
    step("STEP 0.5：取得下單合約")
    contract = None
    try:
        contract = api.Contracts.Stocks.get(cfg["symbol"])
        dump(f"合約 {cfg['symbol']}（Contracts.Stocks.get）", contract)
        if contract is None:
            print(f"[終止] 找不到股票合約 {cfg['symbol']}，請改 SMOKE_SYMBOL。")
            return 1
        print(f"[合約] security_type={getattr(contract, 'security_type', '?')} "
              f"limit_up={getattr(contract, 'limit_up', '?')} "
              f"limit_down={getattr(contract, 'limit_down', '?')}")
    except Exception as e:
        print(f"[取合約例外] {type(e).__name__}: {e}")
        return 1

    account = stock_acc
    if account is None:
        print("[終止] 無股票帳號可用，無法下單。")
        return 1

    far_price = pick_far_price(api, contract, action_is_buy, cfg["price_override"])
    if far_price <= 0:
        print("[終止] 無有效遠價，避免誤下市價/近價單，中止。")
        return 1

    # ─────────────────────────────────────────────────────────────────────
    # STEP 1：place_order → 觀察下單當下的回傳結構
    #   關鍵：ordno 當下是否為空？seqno / id 各是什麼？status.name 是什麼？
    # ─────────────────────────────────────────────────────────────────────
    step("STEP 1：place_order（限價遠掛，避免成交）")
    print(f"[下單] {cfg['symbol']} {action.value} qty={cfg['qty']} @ {far_price} (ROD/LMT/Cash/Common)")
    try:
        order = api.Order(
            price=far_price,
            quantity=cfg["qty"],
            action=action,
            price_type=StockPriceType.LMT,
            order_type=OrderType.ROD,
            order_lot=StockOrderLot.Common,
            order_cond=StockOrderCond.Cash,
            account=account,
        )
        dump("api.Order(...) 組出的 order 物件", order)
        my_trade = api.place_order(contract, order)
        dump("place_order() 回傳 trade 物件（★重點）", my_trade)

        # 把幾個資金邏輯關心的欄位單獨凸顯
        o = getattr(my_trade, "order", None)
        s = getattr(my_trade, "status", None)
        print("\n[★ 下單當下關鍵欄位快照]")
        print(f"  order.ordno   = {getattr(o, 'ordno', '<no attr>')!r}   "
              f"← 下單當下是否為空？（我方假設：非空）")
        print(f"  order.seqno   = {getattr(o, 'seqno', '<no attr>')!r}")
        print(f"  order.id      = {getattr(o, 'id', '<no attr>')!r}")
        status_obj = getattr(s, "status", None)
        print(f"  status.status = {getattr(status_obj, 'name', status_obj)!r}")
        print(f"  status.deal_quantity = "
              f"{getattr(s, 'deal_quantity', '<no attr>')!r} "
              f"(型別 {type(getattr(s, 'deal_quantity', None)).__name__})")
    except Exception as e:
        print(f"[place_order 例外] {type(e).__name__}: {e}")
        # 例外本身即落差資訊（欄位名/型別錯），但沒單可撤，直接往下查詢
        my_trade = None

    # 給交易所/券商一點回報時間
    time.sleep(1.5)

    # ─────────────────────────────────────────────────────────────────────
    # STEP 2：update_status + list_trades → 觀察委託與成交欄位
    #   關鍵：Deal 是否有 exchange_seq / seq？deal_quantity 型別？ordno 是否已補上？
    # ─────────────────────────────────────────────────────────────────────
    step("STEP 2：update_status + list_trades（委託/成交欄位）")
    try:
        for acc in api.list_accounts():
            try:
                api.update_status(acc)
            except Exception as e:
                print(f"[update_status({getattr(acc,'account_type','?')}) 例外] "
                      f"{type(e).__name__}: {e}")
        trades = api.list_trades()
        dump("list_trades() 全部回傳", trades)

        print("\n[★ 逐筆委託/成交關鍵欄位]")
        for i, t in enumerate(trades or []):
            o = getattr(t, "order", None)
            st = getattr(t, "status", None)
            sname = getattr(getattr(st, "status", None), "name", None)
            dq = getattr(st, "deal_quantity", None)
            print(f"  trade[{i}]: ordno={getattr(o,'ordno',None)!r} "
                  f"seqno={getattr(o,'seqno',None)!r} status={sname!r} "
                  f"deal_quantity={dq!r}({type(dq).__name__})")
            deals = getattr(st, "deals", None) or []
            for j, d in enumerate(deals):
                print(f"    deal[{j}]: "
                      f"seq={getattr(d,'seq','<none>')!r} "
                      f"exchange_seq={getattr(d,'exchange_seq','<none>')!r} "
                      f"price={getattr(d,'price',None)!r} "
                      f"quantity={getattr(d,'quantity',None)!r}"
                      f"({type(getattr(d,'quantity',None)).__name__}) "
                      f"ts={getattr(d,'ts','<none>')!r}")
                dump(f"    deal[{j}] 完整結構（★去重鍵所需）", d)
    except Exception as e:
        print(f"[list_trades 例外] {type(e).__name__}: {e}")

    # ─────────────────────────────────────────────────────────────────────
    # STEP 3：update_order（改價）→ 觀察回傳
    #   我方 update_order 假設可用 api.update_order(trade=trade, price=new) 改價，
    #   且回傳可忽略；這裡把回傳 dump 出來看實際結構與是否同步反映。
    # ─────────────────────────────────────────────────────────────────────
    step("STEP 3：update_order 改價（觀察回傳）")
    if my_trade is not None:
        try:
            # 往「更遠」方向改（買再降一個 tick 級距；用 override 或小幅下修）
            new_price = round(far_price * 0.99, 2) if action_is_buy else round(far_price * 1.01, 2)
            print(f"[改價] {far_price} → {new_price}")
            ret = api.update_order(trade=my_trade, price=new_price)
            dump("update_order(price=...) 回傳", ret)
            time.sleep(1.0)
            for acc in api.list_accounts():
                try:
                    api.update_status(acc)
                except Exception:
                    pass
            # 改價後再看該筆委託的 order.price 是否已反映
            for t in api.list_trades() or []:
                o = getattr(t, "order", None)
                if str(getattr(o, "ordno", "")) == str(getattr(getattr(my_trade, "order", None), "ordno", "")) \
                        or str(getattr(o, "seqno", "")) == str(getattr(getattr(my_trade, "order", None), "seqno", "")):
                    print(f"[改價後] 該委託 order.price = {getattr(o,'price',None)!r} "
                          f"status={getattr(getattr(t.status,'status',None),'name',None)!r}")
        except Exception as e:
            print(f"[update_order 例外] {type(e).__name__}: {e}")
    else:
        print("[跳過] STEP 1 未成功掛單，無單可改。")

    # ─────────────────────────────────────────────────────────────────────
    # STEP 4：cancel_order → 觀察撤單是否『同步反映』還是需再 update_status
    #   我方部分路徑（cancel_orders_by_action_price / cancel_all）fire-and-forget，
    #   假設同步生效；CHASE 的 confirm_order_cancelled 則靠輪詢 update_status。
    #   這裡撤單後『立刻』看一次、隔一段再 update_status 看一次，對照時序落差。
    # ─────────────────────────────────────────────────────────────────────
    step("STEP 4：cancel_order（撤單時序：同步 vs 需再 update_status）")
    if my_trade is not None:
        try:
            def _snap_status():
                for t in api.list_trades() or []:
                    o = getattr(t, "order", None)
                    if str(getattr(o, "ordno", "")) == str(getattr(getattr(my_trade,"order",None),"ordno","")) \
                            or str(getattr(o, "seqno", "")) == str(getattr(getattr(my_trade,"order",None),"seqno","")):
                        return getattr(getattr(t.status, "status", None), "name", None)
                return "<不在 list_trades>"

            print(f"[撤單前] status = {_snap_status()!r}")
            ret = api.cancel_order(my_trade)
            dump("cancel_order() 回傳（★重點）", ret)

            # (a) 撤單後『立即』不做 update_status，直接查（測是否同步反映）
            print(f"[撤單後 立即查、未 update_status] status = {_snap_status()!r} "
                  f"← 我方 cancel_all/by_price 假設此時已生效")

            # (b) 隔一段 + update_status 再查（測是否需刷新才收斂）
            time.sleep(1.0)
            for acc in api.list_accounts():
                try:
                    api.update_status(acc)
                except Exception:
                    pass
            print(f"[撤單後 update_status 後] status = {_snap_status()!r} "
                  f"← CHASE confirm_order_cancelled 假設輪詢 update_status 後收斂")
            my_trade = None  # 已撤，cleanup 不需再撤
        except Exception as e:
            print(f"[cancel_order 例外] {type(e).__name__}: {e}")
    else:
        print("[跳過] 無單可撤。")

    # ─────────────────────────────────────────────────────────────────────
    # STEP 5：list_positions / account_balance → 欄位結構
    # ─────────────────────────────────────────────────────────────────────
    step("STEP 5：list_positions / account_balance（欄位結構）")
    try:
        for acc in api.list_accounts():
            atype = getattr(acc, "account_type", None) or getattr(acc, "category", "?")
            try:
                positions = api.list_positions(acc)
                dump(f"list_positions(account_type={atype})", positions)
                for k, p in enumerate(positions or []):
                    print(f"  pos[{k}]: code={getattr(p,'code',None)!r} "
                          f"quantity={getattr(p,'quantity',None)!r}"
                          f"({type(getattr(p,'quantity',None)).__name__}) "
                          f"direction={getattr(p,'direction',None)!r} "
                          f"price={getattr(p,'price',None)!r} "
                          f"pnl={getattr(p,'pnl',None)!r}")
            except Exception as e:
                print(f"[list_positions({atype}) 例外] {type(e).__name__}: {e}")
    except Exception as e:
        print(f"[list_positions 外層例外] {type(e).__name__}: {e}")

    try:
        for acc in api.list_accounts():
            try:
                bal = api.account_balance(acc)
                dump(f"account_balance(account_type="
                     f"{getattr(acc,'account_type','?')})", bal)
            except Exception as e:
                print(f"[account_balance 例外] {type(e).__name__}: {e}")
                break
    except Exception as e:
        print(f"[account_balance 外層例外] {type(e).__name__}: {e}")

    # ── 收尾：確保沒有殘留自己的委託 ──
    cleanup_cancel(api, my_trade, tag="(結尾保險)")

    try:
        for acc in api.list_accounts():
            try:
                api.update_status(acc)
            except Exception:
                pass
        step("結尾：最終 list_trades（確認無殘留活躍委託）")
        dump("最終 list_trades()", api.list_trades())
    except Exception as e:
        print(f"[結尾 list_trades 例外] {type(e).__name__}: {e}")

    try:
        api.logout()
    except Exception:
        pass

    print("\n" + "=" * 72)
    print("完成。請把以上輸出逐項對照 docs/SDK_GAP_TABLE.md，填「真實行為」欄。")
    print("再次提醒：請自行確認券商端無殘留委託 / 非預期部位。")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[中斷] 使用者中止。請自行確認券商端無殘留委託。")
        sys.exit(130)
