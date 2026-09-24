from __future__ import annotations

import hashlib
import io
import json
import os
import secrets
import sqlite3
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CAPTURE_DIR = DATA_DIR / "captures"
DB_PATH = DATA_DIR / "enrollments.sqlite3"
STATIC_DIR = BASE_DIR / "static"
DATA_DIR.mkdir(parents=True, exist_ok=True)
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)

ADMIN_KEY = os.environ.get("ADMIN_KEY", "change-me-before-production")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))


def _fernet() -> Fernet:
    env = os.environ.get("ENCRYPTION_KEY")
    key_file = DATA_DIR / ".encryption_key"
    if env:
        key = env.encode()
    elif key_file.exists():
        key = key_file.read_bytes().strip()
    else:
        key = Fernet.generate_key()
        key_file.write_bytes(key)
        try:
            os.chmod(key_file, 0o600)
        except OSError:
            pass
    return Fernet(key)

FERNET = _fernet()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS enrollments (
                id TEXT PRIMARY KEY,
                employee_id TEXT NOT NULL,
                employee_name TEXT NOT NULL,
                email TEXT,
                token_hash TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'created',
                consent_at TEXT,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                completed_at TEXT,
                user_agent TEXT,
                capture_count INTEGER NOT NULL DEFAULT 0,
                final_quality REAL,
                notes TEXT
            );
            CREATE TABLE IF NOT EXISTS captures (
                id TEXT PRIMARY KEY,
                enrollment_id TEXT NOT NULL,
                pose TEXT NOT NULL,
                file_name TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                quality_json TEXT NOT NULL,
                FOREIGN KEY(enrollment_id) REFERENCES enrollments(id)
            );
            CREATE INDEX IF NOT EXISTS idx_capture_enrollment ON captures(enrollment_id);
            """
        )

init_db()

app = FastAPI(title="Face Enrollment MVP", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class EnrollmentCreate(BaseModel):
    employee_id: str = Field(min_length=1, max_length=100)
    employee_name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=254)
    expires_hours: int = Field(default=24, ge=1, le=168)
    notes: str | None = Field(default=None, max_length=1000)


class CompleteRequest(BaseModel):
    final_quality: float = Field(ge=0, le=100)
    consent: bool
    liveness_passed: bool


def require_admin(x_admin_key: str | None) -> None:
    if not x_admin_key or not secrets.compare_digest(x_admin_key, ADMIN_KEY):
        raise HTTPException(status_code=401, detail="Invalid admin key")


def get_enrollment_by_token(token: str) -> sqlite3.Row:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM enrollments WHERE token_hash=?", (hash_token(token),)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Enrollment link not found")
    expires = datetime.fromisoformat(row["expires_at"])
    if datetime.now(timezone.utc) > expires:
        raise HTTPException(status_code=410, detail="Enrollment link expired")
    if row["status"] == "completed":
        raise HTTPException(status_code=409, detail="Enrollment already completed")
    return row


@app.get("/", response_class=HTMLResponse)
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "admin.html")


@app.get("/admin", response_class=HTMLResponse)
def admin_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "admin.html")


@app.get("/enroll/{token}", response_class=HTMLResponse)
def enroll_page(token: str) -> FileResponse:
    # Token validity is also checked by JS API before camera starts.
    return FileResponse(STATIC_DIR / "enroll.html")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "time": now_iso()}


@app.post("/api/admin/enrollments")
def create_enrollment(
    body: EnrollmentCreate, x_admin_key: str | None = Header(default=None)
) -> dict[str, Any]:
    require_admin(x_admin_key)
    token = secrets.token_urlsafe(32)
    enrollment_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(hours=body.expires_hours)
    with db() as conn:
        conn.execute(
            """
            INSERT INTO enrollments
            (id, employee_id, employee_name, email, token_hash, status, created_at, expires_at, notes)
            VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?)
            """,
            (
                enrollment_id,
                body.employee_id.strip(),
                body.employee_name.strip(),
                body.email.strip() if body.email else None,
                hash_token(token),
                created_at.isoformat(),
                expires_at.isoformat(),
                body.notes,
            ),
        )
    return {
        "id": enrollment_id,
        "employee_id": body.employee_id,
        "employee_name": body.employee_name,
        "expires_at": expires_at.isoformat(),
        "enrollment_url": f"{PUBLIC_BASE_URL}/enroll/{token}",
    }


@app.get("/api/admin/enrollments")
def list_enrollments(x_admin_key: str | None = Header(default=None)) -> list[dict[str, Any]]:
    require_admin(x_admin_key)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, employee_id, employee_name, email, status, created_at, expires_at, completed_at, capture_count, final_quality FROM enrollments ORDER BY created_at DESC"
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/admin/enrollments/{enrollment_id}")
def enrollment_detail(
    enrollment_id: str, x_admin_key: str | None = Header(default=None)
) -> dict[str, Any]:
    require_admin(x_admin_key)
    with db() as conn:
        row = conn.execute("SELECT * FROM enrollments WHERE id=?", (enrollment_id,)).fetchone()
        captures = conn.execute(
            "SELECT id, pose, file_name, captured_at, quality_json FROM captures WHERE enrollment_id=? ORDER BY captured_at",
            (enrollment_id,),
        ).fetchall()
    if not row:
        raise HTTPException(status_code=404, detail="Enrollment not found")
    result = dict(row)
    result.pop("token_hash", None)
    result["captures"] = [
        {**dict(c), "quality": json.loads(c["quality_json"])} for c in captures
    ]
    for c in result["captures"]:
        c.pop("quality_json", None)
    return result


@app.get("/api/admin/enrollments/{enrollment_id}/export")
def export_enrollment(
    enrollment_id: str, x_admin_key: str | None = Header(default=None)
) -> StreamingResponse:
    require_admin(x_admin_key)
    with db() as conn:
        row = conn.execute("SELECT * FROM enrollments WHERE id=?", (enrollment_id,)).fetchone()
        captures = conn.execute(
            "SELECT * FROM captures WHERE enrollment_id=? ORDER BY captured_at", (enrollment_id,)
        ).fetchall()
    if not row:
        raise HTTPException(status_code=404, detail="Enrollment not found")

    manifest = dict(row)
    manifest.pop("token_hash", None)
    manifest["captures"] = []
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as zf:
        for c in captures:
            path = CAPTURE_DIR / enrollment_id / c["file_name"]
            if not path.exists():
                continue
            raw = FERNET.decrypt(path.read_bytes())
            arc = f"images/{c['file_name'].replace('.enc', '')}"
            zf.writestr(arc, raw)
            manifest["captures"].append(
                {
                    "id": c["id"],
                    "pose": c["pose"],
                    "captured_at": c["captured_at"],
                    "quality": json.loads(c["quality_json"]),
                    "file": arc,
                }
            )
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        zf.writestr(
            "README.txt",
            "This package contains biometric enrollment images and metadata. Handle as restricted biometric data.\n",
        )
    mem.seek(0)
    filename = f"face-enrollment-{row['employee_id']}-{enrollment_id[:8]}.zip"
    return StreamingResponse(
        mem,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/enrollments/{token}/status")
def enrollment_status(token: str) -> dict[str, Any]:
    row = get_enrollment_by_token(token)
    return {
        "employee_id": row["employee_id"],
        "employee_name": row["employee_name"],
        "status": row["status"],
        "expires_at": row["expires_at"],
        "capture_count": row["capture_count"],
    }


@app.post("/api/enrollments/{token}/capture")
async def upload_capture(
    request: Request,
    token: str,
    pose: str = Form(...),
    metadata: str = Form(...),
    consent: str = Form(...),
    image: UploadFile = File(...),
) -> dict[str, Any]:
    row = get_enrollment_by_token(token)
    if consent.lower() != "true":
        raise HTTPException(status_code=400, detail="Biometric consent required")
    try:
        quality = json.loads(metadata)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid metadata JSON")

    allowed_poses = {
        "center",
        "side_a",
        "side_a_deep",
        "center_mid",
        "side_b",
        "side_b_deep",
        "up",
        "down",
        "center_final",
    }
    if pose not in allowed_poses:
        raise HTTPException(status_code=400, detail="Invalid pose")

    raw = await image.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")
    if image.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=415, detail="Only JPEG/PNG accepted")
    if len(raw) < 10_000:
        raise HTTPException(status_code=400, detail="Image payload too small")

    capture_id = str(uuid.uuid4())
    ext = ".jpg" if image.content_type == "image/jpeg" else ".png"
    file_name = f"{pose}-{capture_id}{ext}.enc"
    folder = CAPTURE_DIR / row["id"]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / file_name).write_bytes(FERNET.encrypt(raw))

    with db() as conn:
        conn.execute(
            "INSERT INTO captures (id, enrollment_id, pose, file_name, captured_at, quality_json) VALUES (?, ?, ?, ?, ?, ?)",
            (capture_id, row["id"], pose, file_name, now_iso(), json.dumps(quality)),
        )
        conn.execute(
            """
            UPDATE enrollments
            SET status='in_progress',
                consent_at=COALESCE(consent_at, ?),
                user_agent=COALESCE(user_agent, ?),
                capture_count=capture_count+1
            WHERE id=?
            """,
            (now_iso(), request.headers.get("user-agent"), row["id"]),
        )
    return {"ok": True, "capture_id": capture_id}


@app.post("/api/enrollments/{token}/complete")
def complete_enrollment(token: str, body: CompleteRequest) -> dict[str, Any]:
    row = get_enrollment_by_token(token)
    if not body.consent:
        raise HTTPException(status_code=400, detail="Biometric consent required")
    if not body.liveness_passed:
        raise HTTPException(status_code=400, detail="Guided liveness challenge not completed")
    with db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM captures WHERE enrollment_id=?", (row["id"],)
        ).fetchone()["c"]
        if count < 7:
            raise HTTPException(status_code=400, detail="Not enough accepted captures")
        conn.execute(
            "UPDATE enrollments SET status='completed', completed_at=?, final_quality=? WHERE id=?",
            (now_iso(), body.final_quality, row["id"]),
        )
    return {"ok": True, "status": "completed", "capture_count": count}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
