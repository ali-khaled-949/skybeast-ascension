# SkyBeast Ascension

SkyBeast Ascension is a browser multiplayer evolution game with:
- Real-time arena movement via WebSocket (`/ws`)
- Account save/progress + leaderboard APIs
- Google login support
- Live web deployment support
- iOS/Android packaging via Capacitor

## 1) Run Local

```bash
npm install
cp .env.example .env
npm run dev
```

Open: `http://localhost:8000`

## 2) Deploy Live Multiplayer Web (Koyeb - Recommended)

Use:
- `/Users/alikhaled/Project-Product3/KOYEB_DEPLOY.md`

That guide gives exact Koyeb steps for one shared server URL across Web + iOS + Android.

## 3) Deploy Live Multiplayer Web (Render Alternative)

This repo includes `render.yaml` for one-click deploy.

### Steps
1. Push this project to GitHub.
2. Create a new Render Blueprint service from this repo.
3. Set environment values in Render:
   - `NODE_ENV=production`
   - `SESSION_SECRET` (long random value)
   - `GOOGLE_CLIENT_ID` (your web OAuth client)
   - `DB_PATH=/var/data/data.json` (already in `render.yaml`)
4. Attach persistent disk (already defined in `render.yaml`).
5. Deploy.

Health check endpoint:
- `GET /api/health`

### Custom Domain + SSL
1. In Render service settings, add your custom domain (for example `play.yourdomain.com`).
2. In your DNS provider, create the CNAME/ALIAS record Render shows.
3. Wait for DNS to propagate and Render to issue SSL automatically.
4. Update:
   - `CAP_SERVER_URL=https://play.yourdomain.com`
   - Google OAuth authorized origin to your new domain.

Important:
- Current multiplayer is single-instance in-memory presence (good for first launch).
- For horizontal scale, move presence/state into Redis + a shared game server model.

## 4) Google Login Production Setup

In Google Cloud OAuth Client (Web):
- Add your live origin, e.g. `https://your-domain.com`
- Add local origins for testing:
  - `http://localhost:8000`
  - `http://127.0.0.1:8000`

Then set `GOOGLE_CLIENT_ID` in Render and redeploy.

## 5) iOS + Android Build (Capacitor)

This project is configured to load your deployed live URL inside native apps.

Set your live URL:

```bash
export CAP_SERVER_URL=https://your-live-domain.com
export CAP_APP_ID=com.yourcompany.skybeast
export CAP_APP_NAME="SkyBeast Ascension"
```

Install dependencies:

```bash
npm install
```

Create native projects:

```bash
npm run mobile:sync
npx cap add ios
npx cap add android
```

Generate app icons/splash assets:

1. Put your production icon and splash files in `/resources` as:
   - `/resources/icon.png` (1024x1024)
   - `/resources/splash.png` (2732x2732)
2. Run:

```bash
npm run mobile:assets
npm run mobile:sync
```

Note:
- Starter SVGs are included at:
  - `/resources/icon.svg`
  - `/resources/splash.svg`
- Export those SVG files to PNG before running `mobile:assets`.

Open native IDE projects:

```bash
npm run mobile:ios
npm run mobile:android
```

## 6) Store Release Checklist

- Replace app icon + splash in Capacitor projects.
- Set final bundle IDs:
  - iOS: `com.yourcompany.skybeast`
  - Android: `com.yourcompany.skybeast`
- Enable HTTPS only.
- Test login + ws multiplayer from real devices.
- Prepare privacy policy URL and support URL for stores.

## Core Files

- `index.html` - full game client
- `server/index.js` - API + WebSocket multiplayer server
- `KOYEB_DEPLOY.md` - Koyeb one-server deployment guide
- `render.yaml` - Render deploy blueprint
- `capacitor.config.ts` - mobile wrapper config (live URL)
