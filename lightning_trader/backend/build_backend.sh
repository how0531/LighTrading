#!/usr/bin/env bash
# Build LighTrade backend as a standalone bundle via PyInstaller.
# Output: ./dist/lightrade-backend/
set -euo pipefail

cd "$(dirname "$0")"

python -m pip install -r requirements_backend.txt -r requirements_build.txt
pyinstaller --clean --noconfirm pyinstaller_backend.spec

echo "OK Backend bundle: $(pwd)/dist/lightrade-backend/"
