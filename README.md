# MTProto Checker

A single-page web application for **extracting and testing MTProto proxy configurations** published in Telegram channels — right in your browser.

- 📺 **Channel manager** — add channels by ID/`@username`/`t.me` link, search, edit, delete, select, export/import
- 📥 **Daily extraction** — pull only **today's** MTProto configs from any public Telegram channel into the editor
- ⚡ **Client-side scanning** — validate and measure each proxy's response speed from **your own internet connection** (no backend)
- 📁 **Per-day result files** — every scan is committed to `results/YYYY-MM-DD.md` in this repository, sorted by speed
- 🌙 **Beautiful minimal dark UI** — works entirely statically on **GitHub Pages**

## Sections

| Section | Where | What it does |
|---|---|---|
| 1 · Sidebar | Left | Manage Telegram channels (add by channel ID, search, edit, delete, select-all). Ticking a channel's checkbox automatically extracts **today's** configs from it into the textarea. |
| 2 · Configurations | Top right | Displays extracted configs and lets you paste/edit configs manually (`tg://proxy?…`, `https://t.me/proxy?…` or `server:port:secret`). |
| 3 · Scan results | Bottom right | After pressing **Scan**, configurations are probed from your browser and listed **sorted by response speed**. Results are saved to `results/<date>.md`. |

## Quick start

No build step — it's plain HTML/CSS/JS.

```bash
# local preview
python3 -m http.server 8000
# open http://localhost:8000
```

### Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, set *Source* to `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/`.

### Enable automatic saving of scan results

The app commits each scan to `results/YYYY-MM-DD.md` using the GitHub API, so it needs a token **with write access to the repository**:

1. Create a personal access token:
   - Fine-grained token with **Contents: Read and write** on this repository, or
   - Classic token with the `repo` scope.
2. Open **Settings** (top right) in the app and paste the token. The repository owner/name is auto-detected from the GitHub Pages URL.
3. Press **Scan** — the sorted results are committed automatically (or via the *Save to repo* button).

> The token is stored only in your browser's `localStorage` and sent only to `api.github.com`.
> Without a token you can still scan and download `results/<date>.md` manually.

## How scanning works

Everything runs **client-side over your own connection**:

1. **Syntax validation** — server (IPv4/hostname), port range, and secret format (16/32-byte hex or base64url).
2. **DNS check** — hostnames are resolved over DNS-over-HTTPS to flag dead domains.
3. **Reachability probe** — the browser opens an HTTPS connection to `server:port` and measures the time to the first network outcome (browsers can't speak raw TCP, so the TCP+TLS handshake timing is used as the response-speed metric; live MTProto endpoints reject the browser's TLS handshake by design, which still yields an accurate latency measurement).

Results are sorted fastest-first; statuses: **Valid**, **Slow**, **Timeout**, **Unreachable**, **Invalid**.

## How extraction works

The app reads the public web preview `https://t.me/s/<channel>` through public CORS proxies (fully static — no server of ours), parses every message, keeps **only messages posted today** (local date), and extracts `tg://proxy` / `t.me/proxy` / `host:port:secret` configurations from them. If today's posts are spread over several pages, up to 3 preview pages are scanned.

You can add your own CORS proxy template (with a `{url}` placeholder) in Settings if the public ones are rate-limited.

## Supported channel inputs

- `@username` or `username`
- `t.me/username`, `https://t.me/s/username`, `telegram.me/…`
- Numeric channel IDs such as `-1001234567890` (stored, but extraction needs a public `@username`)

## Privacy

- Channel list and settings stay in your browser (`localStorage`).
- Scanning happens from your browser directly to the proxies.
- Only the sorted scan report is ever sent to GitHub (and only if you configure a token).
