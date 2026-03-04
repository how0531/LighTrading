import psutil

for p in psutil.process_iter(['pid', 'name', 'cmdline']):
    try:
        cmdline = getattr(p, 'cmdline', lambda: [])() or []
        if type(cmdline) is list and 'uvicorn' in [str(c).lower() for c in cmdline]:
            print(f"Killing Uvicorn PID: {p.info['pid']}")
            p.terminate()
    except Exception:
        pass
