# World Press for Surface Hub

A full-color, two-newspaper wall display for a landscape Surface Hub 2S running
Windows 11 Pro / Enterprise. The new app lives in `hub`; the original PHP/e-ink
pages are unchanged.

## Run

Install **Node.js 24 LTS** and current **Microsoft Edge**. In PowerShell:

```powershell
Set-Location C:\dev\Newspapers\hub
npm ci
npm start
```

Open <http://127.0.0.1:3000>. For the full-screen kiosk experience, stop the
development server with Ctrl+C, then:

```powershell
.\Start-Hub.ps1
```

The launcher starts a local server, waits for readiness, and opens Edge kiosk
mode with ambient layout enabled. Alt+F4 exits the browser; close the server
window when finished.

**Auto-update:** the Hub must be a `git clone` of
<https://github.com/RZomerman/Newspapers> (needs Git installed). On start, and
every 30 minutes (`-UpdateMinutes`), the launcher runs `git pull --ff-only`,
runs `npm ci` if `package*.json` changed, restarts the server, and the open page
reloads itself within a minute. Push to `main` to deploy. Use `-NoUpdate` to
disable. Do not edit files on the Hub; a diverged clone will keep its current
version and log a warning.
Only run one server per port. Use `.\Start-Hub.ps1 -Port 3001` if needed.
Follow your organization's PowerShell execution policy; do not bypass it.

## Display and reading

- Two **different front pages**, not two interior pages of a newspaper.
- Both change together **every five minutes**, measured after loading finishes.
  Previous/Next also move through pairs. The 12-paper playlist wraps; unavailable
  papers are automatically skipped when alternatives exist, with a skip count.
  Previous revisits prior pair starting points (up to 100).
- **Touch navigation:** swipe left on either fitted page for the next pair, or
  right for the previous pair, including in ambient mode. Use one finger with a
  clear horizontal swipe. Taps, vertical gestures, multi-touch, and mouse drags
  do not change pairs. While a page is zoomed, gestures on that page scroll it
  instead. Manual changes restart the five-minute countdown and preserve Pause.
- Original PDF colors and vector text; no grayscale, inversion, image cropping,
  low-resolution thumbnails, or newspaper color filters.
- Whole pages fit side by side. Body text on two fitted broadsheets cannot be
  guaranteed readable from across a room. Tap **+** (up to 400%), then scroll/swipe
  within that page to read. Zooming automatically pauses rotation. **Fit** resets
  that page; **Resume** continues the remaining countdown.
- **Fullscreen** uses the browser fullscreen API. **Ambient mode** removes the
  outer header/footer; touching or moving the pointer reveals controls for 12
  seconds. Newspaper labels and zoom remain accessible. Escape exits ambient mode.
- Keyboard: Space pauses/resumes; left/right changes pairs; F toggles fullscreen;
  ? opens reading help. Buttons also support keyboard focus and touch.
- PDF canvases are rendered at device pixel density and rerendered on zoom/resize,
  capped at a 6144-pixel longest edge to bound memory. The original PDF link is
  available for browser-native reading/search/accessibility.
- The app requests a screen wake lock when supported. Windows power policy,
  sign-out, lock, updates, and managed device restrictions still take precedence.

## Screensaver versus kiosk

This is a **web kiosk, not a native Windows `.scr` screensaver**. It does not hook
Windows idle detection or replace the lock screen. This is a simpler deployment
for a continuously running wall display.

For automatic startup after sign-in, create a shortcut to:

```text
powershell.exe -NoProfile -File "C:\dev\Newspapers\hub\Start-Hub.ps1"
```

Put the shortcut in the current user's Startup folder (`Win+R`, `shell:startup`).
This starts after sign-in, not before; it does not configure automatic sign-in.
Use Windows Settings → System → Power to keep the plugged-in display and PC
awake, if permitted by your IT policy. Keep lock/security requirements intact.
For a managed unattended installation, ask IT to configure Edge Assigned Access
and a supervised Node service. The development launcher is not a service manager.

These instructions target the confirmed **Windows 11 Pro / Enterprise** OS.
Windows 10 Team and Teams Rooms have different app/kiosk restrictions and should
not be configured using these instructions.

## Data source and limitations

The playlist preserves the newspaper identifiers from this repository's PHP
pages: Washington Post, Boston Globe, New York Times, Los Angeles Times, Toronto
Star, San Francisco Chronicle, de Volkskrant, AD, BusinessWorld, Het Parool,
The National, and Gulf News. Edit `hub/papers.mjs` to change names/order/IDs.

The source is the existing Freedom Forum public front-page PDF feed:
`https://cdn.freedomforum.org/dfp/pdf{day}/{paperId}.pdf`.
It is an external, undocumented feed and availability can change.

The server tries today's US Eastern feed folder, then the previous two dates
**only for HTTP 404**. Earlier folders are explicitly labeled, never passed off
as today's edition. **Feed date is the requested source folder date, not a
verified printed edition date**; the upstream day-only URL can contain stale
content. Timeouts, invalid PDFs, rate limits, and other source failures are
reported rather than disguised as successful downloads. Unavailable newspapers
are logged and replaced with other playlist entries where possible. If fewer
than two can load, the unfilled slot shows an error and Retry button; the pair
still rotates on schedule. At initial verification, the Washington Post and
BusinessWorld IDs from the old repository were unavailable and were skipped.

PDFs are proxied same-origin to avoid browser CORS restrictions. Fetches have a
15-second timeout per date, a 20 MB PDF limit, a 20-minute memory cache, a 64 MB
total cache budget, and no on-disk newspaper archive. PDF.js and its fonts/workers
are served locally, not from third-party JavaScript CDNs. Internet is required
for uncached newspapers. A restart clears the memory cache.

Use the feed according to the source's and publishers' terms and your display
rights. This application does not grant redistribution/public-display rights.
Source site: <https://frontpages.freedomforum.org/>.

The server binds to loopback by default. To serve a Hub from another trusted
computer, set `HOST`/`PORT` before `npm start`, and arrange firewall/HTTPS through
IT. There is no authentication; do not expose it to the public internet.
Wake lock requires a secure context (HTTPS, or localhost on the Hub itself).

## Validate

```powershell
Set-Location C:\dev\Newspapers\hub
npm test
```

Tests cover touch swipe direction, gesture thresholds/cancellation, multi-touch,
zoom/loading guards, exact five-minute timing, pause/resume, source-date rollover,
fallback labels, PDF validation, upstream errors, caching, and route restrictions.
