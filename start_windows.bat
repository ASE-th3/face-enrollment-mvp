@echo off
setlocal
if not exist .venv python -m venv .venv
call .venv\Scripts\activate
python -m pip install -r requirements.txt
if "%ADMIN_KEY%"=="" set ADMIN_KEY=change-me-before-production
if "%PUBLIC_BASE_URL%"=="" set PUBLIC_BASE_URL=http://localhost:8000
python -m uvicorn app:app --host 0.0.0.0 --port 8000
