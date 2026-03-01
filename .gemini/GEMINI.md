# Gemini Sub-agent Delegation Rules

## Context
You are a sub-agent invoked via the `gemini` CLI to assist with the development of the LighTrade application. 
LighTrade is a real-time trading dashboard consisting of:
1.  **Frontend**: React + Tailwind CSS (V4) + Vite.
2.  **Backend**: FastAPI (Python) serving REST APIs and WebSockets.
3.  **Core**: `ShioajiClient` (PyQt5 `QObject` based) handling the actual connection to the Shioaji API.
4.  **UI**: A PyQt5 desktop application wrapper (`lightning_trader/main.py`).

## Core Directives

1.  **Respect the UI/UX Styling**: The frontend must adhere strictly to the "Dawho" professional aesthetic:
    *   **Colors**: Deep Navy (`#101623`, `#1C2331`, `#29344A`, `#3E4E6D`) for backgrounds and panels.
    *   **Accents**: Dawho Gold (`#D4AF37`) for highlights, buttons, and current price.
    *   **Signal Colors**: Red (`#EF4444`) for Buy/Up, Green (`#10B981`) for Sell/Down (Taiwanese convention).
    *   **Typography**: `Barlow` for numerics, `Fira Code` / `Fira Sans` for UI text. Tabular numerals (`font-variant-numeric: tabular-nums`) must be used for all fast-updating datagrids.

2.  **Thread Safety (Backend)**: 
    *   The `ShioajiClient` relies on PyQt5 (`QObject`, `pyqtSignal`, `QTimer`).
    *   The FastAPI application runs in its own ASGI thread pool (via `uvicorn` and `asyncio`).
    *   **CRITICAL**: You *must not* invoke `ShioajiClient` methods directly from FastAPI route handlers (which run in worker threads) if those methods interact with the underlying C++ Shioaji library or alter Qt state. This causes immediate crashes (`QObject::startTimer: Timers can only be used with threads started with QThread`).
    *   Always use thread-safe dispatch mechanisms (like `QMetaObject.invokeMethod` with `Qt.QueuedConnection` or an `asyncio` bridge) when communicating between FastAPI and the Qt-based ShioajiClient.

3.  **Independent Execution**:
    *   When invoked with `--yolo`, execute the requested changes immediately and save the files.
    *   Do not ask for permission if the CLI flag specifically bypasses it.
    *   Provide a concise textual summary of the files changed and the logic implemented.

4.  **Trading Logic**:
    *   Refer to `trading_algo_patterns/SKILL.md` (if available in context) for complex order routing logic.
    *   Ensure all order placement logic correctly identifies simulation mode vs. live mode.

5. **output**"
   * 輸出都請改用繁體中文
