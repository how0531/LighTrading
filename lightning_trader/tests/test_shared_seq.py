"""
Sprint 0 S0-7 回歸：callback_seq 與 snapshot_seq 必須是兩條獨立的單調遞增流，
互不影響、且向後相容的 generate_order_seq() 也仍可呼叫。
"""
from backend import shared


def test_callback_seq_strictly_increasing():
    a = shared.generate_callback_seq()
    b = shared.generate_callback_seq()
    c = shared.generate_callback_seq()
    assert a < b < c


def test_snapshot_seq_strictly_increasing():
    a = shared.generate_snapshot_seq()
    b = shared.generate_snapshot_seq()
    c = shared.generate_snapshot_seq()
    assert a < b < c


def test_callback_and_snapshot_are_independent():
    """關鍵：兩條 seq 應互不干擾——
    snapshot_seq 連抽 100 次不會把 callback_seq 也往上加。"""
    cb_before = shared.generate_callback_seq()
    snap_before = shared.generate_snapshot_seq()
    for _ in range(100):
        shared.generate_snapshot_seq()
    cb_after = shared.generate_callback_seq()
    snap_after = shared.generate_snapshot_seq()
    assert cb_after - cb_before == 1, "callback_seq 不該被 snapshot_seq 影響"
    assert snap_after - snap_before == 101


def test_generate_order_seq_back_compat():
    """舊呼叫端應仍可運作，且 generate_order_seq() 路由到 snapshot 流"""
    before = shared.generate_snapshot_seq()
    after = shared.generate_order_seq()
    assert after > before


def test_seq_thread_safe_under_concurrent_writes():
    """N threads * M iter 各自抽 seq 應全部 unique（itertools.count 在 CPython 為原子）"""
    import threading
    seen = set()
    lock = threading.Lock()

    def worker():
        local = [shared.generate_callback_seq() for _ in range(500)]
        with lock:
            seen.update(local)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 8 threads * 500 = 4000 個值，全 unique 表示無 race
    assert len(seen) == 4000
