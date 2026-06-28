# Capturing Hevy traffic (iOS + mitmproxy)

Your Mac's LAN IP: **192.168.86.21**  ·  Proxy port: **8080**  ·  Web UI: http://127.0.0.1:8081

## 1. Start the proxy (already running, but to restart)

```bash
cd /Users/rufus/hevy-api
mitmweb -s capture/hevy_capture.py --set web_open_browser=false
```

Captured Hevy requests stream to `capture/flows/hevy-capture.jsonl` and show in the web UI.

## 2. Point your iPhone at the proxy

iPhone must be on the **same Wi-Fi** as the Mac.

Settings → Wi-Fi → tap the ⓘ next to your network → **Configure Proxy** → **Manual**
- Server: `192.168.86.21`
- Port: `8080`
- Authentication: off

## 3. Install the mitmproxy CA cert

1. In **Safari** on the iPhone, open **http://mitm.it**
2. Tap the **iOS** "Get mitmproxy-ca-cert" → allow the profile download.
3. Settings → **General → VPN & Device Management** → tap the mitmproxy profile → **Install**.
4. Settings → **General → About → Certificate Trust Settings** → toggle **mitmproxy ON** (full trust). This step is required or HTTPS won't decrypt.

## 4. Capture

Open the Hevy app and exercise the features you want in the package:
- Launch / log in (captures auth)
- Open the feed, your workouts, routines, exercises
- Start a workout, log a set, finish a workout
- View profile / stats

Each action should appear in the web UI and in the JSONL file.

## 5. Inventory what was captured

```bash
node capture/analyze.mjs
```

This prints every endpoint hit, status codes, and which headers look like auth.

## 6. When done

Turn the iPhone Wi-Fi proxy back to **Off** so normal browsing works again.

---

### If no Hevy traffic shows up (SSL pinning)

If the app fails to load data and the web UI shows TLS/handshake errors for
`hevyapp` hosts, the app may pin its certificate. Options, easiest first:

1. Confirm it's actually pinning (non-Hevy apps still working through the proxy
   rules out a setup problem).
2. iOS cert-pinning bypass requires either a jailbroken device with
   SSL Kill Switch, or a re-signed IPA with a Frida gadget — more involved.
   Tell me and we'll decide whether it's worth it or whether to fall back to
   Hevy's official developer API.
