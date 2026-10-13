// LIVE end-to-end probe — the fast verification loop.
//
//   node --test tests/*.test.mjs        offline suite (deterministic, no network)
//   node --test tests/live.test.mjs     …then this: the real app against the real server
//
// Boots the REAL index.html script in the vm, injects the REAL authenticated
// JellyfinClient and the REAL chapter list of a Harry Potter book, then drives a
// chapter boundary and reads the position back off the server. Proves the thing
// that was broken: session established, reports accepted, next chapter plays.
//
// Skips cleanly when no credentials/server are available (CI, other machines).
// The server URL is resolved at runtime — never written into this public repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { bootCaster, flushChains } from './harness.mjs';
import { JellyfinClient } from '../jellyfin.mjs';

const credPath = `${process.env.HOME}/Documents/jellysecret.txt`;

function resolveServer() {
  if (process.env.JELLYFIN_SERVER) return process.env.JELLYFIN_SERVER;
  try {
    // the URL was scrubbed from HEAD but survives in history; derive it, never commit it
    const hist = execSync('git show e87108b:ISA.md', { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
    return hist.match(/https:\/\/jellyfin[^\s)"]+/)?.[0] || null;
  } catch {
    return null;
  }
}

const server = resolveServer();
const haveCreds = existsSync(credPath);
const skip = !server || !haveCreds
  ? `live probe skipped: ${!server ? 'no server URL (set JELLYFIN_SERVER)' : 'no ~/Documents/jellysecret.txt'}`
  : false;

// The app's session setup is fire-and-forget, so poll instead of flushing blindly —
// real network latency makes a fixed number of microtask turns meaningless.
const waitFor = async (label, cond, ms = 20000) => {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setImmediate(r));
  }
};

test('live: real app + real server — session, reports, advance, read-back', { skip }, async (t) => {
  t.diagnostic('authenticating…');
  const [username, password] = (await readFile(credPath, 'utf8')).split('\n');
  const client = await JellyfinClient.authenticate({
    serverUrl: server, username, password, deviceId: 'caster-live-probe',
  });

  // Real chapters, loaded through the app's own catalogue path.
  // Deliberately the LAST book, never the one he is actually listening to: this probe
  // writes a real position and a real LastPlayedDate, and if it shared his book it would
  // pollute exactly the evidence used to diagnose his device (it did, once).
  const { books } = await client.getHarryPotterBooks();
  const book = books[books.length - 1];
  assert.ok(book?.chapters?.length >= 2, 'the book has at least two chapters');
  const [ch1, ch2] = book.chapters;
  t.diagnostic(`book "${book.title}" — ${book.chapters.length} chapters, testing ${ch1.title} → ${ch2.title}`);

  const readPos = async (id) => {
    const item = await client.request(`/Users/${encodeURIComponent(client.userId)}/Items/${id}`, { params: { Fields: 'UserData' } });
    return ((item.UserData || {}).PlaybackPositionTicks || 0) / 1e7;
  };
  const before1 = await readPos(ch1.id);
  t.diagnostic(`CH01 position before: ${before1}s`);

  const { context } = bootCaster();

  vm.runInContext(`(()=>{
    window.MediaMetadata = class { constructor(v){ Object.assign(this,v); } };
    audiobookUser = {Id:'live'};
    playerMode='audiobook'; currentShowId=null; currentGuid=null;
    audiobookLibraryState='ready';
    audiobooksNavBack=[{title:'Audiobooks',parentId:null}];
    audio.playCalls = 0;
  })()`, context);
  // host → vm: the real client, the real chapter array, the real book
  const w = context.window;
  w.__client = client;
  w.__book = { id: book.id, title: book.title, chapters: book.chapters, missingChapterNumbers: [], duplicateChapterNumbers: [] };
  vm.runInContext(`(()=>{
    audiobookClient = window.__client;
    audiobookBooks = [window.__book];
    audiobooksNav = window.__book.chapters;
    audiobooksNavTitle = window.__book.title;
    audiobooksNavParentId = window.__book.id;
    audiobookServerUrl = window.__client.serverUrl;
  })()`, context);

  // 1. start chapter 1 — does the real session get established?
  vm.runInContext(`playAudiobook(window.__book.id, window.__book.chapters[0].id, {positionTicks:0, autoplay:true})`, context);
  await waitFor('playback session', () => vm.runInContext('!!audiobookSession || !!audiobookError', context));
  const started = vm.runInContext('({session:audiobookSession, err:audiobookError, src:audio.src, plays:audio.playCalls, chapter:audiobookActiveChapterId})', context);
  t.diagnostic(`after start: session=${started.session ? 'ESTABLISHED' : 'MISSING'} err=${started.err || '(none)'} plays=${started.plays}`);
  assert.ok(started.session, `playback session must be established — got error: ${started.err || '(none)'}`);
  assert.equal(started.err, '', 'a healthy start must not raise an error');
  assert.ok(started.plays >= 1, 'audio must start without a tap');
  assert.match(started.src, /\/Audio\//, 'the real stream URL is set');
  const session1 = vm.runInContext('({playSessionId:audiobookSession.playSessionId, mediaSourceId:audiobookSession.mediaSourceId})', context);

  // 2. a realistic progress report (the server ignores positions under ~2 minutes)
  vm.runInContext(`queueAudiobookReport('progress', 600, false)`, context);
  await flushChains(context, 6);
  await waitFor('position persisted on the server', async () => Math.abs((await readPos(ch1.id)) - 600) < 2, 15000)
    .catch(() => {});
  const pos1 = await readPos(ch1.id);
  t.diagnostic(`CH01 position after progress report: ${pos1}s`);
  assert.ok(Math.abs(pos1 - 600) < 2, `the server must persist the reported position (want ~600s, got ${pos1}s)`);

  // 3. chapter ends → must advance and play with no tap
  const playsBefore = vm.runInContext('audio.playCalls', context);
  vm.runInContext('audio.paused = true; next()', context);
  await waitFor('next chapter session', () =>
    vm.runInContext('audiobookActiveChapterId', context) === ch2.id && vm.runInContext('!!audiobookSession', context));
  const afterEnd = vm.runInContext('({chapter:audiobookActiveChapterId, src:audio.src, plays:audio.playCalls, err:audiobookError, session:!!audiobookSession})', context);
  t.diagnostic(`after ended: chapter=${afterEnd.chapter === ch2.id ? 'CH02' : afterEnd.chapter} plays=${afterEnd.plays} err=${afterEnd.err || '(none)'}`);
  assert.equal(afterEnd.chapter, ch2.id, 'ended must advance to the next chapter of the same book');
  assert.ok(afterEnd.plays > playsBefore, 'the next chapter must start playing with no tap');
  assert.ok(afterEnd.session, 'the next chapter must get its own session');
  assert.equal(afterEnd.err, '', 'no error on a healthy advance');
  assert.match(afterEnd.src, new RegExp(`/Audio/${ch2.id}/`), 'the stream URL points at chapter 2');

  // 4. the player must still know what is playing (this is what the browse bug broke)
  const ui = vm.runInContext('({current:current() && current().id, show:currentShow() && currentShow().title, bar:document.querySelector("#pbar").style.display})', context);
  t.diagnostic(`player state: current=${ui.current === ch2.id ? 'CH02' : ui.current} title=${ui.show}`);
  assert.equal(ui.current, ch2.id, 'the player bar must show the chapter that is playing');
  assert.equal(ui.show, book.title, 'the player bar must show the book that is playing');

  // restore — leave his history exactly as we found it (positions were 0)
  const session2 = vm.runInContext('({playSessionId:audiobookSession.playSessionId, mediaSourceId:audiobookSession.mediaSourceId})', context);
  await client.reportStopped(ch1, session1, 0).catch(() => {});
  await client.reportStopped(ch2, session2, 0).catch(() => {});
  const [after1, after2] = [await readPos(ch1.id), await readPos(ch2.id)];
  t.diagnostic(`restored: CH01=${after1}s CH02=${after2}s`);
  assert.equal(after1, 0, 'CH01 position restored to 0');
  assert.equal(after2, 0, 'CH02 position restored to 0');

  t.diagnostic('live probe passed');
});
