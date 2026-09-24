# Security and privacy notes

This repository is an MVP and should be treated as a prototype until hardened.

Biometric images and face templates are high-sensitivity personal data. Before production, establish a documented lawful basis/consent process, retention period, deletion workflow, access controls, incident response, audit policy, and jurisdiction-specific compliance review.

## Implemented in the MVP
- Unique high-entropy enrollment token; only SHA-256 hash stored in SQLite.
- Expiring enrollment URLs.
- Completed links cannot be reused.
- Explicit consent gate before webcam access/upload.
- One-face capture requirement in the browser.
- Application-layer Fernet encryption for stored image payloads.
- Admin export requires a server-side admin credential.

## Not production-grade yet
- Shared admin key instead of SSO/RBAC.
- No certified presentation-attack detection.
- No biometric matching/identification engine.
- No automated retention/deletion scheduler.
- No centralized audit/SIEM integration.
- No rate limiting/WAF configuration.
- SQLite rather than enterprise DB.
- External hosted MediaPipe runtime/model dependencies.
