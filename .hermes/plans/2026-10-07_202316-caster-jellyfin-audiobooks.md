# Caster Jellyfin Audiobooks Implementation Plan

> For Hermes: Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a Harry Potter audiobook listening mode to Caster, with linear playback and reliable resumable progress, while keeping the app static-hostable on GitHub Pages and preserving podcast shuffle behaviour.

**Architecture:** Keep Caster as a static browser app. Add a small dependency-free Jellyfin client module for authentication, catalogue queries, streaming/session reporting and tests; keep the existing podcast flow intact, and make audiobook queue/position rules explicit in the shared player. Use a restricted Jellyfin user login, never a server API key. The published code must not contain the principal's personal Jellyfin hostname: the user enters the HTTPS server URL in the connection dialog; Caster remembers that URL and the username locally but keeps the returned token in page memory only. Before using a configured endpoint, prove how to stream without a token in the media URL or whole-chapter buffering. If a service requires an authenticated-media proxy, stop and bring back a safe alternative rather than quietly adding a backend.

**Tech Stack:** Existing HTML/CSS/vanilla JavaScript PWA; one small ES module; Node's built-in test runner; Jellyfin REST API; no framework or runtime server dependency.

---

## Goal and acceptance criteria

- Podcast selection, weighting, shuffle-all, auto-advance, sleep timer and current local progress continue to behave as they do now.
- A Jellyfin connection can be established against `https://jellyfin.lambharbour.com` with a normal, restricted user account; no credentials or long-lived API key are committed, logged, or stored in the published app.
- Only Harry Potter audiobook items are exposed in Caster, based on the actual library metadata discovered during the preflight. No other Jellyfin books are listed or made playable.
- [ ] A selected audiobook plays in order. Track/chapter/part transitions never invoke podcast shuffle. Books, chapters and positions are discovered from the exact Harry Potter library folder and report from this principal's Jellyfin identity; a different user's resume state or a chapter in another book never enters a queue.
- [ ] On reopen/reconnect, Caster offers in-progress chapters in the last-in-progress book and resumes from Jellyfin's per-chapter position. Progress is reported with a real `PlaySessionId` during playback and on pause/stop/page hide; failures are visible and never replace valid resume with zero.
- [x] The current server permits unauthenticated ranged native MP3 streaming (`206`, `audio/mpeg`, seeking worked in Chrome) without a token in the stream URL or whole-chapter buffering. The stream URLs are therefore public to anyone who obtains them; Caster's catalogue and API/reporting stay account-authenticated.
- [ ] GitHub Pages remains the deployment target; no backend is added as an implicit requirement.

**Scope clarification (refined 2026-10-07):** Because Jellyfin exposes the chapter stream without authentication and only authenticated requests can restrict the catalogue to the principal's Harry Potter folder, keep the catalog and all playback-report APIs authenticated, and never render/request other library items. The media URLs themselves are not access-controlled by Jellyfin in the current configuration; treat that as known server behaviour, and do not share those URLs. No settings change is in scope.
## Current repository facts

- `index.html` is a single-file PWA. It already has one `<audio>` element, custom player controls, Media Session metadata/lock-screen actions, a sleep timer, and per-episode localStorage positions.
- Podcast `next()` intentionally picks randomly; `ended` is wired to it. Podcast position and `markHeard()` are stored locally. Audiobooks must not share these semantics blindly.
- `feeds.json` is a static podcast catalogue. `serve.py` is only a local development/RSS proxy; it does not run on GitHub Pages.
- The repository currently has no test/package manifest. Keep dependencies at zero and avoid turning the project into a framework app.
- Current branch is `main`; initial inspection found no working-tree changes.

## Design decisions and guardrails

1. Keep two playback modes (`podcast` and `audiobook`) sharing controls but not queue policy. Podcast remains weighted-random. Audiobook queue is ordered and scoped to one book.
2. Filter the Jellyfin catalogue to Harry Potter using the fields and `ItemType` actually returned by this server. Do not assume the library calls it `AudioBook`, that every file is one item, or that chapter and multi-part metadata have a particular shape.
3. Use a restricted Jellyfin user, not an admin API key. Keep the access token in memory for the active page/session only; don't persist a password or token in `localStorage`, `feeds.json`, source, logs, or URLs. A reload may require signing in again unless a later explicit decision approves a safer persistence mechanism.
4. Jellyfin API calls can carry an Authorization header. Native `<audio src>` requests cannot be given arbitrary headers, so streaming auth is a gating technical probe. Do not solve that by adding a token to a query string. Test header-authenticated `fetch`/stream handling and supported browser media capabilities against the actual server/device. Do not fetch an entire audiobook into a Blob.
5. Do not loosen Jellyfin CORS to wildcard as a shortcut. Identify the exact app origin (`https://jalamb5.github.io`, and any custom domain actually used) and request only those origins if configuration is required. Changing server configuration is outside this plan without explicit approval.
6. Jellyfin progress is authoritative for cross-reload resume. Local progress may be a best-effort display/fallback, but it must not overwrite newer server progress with stale or zero values.
7. Preserve and test HTML audio `ended`, Media Session next/previous, UI skip, sleep-at-end, pause and seek in both modes.

## Implementation tasks

### Task 1: Read-only Jellyfin capability and catalogue preflight

**Objective:** Resolve the implementation's material unknowns before adding auth or playback code.

**Files:** No project files changed. Record findings in the implementation ISA/plan notes, not in a committed secret-bearing artifact.

**Checks:**
- Fetch only public server info/API documentation without credentials and identify the deployed Jellyfin version and API schema available on this instance.
- In a browser on the Pages origin, determine whether exact-origin CORS permits the needed API methods/headers. Check preflight behaviour; do not change the server.
- With a restricted test-user session supplied through an approved secure UI (never chat), inspect only the relevant Harry Potter results: library/collection type, item types, names/series metadata, item IDs, run time, chapters/parts/media sources, resume position, and playable stream options. Don't export or log the token or unrelated library data.
- Test the viable streaming method from the target phone/browser: seek, pause, resume, and background/lock-screen playback. Confirm Authorization does not appear in stream URLs or browser-visible logs.
- If the app cannot securely stream without a token-bearing URL or whole-book buffering, stop and compare explicit alternatives: a same-origin Jellyfin proxy/companion service, an approved auth-capable streaming mechanism, or deferring Jellyfin playback. Do not implement one without approval.

**Falsifier:** Any required API request is blocked by CORS; the server's Harry Potter items cannot be identified without exposing the whole library; or audio playback requires a forbidden token-in-URL/full-book-buffer workaround.

**Preflight findings (verified 2026-10-07):** Jellyfin reports `10.11.11`. From the authenticated Chrome session, `GET /Users/{userId}/Items?includeItemTypes=AudioBook&Recursive=true&Fields=Path,MediaSources&Limit=1000` returned 814 items; filtering the Harry Potter folder produced 199 chapters: 17, 18, 22, 37, 38, 30 and 37. Chapter `IndexNumber` values are inconsistent; padded `CH01...` filenames provide the correct order. Five chapters have non-zero resume positions before testing. Authenticated Range returned `206 audio/mpeg` with `Accept-Ranges` and Content-Range. Chrome played a fetched full-chapter MP3 Blob and sought, but it downloads the whole chapter, so that is not our transport. Cache-busted unauthenticated Range and native `<audio>` playback also succeeded, with no user-data change: this server serves the MP3 chapter media URLs publicly, so native ranged playback needs no token URL or full-chapter buffering. `/Items` and `/Library/VirtualFolders` return 401 without auth; keep the catalog and progress reports account-authenticated and scope queries by the authenticated user to the one exact Harry Potter folder. Treat media URLs as public/unshareable. Progress/Stopped both returned 204; a progress report with a real `PlaySessionId` from `/Items/{id}/PlaybackInfo` and matching `MediaSourceId` preserved an existing non-zero resume on read-back. A guessed session id incremented play count and reset a test chapter position; never invent the session ID. All five pre-existing non-zero positions were read back unchanged. I reset only the temporary test chapter's playCount to its original zero, then verified zero/false/zero. No files, server settings, or existing resumed chapter states were changed.

**Exit evidence:** Sanitized notes answering the above, plus a go/no-go recommendation for the static Pages architecture. No auth values retained.

### Task 2: Add the no-dependency Jellyfin API module and focused tests

**Objective:** Isolate Jellyfin URL construction, auth headers, filtering, normalization and progress payload logic from the existing inline app.

**Files:**
- Create `jellyfin.mjs` with small functions for normalized server URL validation, Authorization header construction, JSON API requests, exact Harry Potter filtering/normalization based on Task 1, ticks/seconds conversion, and playback report payload creation.
- Create `tests/jellyfin.test.mjs` using `node --test` and Node built-ins only.

**Test cases:**
- Reject non-HTTPS public server URLs and malformed URL input; allow localhost only for local development if needed.
- API requests keep tokens in Authorization headers and never append them to URLs.
- Only records matching the discovered Harry Potter series metadata pass the filter; unrelated audio/books fail closed.
- Normalize missing artwork, duration, resume and optional chapter/part metadata without inventing values.
- Convert Jellyfin ticks and browser seconds exactly; progress reports never turn missing/zero position into an unintended reset.

**Verification:** `node --test tests/jellyfin.test.mjs` passes. Inspect test output and source diff.

**Falsifier:** Any test shows token inclusion in a URL, a non-series result included, or invalid position conversion/reporting.

### Task 3: Add explicit Jellyfin connection and Harry Potter catalogue UI

**Objective:** Let the principal connect and see only the in-scope audiobooks.

**Files:**
- Modify `index.html` for the mode/navigation entry, sign-in/connect UI, loading/error/empty states, and Harry Potter book list/detail view.
- Import the new `jellyfin.mjs` module from `index.html`.

**Behaviour:**
- Server URL defaults to the supplied HTTPS endpoint; permit editing only if needed for local testing.
- Sign-in sends the password directly to the server's authentication endpoint, clears the input after use, and retains only the returned user token in page memory. No token/password persistence, analytics, or console logging.
- Query and display only Harry Potter audiobook items. Keep the rest of the Jellyfin library out of the UI.
- Provide clear states for auth failure, CORS/network failure, no matching books and server unavailable. Do not make podcast use depend on Jellyfin being reachable.

**Verification:** Unit tests from Task 2 plus real-browser check of sign-in, catalogue filtering, reconnect and error states using a restricted test account. Inspect storage and network requests to verify no token persistence or URL leakage.

**Falsifier:** Unrelated library items appear, credentials survive page reload, or podcasts become inaccessible when Jellyfin is unavailable.

### Task 4: Add ordered audiobook playback and server-backed resume

**Objective:** Make the existing player support linear Harry Potter listening with accurate Jellyfin progress.

**Files:**
- Modify `index.html` player state, `playEpisode`/source setup, `next`, `skipCurrent`, `ended`, seek and progress handlers, Media Session actions, sleep timer behaviour and player labels.
- Modify `jellyfin.mjs` only where Task 1 confirms the API contract.

**Behaviour:**
- Track player mode and audiobook/book identity separately from podcast `currentShowId/currentGuid`.
- Start/resume the selected book from Jellyfin's `PlaybackPositionTicks` (convert ticks to seconds). If multiple parts/chapters are exposed, follow the verified order and preserve a book-level offset; if the instance's representation cannot be handled safely, surface the book as unsupported rather than playing parts out of order.
- In audiobook mode, next/ended advances to the next part/chapter of this book (or completes/stops at the book end); it never selects a random podcast or another book. Previous and skip semantics are explicitly audiobook-safe.
- Report playback start/progress/stopped using verified server API shapes and the same stable device identity. Throttle periodic progress reports; report at pause, track transition, page hide and stop. Suppress stale asynchronous reports from an old item after a switch.
- Persist only non-secret, non-authoritative UI preferences locally if needed. Do not issue a zero-position report when the live position is unavailable.
- Keep podcast flow unchanged, including its current progress semantics.

**Verification:** Unit tests for the pure policy/payload logic; browser tests for resume, ordered part transitions, end-of-book, seek, pause, sleep timer and Media Session. Read the exact Jellyfin user-data after playback to confirm the reported position; reload and resume from that server value. Test podcast shuffle and auto-advance regression paths.

**Falsifier:** Any audiobook action invokes podcast shuffle, position regresses to zero/stale data, ordered parts are skipped/repeated, or Jellyfin read-back disagrees with the last reported position beyond normal reporting interval.

### Task 5: Documentation and final regression check

**Objective:** Explain how to connect this static app safely and verify the shipped configuration remains Pages-compatible.

**Files:**
- Modify `README.md` with Jellyfin setup prerequisites, exact-origin CORS instructions only if the verified preflight requires them, restricted-user guidance, HTTPS/reachability notes, Harry Potter scope, and known limits.
- Update PWA title/description in `index.html` and `manifest.webmanifest` only if the new combined purpose warrants it.

**Verification:** Run `node --test tests/jellyfin.test.mjs`; inspect `git diff --check`; build-free static path checks; use a real browser on the published/preview origin and target phone for audio playback, seeking, locked-screen controls and progress read-back. No deploy/push is included without separate authorization.

**Falsifier:** Documentation implies Pages hosts a server, recommends exposing Jellyfin unsafely, or the final regression check changes existing podcast behaviour.

## Likely files

- `index.html` — UI, mode-aware playback and PWA metadata.
- `jellyfin.mjs` — small API/auth/filter/progress boundary.
- `tests/jellyfin.test.mjs` — dependency-free unit tests.
- `README.md` — deployment and connection instructions.
- `manifest.webmanifest` — only if app description/name changes.

## Open decision gate

The critical unresolved issue is authenticated streaming from a native browser audio element. Jellyfin API requests can use an Authorization header, but the existing `<audio>` element cannot attach one. Static Pages cannot proxy requests. Task 1 must demonstrate a safe, seekable, phone-compatible path before Tasks 2–4 proceed. If none is available without token-in-URL or whole-book buffering, bring the specific options back for approval; do not quietly add a server or weaken the security boundary.
