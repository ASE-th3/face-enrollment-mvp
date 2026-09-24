#!/usr/bin/env sh
set -eu
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
: "${ADMIN_KEY:=change-me-before-production}"
: "${PUBLIC_BASE_URL:=http://localhost:8000}"
export ADMIN_KEY PUBLIC_BASE_URL
python -m uvicorn app:app --host 0.0.0.0 --port 8000
