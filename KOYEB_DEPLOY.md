# Koyeb Deploy Guide (One Server for Web + iOS + Android)

## Goal
Deploy one live backend URL (example: `https://play-skybeast.koyeb.app`) and have:
- Web users connect to it
- iOS app connect to it
- Android app connect to it

## 1) Push this repo to GitHub
Make sure these files are present:
- `/Users/alikhaled/Project-Product3/Dockerfile`
- `/Users/alikhaled/Project-Product3/.dockerignore`

## 2) Create service on Koyeb
1. Koyeb Dashboard -> `Create App`
2. Source: `GitHub`
3. Select this repository
4. Build method: `Dockerfile`
5. Port: `8000`
6. Instance type: start with free/starter option

## 3) Add environment variables in Koyeb
Set:
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=8000`
- `SESSION_SECRET=<long-random-secret>`
- `GOOGLE_CLIENT_ID=<your-google-client-id>`
- `DB_PATH=/var/data/data.json`
- `WS_BROADCAST_MS=90`
- `WS_PING_MS=20000`

## 4) Add persistent volume (recommended)
If available on your Koyeb plan:
- Mount path: `/var/data`
- Keeps account progress file (`data.json`) after redeploys/restarts

## 5) Verify live service
Open:
- `https://<your-koyeb-domain>/api/health`

Expected:
```json
{"ok":true,"service":"skybeast", ...}
```

## 6) Point all clients to same server

### Web
Use the Koyeb URL directly in browser:
- `https://<your-koyeb-domain>`

### iOS + Android
Before syncing native apps:
```bash
export CAP_SERVER_URL=https://<your-koyeb-domain>
npm run mobile:sync
```

Then build mobile releases from native IDEs.

## 7) Google Login update
In Google Cloud OAuth client, add authorized origin:
- `https://<your-koyeb-domain>`

If using a custom domain, add that too.

## 8) Publish flow
1. Deploy Koyeb and verify `/api/health`
2. Upload Android AAB
3. Archive/upload iOS build
4. Submit listings
