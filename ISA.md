---
task: "Add a linear audiobook mode to Caster"
slug: caster-linear-audiobooks
phase: climbing
progress: 0/14
principal_stated_goal: "Add audiobook playback for the Harry Potter series while retaining the existing podcast randomizer; audiobook chapters play linearly and resume from Jellyfin."
context_sufficient: true
---

## Problem
Caster is a podcast randomizer being extended for audiobooks. The audiobook player must play numbered chapters sequentially and resume from Jellyfin's per-user position. The app stays static on GitHub Pages and connects directly to Justin's Jellyfin server.

## Goal
Add a scoped audiobook listening mode to Caster, with linear chapter playback and Jellyfin-backed resumable positions, while preserving podcast shuffle and static GitHub Pages hosting. The app targets Justin's seven Harry Potter audiobooks and discovers their containing folder by matching its seven numbered child folders. It must not list unrelated library items, persist access tokens, or place them in stream URLs.

## Anonymous stream trade-off
The app's catalogue and progress requests use account authentication, but native audio cannot send an Authorization header. Some Jellyfin servers allow the media stream without auth; when so, that stream is publicly accessible to anyone with the media URL. Verify the selected server's behaviour and decide whether that exposure is acceptable before playback. The page does not store or publish stream URLs.

## Features

### F0 · Cross-cutting safety and regression boundaries
Why: The new mode shares the player with podcasts; keep mode rules and secret handling separate.

- [ ] ISC-1: Podcast shuffle, auto-advance, sleep timer and locally persisted episode positions remain unchanged.
- [ ] ISC-2: The Jellyfin token lives only in its own localStorage key (deliberate session durability); no token or password in app state, source, feeds data or the diagnostics log.
- [ ] ISC-3: Anti: no item outside the seven-book Harry Potter series is rendered or playable.
- [ ] ISC-4: Bearer token is attached only to JSON API/report calls; stream URLs never carry it.

### F1 · Scoped catalogue
Why: List only the selected Harry Potter books, with chapters in their filename order.

- [ ] ISC-5: Catalogue discovery identifies the series folder by its seven numbered Harry Potter book children, then requests only those children's chapter items.
- [ ] ISC-6: Chapter order comes from `CH\d+` filenames; missing or duplicate numbers are shown and prevent unsafe auto-advance.
- [ ] ISC-7: Loading, error, empty and populated views contain only series items and the seven book folders' chapter lists.

### F2 · Ordered playback and resume
Why: Audiobooks need linear listening and the server's own resume state.

- [ ] ISC-8: Chapters stream through native `<audio>` with seeking and without full-chapter Blob buffering.
- [ ] ISC-9: Resume and progress use the real PlaybackInfo session and media-source IDs; missing position never becomes a zero write.
- [ ] ISC-10: Chapter next/end/previous stay within the selected book; end of book stops, never enters podcast shuffle or another book.
- [ ] ISC-11: Exact Jellyfin user-data read-back matches the last reported position after a controlled playback check.
- [ ] ISC-12: No second browser-persisted audiobook position exists; Jellyfin is the durable resume source.
- [ ] ISC-13: Access token exists only in page memory; reload requires sign-in.

## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|---|---|---|---|---|---|
| ISC-1 | behavioral | Podcast shuffle, next, sleep and saved podcast position | pass | `node --test tests/*.test.mjs`; real browser still pending | podcast isolation |
| ISC-2 | unit-test | Token only in its own key; no password/token in state, source or log | assertions pass | `node --test tests/caster-mode.test.mjs` | literal |
| ISC-3 | unit-test | Unrelated folders cannot be selected without exact supplied name | exact match only | `node --test tests/jellyfin.test.mjs` | literal |
| ISC-4 | unit-test | Auth header carries token; media URL never does | pass | `node --test tests/jellyfin.test.mjs` | literal |
| ISC-5 | integration | Scoped authenticated traversal returns seven numbered books | expected fixture count | `node --test tests/jellyfin.test.mjs`; real account probe pending | literal |
| ISC-6 | unit-test | Filename order, gap and duplicate detection | correct ordering | `node --test tests/jellyfin.test.mjs` | literal |
| ISC-7 | browser | Loading/error/empty/populated screens | no unrelated items | real-browser check pending | literal |
| ISC-8 | browser | Native stream plays/seeks from deployed origin | seek works | real-browser check pending | literal |
| ISC-9 | integration | Real session/source IDs and no invalid zero report | pass/readback | authenticated server probe pending | literal |
| ISC-10 | unit-test | Queue boundaries and end-of-book stop | all cases pass | `node --test tests/caster-mode.test.mjs` | literal |
| ISC-11 | integration | Read back the exact user/item's resume position | same reported ticks | authenticated server probe pending | literal |
| ISC-12 | bash | No audiobook position localStorage writes | zero writes | source/tests audit | literal |
| ISC-13 | bash | No token browser-storage writes | zero writes | source/tests audit | literal |

## Decisions
- Keep deployment on static GitHub Pages; no proxy/backend.
- Ask for the Jellyfin server URL at connection time; discover the series folder from its numbered book children rather than requiring its parent name.
- Use per-session Jellyfin credentials in memory and native `<audio>` stream URLs only if the selected server's unauthenticated stream policy is acceptable.
- Use filename chapter numbers rather than assumed Jellyfin index metadata.
- Use actual PlaybackInfo session/source identifiers for every playback report.

## Verification status
- Automated tests pass locally; the latest pushed code is available on the public repository.
- GitHub Pages deployment and real-browser verification are tracked separately; no completion claim until the published `jellyfin.mjs`, audio playback, and Jellyfin read-back are verified.

## Change History
- Initial implementation and verification state recorded in commits `e87108b` and `3032358`; use Git history for exact diffs.
- URL validation fix is in the latest local work and still needs its own commit/push.

## Privacy note
This repository is public. Do not commit personal server hostnames, private library names or paths, item titles, playback/resume details or other identifying media metadata. The running app asks for the server URL at sign-in and stores only that URL and username locally; the access token stays in memory for the tab session. The seven-book series is discovered by matching child-folder naming, not private parent-folder metadata.

## Vision
A sleepy listener opens Caster and sees only the seven Harry Potter audiobooks. One tap resumes the in-progress chapter at Jellyfin's saved position; chapter completion moves to the next numbered chapter in the same book, never a random podcast or another book. The familiar player and sleep timer remain, and podcast shuffle continues exactly as before. The catalogue/reporting session is private to the authenticated account; stream URLs themselves are public under the server's current configuration and are never shared.

## Out of Scope
- Other Jellyfin libraries or audiobooks, including podcasts/media unrelated to these seven books.
- Changes to Jellyfin library, access policy, CORS, reverse proxy, DNS, or network exposure.
- A new backend, proxy, server, build system or framework.
- Token-in-URL authentication, admin API keys, persistent credential storage, whole-chapter buffering, or downloads.
- Changing podcast selection, progress or sleep behaviour.
- Deploying or pushing the app.

## Principles
- The existing podcast paths remain stable while the new audiobook mode has a separate queue policy.
- Jellyfin user data is the source of truth for audiobook chapter resume and played state.
- A playback report must use the real `PlaySessionId` returned for that chapter; a fabricated session ID can reset resume state.
- Discover the Harry Potter parent from the seven numbered book-folder children, then keep chapter discovery and UI inside those book IDs.
- Keep bearer tokens in page memory only and only in Authorization headers; native stream URLs remain token-free.

## Constraints
- The product stays an unbundled static GitHub Pages PWA with zero runtime server-side code.
- Existing app is single-file `index.html`; keep architecture small and use native browser APIs.
- The person connects by entering an HTTPS Jellyfin server URL; do not publish any personal server hostname in this public repository.
- Search only direct children of the Audiobooks library for the seven numbered Harry Potter folders; fetch chapters only beneath the matching series folder and never list the whole library in Caster.
- Chapter order comes from `CH01`, `CH02`, … filenames, not `IndexNumber`.
- Native `<audio src>` cannot carry a custom Authorization header. Validate streaming/auth assumptions against the selected server and treat unauthenticated audio URLs as public.
- Every playback report uses the real `PlaySessionId` and `MediaSourceId` from `PlaybackInfo`; report positions in Jellyfin ticks.
- No changes to any Jellyfin server, library, account, or playback state are part of deployment.

## Goal
Add a scoped audiobook listening mode to Caster, with linear chapter playback and Jellyfin-backed resumable positions, while preserving podcast shuffle and static GitHub Pages hosting. The first deployment targets the requested Harry Potter books; users connect to their own HTTPS Jellyfin server and Caster scopes catalogue traversal to those books. The app must not list unrelated library entries, persist access tokens, or place them in stream URLs.

## Features

### F0 · Cross-cutting safety and regression boundaries
Why: The new mode uses the same player surface and personal Jellyfin state as podcasts, so strict data and behaviour isolation is part of done.

- [ ] ISC-1: Podcast shuffle, auto-advance, sleep timer and locally persisted episode positions are unchanged.
- [ ] ISC-2: The Jellyfin token lives only in its own localStorage key (deliberate session durability); no token or password in app state, source, feeds data or the diagnostics log.
- [ ] ISC-3: Anti: no item outside the selected Harry Potter parent is rendered or playable.
- [ ] ISC-4: Jellyfin bearer token is attached only to JSON API/report calls; chapter media-element URLs never contain a token.

### F1 · Harry Potter catalogue and connection
Why: Caster must show only the seven intended books and their correctly ordered chapters.

- [ ] ISC-5: The authenticated request discovers exactly the Harry Potter parent folder and its seven book subfolders.
- [ ] ISC-6: Every book's chapter list is complete and ordered by filename chapter number, with duplicates/gaps detected and surfaced.
- [ ] ISC-7: Loading, error, empty, and populated states stay scoped to the Harry Potter catalogue; inaccessible non-HP items are never requested for display.
- [ ] ISC-14: Invalid Jellyfin URL is rejected before any authentication or catalogue request.

### F2 · Linear playback and resume
Why: Audiobooks should continue chapter-to-chapter and resume where listening stopped without entering podcast shuffle.

- [ ] ISC-8: A chosen chapter streams through the existing native audio player, supports seeking, and never needs a whole-chapter Blob.
- [ ] ISC-9: Resume starts at Jellyfin's stored chapter position and reports progress/pause/stop with the actual PlaybackInfo session/source IDs.
- [ ] ISC-10: Ended/next advances only to the next numbered chapter in the same book; end-of-book stops, and previous/skip never calls podcast random selection.
- [ ] ISC-11: Progress reads back from the exact Jellyfin user-data item at the last reported position; missing playback context cannot write zero or reset a resume.
- [ ] ISC-12: The app has no fallback browser-side position store; Jellyfin is the only durable audiobook resume authority.
- [ ] ISC-13: The Jellyfin access token remains in JavaScript memory only; sign-in is required after reload.

## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|---|---|---|---|---|---|
| ISC-1 | bun-test | Podcast shuffle, next, sleep and locally saved progress regression suite | pass | `node --test tests/*.test.mjs`; browser functional check pending | derived: podcast-mode-isolation |
| ISC-2 | unit-test | Token only in its own key; no password/token in state, source or log | assertions pass | `node --test tests/caster-mode.test.mjs` | literal |
| ISC-3 | bun-test | Fixture with other audiobooks never returns them from scoped catalogue normalizer | exact HP-only set | `node --test tests/jellyfin.test.mjs` | literal |
| ISC-4 | bash | Constructed media URLs contain no auth material; fetch headers carry token | pass | `node --test tests/jellyfin.test.mjs` + source inspection | literal |
| ISC-5 | screenshot | Authenticated folder traversal returns selected HP root + seven books | exactly 7 | Preflight Chrome/API evidence | literal |
| ISC-6 | bun-test | Chapter ordering handles gaps, lexical traps, inconsistent IndexNumber and duplicates | numbered order; gaps flagged | `node --test tests/jellyfin.test.mjs` | derived: HP-folder-chapter-numbering |
| ISC-7 | screenshot | Loading/error/empty/populated views stay scoped to Harry Potter | none leak other library items | browser check pending | literal |
| ISC-8 | screenshot | Native audio element plays and seeks a chapter from deployed app origin | successful seek; no Blob chapter buffering | browser check pending | literal |
| ISC-9 | curl | Session report uses PlaybackInfo PlaySessionId/MediaSourceId and Jellyfin ticks | API 204 + correct read-back | authenticated API read-back pending | literal |
| ISC-10 | bun-test | Chapter-end/next/previous/skip actions stay within current book and at book end stop | all transitions in fixture | `node --test tests/caster-mode.test.mjs` | derived: ordered-book-queue |
| ISC-11 | curl | Read-after-write verifies exact user, item and resume position; no stale/zero report | same ticks, played false | authenticated API read-back pending | literal |
| ISC-12 | bash | No browser storage writes audiobook positions | zero writes | `node --test tests/caster-mode.test.mjs` | literal |
| ISC-13 | bash | Token persistence audit finds no browser-storage writes | zero writes | `node --test tests/caster-mode.test.mjs` | literal |
| ISC-14 | unit-test | Invalid server URL causes no authentication or catalogue request | 0 requests | `node --test tests/caster-mode.test.mjs` | literal |

## Decisions
- 2026-10-07: Jellyfin server URL is supplied by the person connecting; do not publish a personal server hostname in this public repo.
- 2026-10-07: Public Jellyfin server responds with version 10.11.11; exact CORS preflights succeed.
- 2026-10-07: Identify the series by its seven numbered child folders; request chapter items only within that matching series folder, and never list the full library in Caster.
- 2026-10-07: Use `CH\\d+` parsed from chapter paths for ordering; `IndexNumber` metadata is unreliable.
- 2026-10-07: Use native `<audio>` ranged streams; current server serves chapter audio without auth, so treat those stream URLs as public.
- 2026-10-07: Use actual PlaybackInfo session/source IDs in playback reports. Never invent a session ID or report a guessed zero position.
## Verification
- Preflight browser/API evidence and sanitized outcomes are in `.hermes/plans/2026-10-07_202316-caster-jellyfin-audiobooks.md`.
- All 28 automated tests pass; `node --check` passes for the Jellyfin client and tests; manifest JSON and inline-module parse checks pass; `git diff --check` passes.
- Commit `e87108b` is on `main`; remote Pages build is still `building`. The live site returned old content and `/jellyfin.mjs` returned 404 at the last probe, so a cache-busted real-browser test and Jellyfin read-back remain pending; the published feature is not ready to test yet.
- No browser sign-in, live audiobook playback, or progress write was performed by this implementation turn. Prior catalogue/stream probes did not modify the five existing resume positions and restored the single temporary test chapter.
- At close, replace this note with compact provenance stubs for each closed claim; no progress claim closes without the probes in Test Strategy.
