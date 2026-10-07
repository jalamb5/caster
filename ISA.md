---
task: "Add a linear Harry Potter audiobook mode to Caster"
slug: 20261007-195723_caster-jellyfin-audiobooks
phase: climbing
progress: 0/11
started: 2026-10-07T19:57:23Z
updated: 2026-10-07T19:57:23Z
principal_stated_goal: "Okay, let's go ahead and get started then. My jellyfin server is publicly available at https://jellyfin.lambharbour.com For the time being, I'd only care about including the Harry Potter series of audiobooks."
principal_stated_goal_source: conversation
principal_stated_goal_signal: 4
principal_stated_goal_locked: 2026-10-07T19:57:23Z
context_sufficient: true
interview_invoked: false
---

## Problem
Caster's current audio model is podcast-first: podcast episodes are chosen randomly, while Harry Potter audiobook chapters must play in order and retain Jellyfin's per-user resume position. The user's server runs Jellyfin 10.11.11; its seven Harry Potter books live on My Book 1 as 199 separate chapter MP3s. Jellyfin metadata has inconsistent `IndexNumber` fields, but chapter filenames consistently identify `CH01` through each book's final chapter. The browser preflight proved that authenticated API/report calls work, anonymous ranged MP3 streams work directly in native `<audio>`, and the app can remain static on GitHub Pages.

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
- Restrict all audiobook discovery and UI to the exact Harry Potter parent folder ID, then verify chapter file paths/order beneath that parent.
- Keep bearer tokens in page memory only and only in Authorization headers; native stream URLs remain token-free.

## Constraints
- The product stays an unbundled static GitHub Pages PWA with zero runtime server-side code.
- Existing app is single-file `index.html`; keep architecture small and use native browser APIs.
- Jellyfin host is `https://jellyfin.lambharbour.com` (10.11.11); API calls are CORS-accessible from `https://jalamb5.github.io`.
- `GET /Users/{id}/Items` returns only visible root audiobook items unless `ParentId` is narrowed; Harry Potter is one of the child folders under Audiobooks. The verified Harry Potter parent has exactly seven children, the seven book folders.
- Chapter order comes from `CH01`, `CH02`, … filenames, not `IndexNumber`.
- Native `<audio src>` has no custom Authorization header, but current Jellyfin serves chapter MP3 streams anonymously with byte ranges. Treat stream URLs as public; do not persist or disclose them. Catalogue and progress reports require auth.
- Every playback report uses a real `PlaySessionId` from `POST /Items/{itemId}/PlaybackInfo`, with the actual `MediaSourceId`; report positions in 100ns Jellyfin ticks.
- No server changes, deploys, pushes, commits, or modifications to customer/personal data outside a controlled single test chapter.

## Goal
Add a Harry Potter audiobook listening mode to Caster, with linear chapter playback and Jellyfin-backed resumable positions, while keeping the existing podcast mode working and GitHub Pages as the host. The implementation discovers exactly the selected Harry Potter parent and seven child book folders, orders the chapter items by their padded filenames, streams with native ranged `<audio>` requests, and reports Jellyfin session progress using the authenticated account. It never lists or queues any other library entries and never writes secrets or stream URLs into persistent browser storage.

## Features

### F0 · Cross-cutting safety and regression boundaries
Why: The new mode uses the same player surface and personal Jellyfin state as podcasts, so strict data and behaviour isolation is part of done.

- [ ] ISC-1: Podcast shuffle, auto-advance, sleep timer and locally persisted episode positions are unchanged.
- [ ] ISC-2: No Jellyfin token or password is written to localStorage, sessionStorage, source, URL or logs.
- [ ] ISC-3: Anti: no item outside the selected Harry Potter parent is rendered or playable.
- [ ] ISC-4: Jellyfin bearer token is attached only to JSON API/report calls; chapter media-element URLs never contain a token.

### F1 · Harry Potter catalogue and connection
Why: Caster must show only the seven intended books and their correctly ordered chapters.

- [ ] ISC-5: The authenticated request discovers exactly the Harry Potter parent folder and its seven book subfolders.
- [ ] ISC-6: Every book's chapter list is complete and ordered by filename chapter number, with duplicates/gaps detected and surfaced.
- [ ] ISC-7: Loading, error, empty, and populated states stay scoped to the Harry Potter catalogue; inaccessible non-HP items are never requested for display.

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
| ISC-2 | bash | Source/storage audit finds no persisted token/password | no matches | `node --test tests/caster-mode.test.mjs` + source inspection | literal |
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

## Decisions
- 2026-10-07: Jellyfin server URL is supplied by the person connecting; do not publish a personal server hostname in this public repo.
- 2026-10-07: Public Jellyfin server responds with version 10.11.11; exact CORS preflights succeed.
- 2026-10-07: Authenticate and query the exact Harry Potter subfolder and seven child book folders; never list the full library in Caster.
- 2026-10-07: Use `CH\\d+` parsed from chapter paths for ordering; `IndexNumber` metadata is unreliable.
- 2026-10-07: Use native `<audio>` ranged streams; current server serves chapter audio without auth, so treat those stream URLs as public.
- 2026-10-07: Use actual PlaybackInfo session/source IDs in playback reports. Never invent a session ID or report a guessed zero position.
## Verification
- Preflight browser/API evidence and sanitized outcomes are in `.hermes/plans/2026-10-07_202316-caster-jellyfin-audiobooks.md`.
- All 28 automated tests pass; `node --check` passes for the Jellyfin client and tests; manifest JSON and inline-module parse checks pass; `git diff --check` passes.
- Commit `e87108b` is on `main`; remote Pages build is still `building`. The live site returned old content and `/jellyfin.mjs` returned 404 at the last probe, so a cache-busted real-browser test and Jellyfin read-back remain pending; the published feature is not ready to test yet.
- No browser sign-in, live audiobook playback, or progress write was performed by this implementation turn. Prior catalogue/stream probes did not modify the five existing resume positions and restored the single temporary test chapter.
- At close, replace this note with compact provenance stubs for each closed claim; no progress claim closes without the probes in Test Strategy.
