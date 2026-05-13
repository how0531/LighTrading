"""
rate_limit.py — 輕量級每路徑速率限制

不引入第三方依賴，自寫 token bucket。
key 用「path + client.host」組合，本地單機足夠。
"""
import time
import logging
from collections import defaultdict, deque
from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

# 各路徑的限制：(每窗最大次數, 窗口秒數)
_LIMITS: dict[str, tuple[int, float]] = {
    "/api/place_order": (5, 1.0),   # 5 req/sec
    "/api/login":       (3, 60.0),  # 3 次/分鐘
}

_buckets: dict[tuple[str, str], deque[float]] = defaultdict(deque)


def check_rate_limit(request: Request) -> None:
    """在 endpoint 入口呼叫；超量直接 raise 429。"""
    path = request.url.path
    cfg = _LIMITS.get(path)
    if cfg is None:
        return
    max_n, window_s = cfg
    client_host = request.client.host if request.client else "unknown"
    key = (path, client_host)
    now = time.monotonic()

    bucket = _buckets[key]
    # 清理超過窗的舊紀錄
    while bucket and (now - bucket[0]) > window_s:
        bucket.popleft()
    if len(bucket) >= max_n:
        retry = window_s - (now - bucket[0])
        raise HTTPException(status_code=429, detail={
            "code": "RATE_LIMITED",
            "user_msg": f"操作過快，請 {retry:.1f} 秒後再試",
        })
    bucket.append(now)
