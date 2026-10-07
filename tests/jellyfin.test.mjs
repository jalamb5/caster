import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServerUrl,
  buildMediaBrowserHeader,
  buildApiUrl,
  findAudiobooksLibrary,
  findHarryPotterFolder,
  isHarryPotterBookFolder,
  normalizeChapters,
  ticksToSeconds,
  secondsToTicks,
  buildStreamUrl,
  buildPlaybackReport,
  nextChapter,
  JellyfinClient,
  createDeviceId,
} from '../jellyfin.mjs';

test('device IDs are generated in memory and never require browser storage', () => {
  assert.ok(createDeviceId());
  assert.ok(createDeviceId());
});

test('authenticated API requests send the token in Authorization, never in the URL', async () => {
  let request;
  const client = new JellyfinClient({
    serverUrl: 'https://jellyfin.example.test', userId: 'user-1', accessToken: 'secret-token', deviceId: 'device-1',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ Items: [] }) };
    },
  });
  await client.request('/UserViews');
  assert.match(request.options.headers.Authorization, /Token="secret-token"/);
  assert.doesNotMatch(request.url, /secret-token|api_key/i);
});

test('catalogue traversal filters exact Harry Potter root and seven book folders', async () => {
  const hpRoot = { Id: 'hp-root', Name: 'J K Rowling - Harry Potter 1-7 Unabridged Audiobooks Narrated by Stephen Fry', Type: 'Folder' };
  const seven = Array.from({length:7}, (_, i) => ({ Id:`b${i+1}`, Name:`${i+1} HARRY POTTER AND BOOK ${i+1}`, Type:'Folder' }));
  const requests = [];
  const client = new JellyfinClient({
    serverUrl:'https://jellyfin.example.test', userId:'u', accessToken:'t', deviceId:'d',
    fetchImpl:async url => {
      const parsed = new URL(url); requests.push(parsed);
      let payload;
      if(parsed.pathname.endsWith('/UserViews')) payload={Items:[{Id:'library',Name:'Audiobooks',Type:'CollectionFolder',CollectionType:'books'}]};
      else if(parsed.searchParams.get('ParentId')==='library') payload={Items:[{...hpRoot},{Id:'else',Name:'Harry Potter movies',Type:'Folder'}]};
      else if(parsed.searchParams.get('ParentId')==='hp-root') payload={Items:[...seven,{Id:'8',Name:'8 HARRY POTTER EXTRA',Type:'Folder'}]};
      else {
        const folder = seven.find(book => book.Id === parsed.searchParams.get('ParentId'));
        payload={Items:[{Id:`chapter-${folder.Id}`,Name:'CHAPTER',Type:'AudioBook',Path:`/fake/${folder.Name}/CH01 CHAPTER.mp3`,RunTimeTicks:10000000,MediaSources:[{Id:`source-${folder.Id}`,Container:'mp3'}]}]};
      }
      return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
    },
  });
  const result=await client.getHarryPotterBooks();
  assert.equal(result.rootId,'hp-root');
  assert.equal(result.books.length,7);
  assert.equal(result.books[0].title,'HARRY POTTER AND BOOK 1');
  assert.equal(result.books[0].chapters.length,1);
  assert.ok(requests.every(u=>!u.searchParams.has('api_key')));
});

test('catalogue fails closed rather than accepting other folders or incomplete series', async () => {
  const client = new JellyfinClient({
    serverUrl:'https://jellyfin.example.test', userId:'u', accessToken:'t', deviceId:'d',
    fetchImpl:async url => {
      const parsed=new URL(url);
      const payload=parsed.pathname.endsWith('/UserViews')
        ? {Items:[{Id:'l',Name:'Audiobooks',Type:'CollectionFolder',CollectionType:'books'}]}
        : {Items:[{Id:'other',Name:'Harry Potter movies',Type:'Folder'}]};
      return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
    },
  });
  await assert.rejects(client.getHarryPotterBooks(),/Harry Potter audiobook folder was not found/);
});

test('server URL accepts HTTPS and rejects insecure remote origins', () => {
  assert.equal(normalizeServerUrl('https://jellyfin.example.test/'), 'https://jellyfin.example.test');
  assert.throws(() => normalizeServerUrl('http://jellyfin.example.test'), /HTTPS/);
  assert.throws(() => normalizeServerUrl('javascript:alert(1)'), /HTTP/);
  assert.throws(() => normalizeServerUrl('https://jellyfin.example.test/subpath'), /base path/);
  assert.throws(() => buildApiUrl('https://jellyfin.example.test', '//evil.example.test/path'), /configured server/);
});

test('MediaBrowser authorization uses the header and quotes values safely', () => {
  const header = buildMediaBrowserHeader({
    client: 'Caster', device: 'Chrome', deviceId: 'device-1', version: '0.1',
    userId: 'user-1', token: 'secret-token',
  });
  assert.match(header, /^MediaBrowser /);
  assert.match(header, /Token="secret-token"/);
  assert.match(header, /UserId="user-1"/);
  assert.doesNotMatch(header, /\n|\r/);
});

test('API URLs encode query parameters and never append authentication', () => {
  const url = buildApiUrl('https://jellyfin.example.test', '/Users/u/Items', {
    ParentId: 'folder id', Recursive: false,
  });
  assert.equal(url, 'https://jellyfin.example.test/Users/u/Items?ParentId=folder+id&Recursive=false');
  assert.doesNotMatch(url, /token|api_key|secret/i);
});

test('library and Harry Potter root selection fail closed', () => {
  const views = [
    { Id: 'other', Name: 'Comics', Type: 'CollectionFolder' },
    { Id: 'books', Name: 'Audiobooks', Type: 'CollectionFolder', CollectionType: 'books' },
  ];
  assert.equal(findAudiobooksLibrary(views).Id, 'books');
  assert.equal(findAudiobooksLibrary([{ Id: 'x', Name: 'Audiobooks', Type: 'UserView' }]), null);
  const folders = [
    { Id: 'hp', Name: 'J K Rowling - Harry Potter 1-7 Unabridged Audiobooks Narrated by Stephen Fry', Type: 'Folder' },
    { Id: 'other', Name: 'Harry Potter documentaries', Type: 'Folder' },
  ];
  assert.equal(findHarryPotterFolder(folders).Id, 'hp');
  assert.equal(findHarryPotterFolder([{ Id: 'other', Name: 'Harry Potter documentaries', Type: 'Folder' }]), null);
});

test('book-folder filter accepts only the numbered seven-book folder pattern', () => {
  for (let n = 1; n <= 7; n++) assert.equal(isHarryPotterBookFolder(`${n} HARRY POTTER AND A TITLE`), true);
  assert.equal(isHarryPotterBookFolder('8 HARRY POTTER FANFICTION'), false);
  assert.equal(isHarryPotterBookFolder('HARRY POTTER documentary'), false);
});

test('chapter normalization sorts by filename chapter number, not unreliable index tags', () => {
  const book = '1 HARRY POTTER AND THE PHILOSOPHER\'S STONE';
  const rows = [
    { Id: 'c2', Name: 'SECOND', Type: 'AudioBook', Path: `/library/${book}/CH02 SECOND.mp3`, IndexNumber: 1 },
    { Id: 'foreign', Name: 'OTHER', Type: 'AudioBook', Path: '/library/Other/CH01 OTHER.mp3' },
    { Id: 'bad', Name: 'NOT A CHAPTER', Type: 'AudioBook', Path: `/library/${book}/cover.jpg` },
    { Id: 'c1', Name: 'FIRST', Type: 'AudioBook', Path: `/library/${book}/CH01 FIRST.mp3`, IndexNumber: 99 },
    { Id: 'folder', Name: book, Type: 'Folder', Path: `/library/${book}` },
  ];
  const result = normalizeChapters(rows, book);
  assert.deepEqual(result.chapters.map(c => c.id), ['c1', 'c2']);
  assert.deepEqual(result.missingChapterNumbers, []);
});

test('chapter normalization flags missing and duplicate chapter numbers', () => {
  const book = '7 HARRY POTTER AND THE DEATHLY HALLOWS';
  const result = normalizeChapters([
    { Id: 'one', Name: 'ONE', Type: 'AudioBook', Path: `/library/${book}/CH01 ONE.mp3` },
    { Id: 'one-duplicate', Name: 'ONE COPY', Type: 'AudioBook', Path: `/library/${book}/CH01 COPY.mp3` },
    { Id: 'three', Name: 'THREE', Type: 'AudioBook', Path: `/library/${book}/CH03 THREE.mp3` },
  ], book);
  assert.deepEqual(result.chapters.map(c => c.id).sort(), ['one', 'one-duplicate', 'three']);
  assert.deepEqual(result.duplicateChapterNumbers, [1]);
  assert.deepEqual(result.missingChapterNumbers, [2]);
});

test('next chapter stays sequential and refuses to jump a gap', () => {
  const chapters = [{ id:'c1', chapterNumber:1 }, { id:'c2', chapterNumber:2 }, { id:'c5', chapterNumber:5 }];
  assert.equal(nextChapter(chapters, 'c1').id, 'c2');
  assert.equal(nextChapter(chapters, 'c2'), null);
  assert.equal(nextChapter(chapters, 'c5'), null);
  assert.equal(nextChapter(chapters, 'other'), null);
});

test('Jellyfin ticks convert to and from seconds without precision loss', () => {
  assert.equal(ticksToSeconds(9_400_000_000), 940);
  assert.equal(secondsToTicks(940), 9_400_000_000);
  assert.equal(ticksToSeconds(0), 0);
  assert.equal(ticksToSeconds(null), null);
});

test('stream URLs are token-free and identify the requested item/source', () => {
  const url = buildStreamUrl('https://jellyfin.example.test', 'item-1', 'source-1');
  assert.equal(url, 'https://jellyfin.example.test/Audio/item-1/stream?static=true&mediaSourceId=source-1');
  assert.doesNotMatch(url, /token|api_key|secret/i);
});

test('playback report requires a real session and omits unusable positions', () => {
  assert.throws(() => buildPlaybackReport({ itemId: 'item-1', mediaSourceId: 'source-1', positionSeconds: 2, isPaused: true }), /PlaySessionId/);
  const report = buildPlaybackReport({
    itemId: 'item-1', mediaSourceId: 'source-1', playSessionId: 'session-1',
    positionSeconds: 12.5, isPaused: true,
  });
  assert.equal(report.ItemId, 'item-1');
  assert.equal(report.PlaySessionId, 'session-1');
  assert.equal(report.PositionTicks, 125_000_000);
  assert.equal(report.IsPaused, true);
  assert.equal(buildPlaybackReport({
    itemId: 'item-1', mediaSourceId: 'source-1', playSessionId: 'session-1',
    positionSeconds: null, isPaused: true,
  }).PositionTicks, undefined);
});
