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

Hosted at https://jalamb5.github.io/caster/. Your favourite shows ship as
**bundled data** (`feeds.json`, committed to the repo) — the app fetches no
RSS at runtime, so there's no CORS, no proxy, and nothing to go flaky.
Playback uses each episode's audio URL directly, which works cross-origin.
Already-saved shows work offline.

Audiobook sign-in connects directly from your browser to your HTTPS Jellyfin
server. Enter the server URL, Jellyfin username and password; Caster finds the
Harry Potter series folder by its seven numbered book folders, so you do not
need to know its exact parent-folder name. The password is not saved and the
access token stays in memory only. If the browser cannot read Jellyfin's
response, allow `https://jalamb5.github.io` in the server's CORS settings.

### Refreshing show data

New episodes appear when `feeds.json` is regenerated and pushed:

```bash
python3 refresh_feeds.py     # fetches the FEEDS list, rewrites feeds.json
git add feeds.json && git commit -m "refresh feeds" && git push
```

Add or remove shows by editing the `FEEDS` list at the top of
`refresh_feeds.py` (any podcast RSS URL — including private Patreon feeds).
Play history is stored per-episode on your device, so refreshing never resets
what you've heard.

The optional ⚙ Settings → **Custom CORS proxy** field still exists if you ever
want to add a show live from inside the app (it fetches that one feed at
runtime); bundled shows never need it.

## How the algorithm works

- **Unplayed** episodes: weight 10.
- **Played** episodes: `1 + 4·e^(−daysSincePlayed/freshness)` — old favourites
  resurface, last week's stay buried, weight never reaches zero (played ≠
  excluded).
- **Repeat guard**: episodes heard within the last N hours are skipped while
  others exist (no same-episode-twice-tonight).
- Marked **heard** at 85% consumed (so the one you fell asleep in sinks low
  for a while instead of vanishing); skipping records it too.
- **Shuffle all**: picks the *show* first, weighted by unplayed count (a show
  with lots of unheard episodes dominates; an all-heard show still gets a
  share), then a weighted episode inside it.
- Tune `freshness` and the guard in ⚙ Settings.

## Roadmap

- [x] MVP: add shows (iTunes search or RSS URL), weighted shuffle, continuous
      auto-play, sleep timer, lock-screen controls (Media Session), resume
      position, played tracking
- [x] Shuffle all shows (weighted across the whole library)
- [ ] Groupings: shuffle across a chosen subset of shows (in-app, beyond
      "all")
- [ ] Offline: download a random batch (by episode count or total time)
- [ ] "Pause when the phone hasn't moved for N minutes" (accelerometer sleep
      detection for Android, where AirPods' iOS-only feature doesn't exist)
- [ ] Optional: serve from the Mac Mini over https for a proper installable
      PWA on the Fairphone

## Files

- `index.html` — the entire app (CSS + JS inline)
- `serve.py` — stdlib-only dev server + same-origin feed proxy
