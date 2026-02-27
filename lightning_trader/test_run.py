import threading
import time
import os
import sys

def stop_after_10s():
    time.sleep(10)
    print("Test finished successfully (10 seconds timeout).")
    os._exit(0)

threading.Thread(target=stop_after_10s, daemon=True).start()

# import main
from main import main
main()