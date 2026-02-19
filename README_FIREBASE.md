# Secure Firebase Admin setup (backend)

This project can verify Firebase ID tokens on the backend using the Firebase Admin SDK. For secure verification you must provide service account credentials to the server.

Two supported ways:

1) FIREBASE_SERVICE_ACCOUNT_JSON (recommended for quick deployment)

- Go to Firebase Console → Project Settings → Service accounts → Generate new private key. Save the downloaded JSON file.
- Either copy the entire JSON content into the `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable (stringified) or set `GOOGLE_APPLICATION_CREDENTIALS` to point to the file path.

Example (PowerShell) — set env var with the file contents and start the server:

```powershell
$json = Get-Content C:\path\to\service-account.json -Raw
$env:FIREBASE_SERVICE_ACCOUNT_JSON = $json
npm run dev
```

Or set `GOOGLE_APPLICATION_CREDENTIALS` to the path (preferred in production):

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\path\to\service-account.json'
npm run dev
```

2) If neither is set the server will attempt to initialize Admin SDK with default credentials (GCP environment). Without a service account present token verification will be best-effort and NOT SECURE — tokens will be decoded without verification and should not be trusted for production.

What I changed in the backend:
- The server reads `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON string) or uses default Admin SDK init.
- Middleware verifies ID tokens and maps/creates a local DB user linked to `firebase_uid` (or creates a DB user when needed).
- When `firebaseUid` is present, many endpoints read/write to Firestore under `users/{firebaseUid}/...`.

Recommendation:
- Use a service account JSON and set it as `FIREBASE_SERVICE_ACCOUNT_JSON` or set `GOOGLE_APPLICATION_CREDENTIALS` before running the server.
- Do NOT paste the private key to public repos. Keep the service account JSON out of source control and add `backend/.env` to `.gitignore` if you use a .env file.
