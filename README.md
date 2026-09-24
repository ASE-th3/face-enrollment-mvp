# Face Enrollment MVP

A self-hosted proof-of-concept for HR-driven facial biometric enrollment.

## What it does

- HR/admin creates a unique, expiring enrollment URL.
- Employee explicitly consents and grants webcam access.
- Browser performs local face-landmark guidance and checks lighting, blur, face size, centering, and pose.
- The workflow captures 9 accepted views: center, two depths on each side, up/down, and final center.
- Accepted source JPEGs are transmitted over HTTPS to your server and encrypted at the application layer with Fernet before being written to disk.
- Enrollment metadata is stored in SQLite.
- Admin can export a completed enrollment as a ZIP containing decrypted source images plus `manifest.json` for ingestion into a commercial face-recognition engine.

## Important boundary

This MVP **does not extract Windows Hello biometric templates**, and it does not generate a production-grade face-recognition embedding. It creates a high-quality multi-view image enrollment package. Plug your licensed recognition SDK into the server after capture.

The motion sequence is an MVP active-liveness heuristic, **not certified Presentation Attack Detection (PAD)**. For physical/logical access control, use a validated PAD/liveness component and perform a security/privacy review.

## Run locally

Python 3.11+ is recommended.

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt

# Development defaults only:
# ADMIN_KEY defaults to change-me-before-production
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Open:

- Admin portal: `http://localhost:8000/admin`
- Health check: `http://localhost:8000/api/health`

Camera APIs work on `localhost`. For employee laptops connecting remotely, deploy behind **HTTPS**.

## Deploy to Vercel

This repository includes a Vercel adapter for the FastAPI app. It is suitable for
testing the UI and API, but the current MVP is **not suitable for persistent
production storage on Vercel**: SQLite and encrypted capture files are written to
the local filesystem, while Vercel function storage is ephemeral and may be
discarded between invocations.

To deploy a test instance:

1. Import this repository into Vercel, or run `vercel` from the project directory.
2. Add these Vercel environment variables for the Production environment:
        `ADMIN_KEY`, `PUBLIC_BASE_URL`, and `ENCRYPTION_KEY`.
3. Set `PUBLIC_BASE_URL` to the deployed HTTPS URL, then redeploy.
4. Open `/admin` and verify `/api/health` before creating any enrollment records.

For a real deployment, replace the local SQLite/filesystem storage with a hosted
database and encrypted object storage before uploading biometric captures. Do not
use the placeholder values from `.env` as production secrets.

## Docker

```bash
cp .env.example .env
# Fill ADMIN_KEY, PUBLIC_BASE_URL, ENCRYPTION_KEY
docker compose up -d --build
```

For a real deployment, terminate TLS at your approved reverse proxy/load balancer and set `PUBLIC_BASE_URL=https://your-domain`.

## Data layout

```text
data/
  enrollments.sqlite3
  captures/<enrollment_uuid>/*.enc
```

Image files are Fernet-encrypted. If `ENCRYPTION_KEY` is not provided, the MVP creates `data/.encryption_key`; this fallback is convenient for development but should not be used as your enterprise key-management design.

## MediaPipe dependency

The capture page currently loads `@mediapipe/tasks-vision` v1.0.1 and the Face Landmarker model from public CDN/Google-hosted locations. Face-image processing stays in the browser, but production environments that require no external runtime dependencies should vendor the JavaScript/WASM/model assets onto the organization's own web server and change the URLs in `static/enroll.js`.

## Production hardening checklist

1. Replace the shared admin-key mechanism with SSO/OIDC and RBAC.
2. Put the application behind HTTPS only; enable HSTS and appropriate CSP/security headers.
3. Store encryption keys in the organization's KMS/HSM/secret manager, not beside the data.
4. Use PostgreSQL and encrypted object storage for multi-node deployments.
5. Add rate limits, CSRF protections where applicable, audit events, monitoring, backup/restore, and retention deletion jobs.
6. Use a licensed biometric matching SDK/model and a validated PAD/liveness product if this will control access.
7. Define biometric consent, retention, deletion, data-subject access, and breach-handling procedures with legal/privacy teams.
8. Avoid generative "face enhancement" before embedding generation; recapture bad source frames instead.
9. Keep raw images and templates in separate restricted storage/security domains where practical.
10. Perform threat modeling and penetration testing before production.

## Suggested recognition-engine integration

Add a server-side function that runs only after a completed enrollment:

```text
accepted encrypted images
        ↓ decrypt in memory
licensed face detector/alignment
        ↓
quality gate
        ↓
licensed recognition model
        ↓
1..N embeddings / vendor template
        ↓
restricted biometric-template store
```

Do not use the MediaPipe landmarks themselves as the biometric identity template; they are only being used here for capture guidance.
