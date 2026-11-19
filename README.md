# Office Share

Auto-connected file sharing between office laptops on the same WiFi. You don't pair or connect anything by hand.
Turn a laptop on and its name shows up on every other laptop. Drag a file onto a name and it arrives.

## Features
- **Automatic connection**: laptops find each other on the same WiFi/LAN within seconds and drop off the list when they go offline.
- **Runs in the background**: starts with the computer and lives in the tray, so files arrive even when the window is closed.
- **Office key**: only laptops with the same key can see each other or send anything. Others on the same WiFi stay invisible.
- **Encrypted**: every transfer is AES-256-GCM encrypted. Nothing goes through the internet.
- **Drag & drop** files or whole folders onto a laptop, or onto **Everyone**.
- **Right-click → Send to → Office Share** in Windows Explorer.
- **Quick messages**, **clipboard sharing** and **Buzz** (gets someone's attention with a shake and a sound).
- Live progress, speed, time left, **Cancel** and **Try again**.
- **Auto-accept** from office laptops, or **Ask me first**.
- **Status**: Available, Busy (no popups) or Away. Everyone sees it.
- Saves to `Downloads/Office Share` (you can change this). Optional **folder per person**. Duplicate names are kept as `file (1).pdf`.
- **Activity history** with Open / Show in folder, filters and pinned favourite laptops.
- A warning when a laptop is using a **different office key**, to make troubleshooting easy.
- **Send from anywhere (cloud)**: laptops at home or on mobile data show with 🌐 and you send to them the same way. Files wait in the cloud when someone is offline and arrive when their laptop comes back on. Uses your own free Cloudflare relay (see below).

## Install (Windows)
1. Unzip `OfficeShare-Windows-1.0.0.zip` somewhere permanent, e.g. `C:\Program Files\Office Share` or `Documents`.
2. Run `Office Share.exe`.
3. Give the laptop a name and type the **office key**. Use the same key on every laptop.
4. When Windows Firewall asks, tick **Private networks** and click **Allow access**.
5. Repeat on the other laptops. They appear on their own.

> Windows SmartScreen may warn "unknown publisher" because the app isn't code-signed. Click **More info → Run anyway**.

## If a laptop doesn't show up
- Both laptops must be on the **same WiFi / router**. Guest WiFi often blocks devices from seeing each other.
- Windows: Settings → Network → WiFi → set the network profile to **Private**.
- Firewall: allow "Office Share" (or the Electron app) on Private networks.
- Check the **office key fingerprint** in the sidebar. It must be the same on every laptop.
- Some routers have "AP / client isolation" turned on. Turn it off in the router settings.

## Send from anywhere: set up the cloud relay (one time, free)
Office Share talks directly over the office WiFi. For laptops **away from the office**, it uses a small relay that runs on **your own Cloudflare account**, on the free plan.
Files, names and messages are encrypted with the office key **before** they're uploaded, so the relay can't read them. Undelivered files are deleted after 7 days.

1. Click **[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shoaib101198-wq/office-share/tree/main/relay)**
2. Sign in or create a free Cloudflare account. If it asks, **enable R2** (Cloudflare asks for a card for R2, but the free tier includes 10 GB of storage and normal office use stays inside it).
3. Optional but recommended: set **RELAY_KEY** to a password of your choice.
4. Click **Deploy**. You'll get an address like `https://office-share-relay.yourname.workers.dev`.
5. Build your **relay link**: the address plus `/?key=` plus your password:
   `https://office-share-relay.yourname.workers.dev/?key=YOUR_PASSWORD`
6. On **every laptop**: Office Share → **Settings → Send from anywhere (cloud)** → paste the link → **Save**. The status should show **● Connected**.

Inside the office, files still go directly over WiFi at full speed. The cloud is only used when a laptop isn't on the same network.

Manual deploy instead of the button:
```bash
cd relay
npm install
npx wrangler login
npx wrangler secret put RELAY_KEY      # optional password
npx wrangler deploy                    # creates the D1 database + R2 bucket automatically
```

**Free-tier usage:** each laptop checks in about every 8 seconds, using cheap database reads. With 20 laptops that's well under Cloudflare's daily free limits.

## Ports
- UDP **48555**: discovery broadcast
- TCP **48556**: transfers (falls back to a random port if busy; peers learn it automatically)

## Developers
```bash
npm install
npm start            # run the app
npm test             # headless end-to-end engine test (two simulated laptops)
npm run test:relay   # cloud relay test (start `cd relay && npx wrangler dev --port 8787` first)
npm run dist:win     # Windows installer + portable exe (run on Windows)
npm run dist:mac     # macOS dmg (run on a Mac)
npm run dist:linux   # AppImage + deb
```
Push a tag like `v1.0.0` to GitHub. `.github/workflows/build.yml` then builds the Windows, Mac and Linux installers automatically.
To run two copies on one PC for testing: `OFFICE_SHARE_PROFILE=./profile2 npm start`.

### Structure
```
main.js              Electron: tray, auto-start, notifications, Send To, IPC
preload.js           safe bridge to the UI
renderer/            UI (vanilla HTML/CSS/JS)
src/core/engine.js   brain: settings, history, orchestration
src/core/discovery.js  UDP broadcast discovery (HMAC-signed with the office key)
src/core/transfer.js   encrypted TCP file/message transfer
src/core/relay.js      cloud relay client (sealed 8 MB chunks)
relay/                 Cloudflare Worker (D1 + R2) for sending from anywhere
src/core/crypto.js     key derivation (scrypt) + AES-256-GCM frames
```
