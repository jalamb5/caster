# Caster 🎙️

Shuffle your podcasts. Weighted random that **favours episodes you've never
heard, but never excludes the ones you have** — and keeps rolling all night.

Built as a single-file PWA: works on Android (/e/OS, de-Googled friendly),
testable on iPhone today. No account, no analytics, feeds and history stay on
your device (or go through your own proxy).

## Run

```bash
cd ~/repos/caster
python3 serve.py            # http://0.0.0.0:8765 — includes same-origin /fetch proxy
```

Open `http://localhost:8765` on this Mac, or `http://<this-mac-ip>:8765` from
your phone on the same Wi-Fi. The `/fetch` endpoint fetches RSS server-side so
the browser never hits CORS walls and no third-party proxy sees your feeds.

## GitHub Pages

Hosted at https://jalamb5.github.io/caster/. Pages is static-only, so the
same-origin `/fetch` proxy is **not** available there — adding a show falls
back to the public CORS proxies (can be flaky). Playback, shuffle, sleep
timer, and lock-screen controls work the same; already-saved shows work
offline of any proxy. (The optional Settings → Custom CORS proxy field exists
for pointing at your own fetch service if you ever want one.)

## How the algorithm works

- **Unplayed** episodes: weight 10.
- **Played** episodes: `1 + 4·e^(−daysSincePlayed/freshness)` — old favourites
  resurface, last week's stay buried, weight never reaches zero (played ≠
  excluded).
- **Repeat guard**: episodes heard within the last N hours are skipped while
  others exist (no same-episode-twice-tonight).
- Marked **heard** at 85% consumed (so the one you fell asleep in sinks low
  for a while instead of vanishing); skipping records it too.
- Tune `freshness` and the guard in ⚙ Settings.

## Roadmap

- [x] MVP: add shows (iTunes search or RSS URL), weighted shuffle, continuous
      auto-play, sleep timer, lock-screen controls (Media Session), resume
      position, played tracking
- [ ] Groupings: shuffle across several shows
- [ ] Offline: download a random batch (by episode count or total time)
- [ ] "Pause when the phone hasn't moved for N minutes" (accelerometer sleep
      detection for Android, where AirPods' iOS-only feature doesn't exist)
- [ ] Optional: serve from the Mac Mini over https for a proper installable
      PWA on the Fairphone

## Files

- `index.html` — the entire app (CSS + JS inline)
- `serve.py` — stdlib-only dev server + same-origin feed proxy
