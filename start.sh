#!/bin/bash
cd lightning_trader/backend && uvicorn main:app --port 8000 &
cd lightning_trader/frontend && npm run dev
