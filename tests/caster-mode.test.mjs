import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { script, source as executable, html, bootCaster, flushChains } from './harness.mjs';
import { genericNormalizeChapters } from '../jellyfin.mjs';

const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
assert.match(manifest.name,/podcasts and audiobooks/);
assert.match(manifest.description,/Jellyfin audiobooks/);
assert.ok(script, 'index.html has an inline module application script');
const duplicateDefinitions = name => (executable.match(new RegExp(`function ${name}\\(`,'g')) || []).length;
assert.equal(duplicateDefinitions('pause'),1,'player handlers have one authoritative definition');
assert.equal(duplicateDefinitions('togglePlay'),1,'player handlers have one authoritative definition');
assert.equal(duplicateDefinitions('skipCurrent'),1,'player handlers have one authoritative definition');
assert.doesNotMatch(executable,/sessionStorage|accessToken.*(?:localStorage|sessionStorage)/);

test('podcast flow retains random next and shuffle-all behavior', async () => {
  const {context} = bootCaster();
  const result = vm.runInContext(`(() => {
    window.MediaMetadata = class { constructor(values){ Object.assign(this, values); } };
    const show={id:'s',episodes:[{guid:'a',url:'a.mp3'},{guid:'b',url:'b.mp3'}]};
    state.shows=[show];
    currentShowId='s'; currentGuid='a';
    pickEpisode=()=>show.episodes[1];
    next();
    return {guid:currentGuid, mode:playerMode};
  })()`, context);
  assert.equal(result.guid, 'b');
  assert.equal(result.mode, 'podcast');
  // playEpisode is async (cache check) — flush microtasks then check src
  await new Promise(r => setImmediate(r));
  const url = vm.runInContext('audio.src', context);
  assert.equal(url, 'b.mp3');
});

test('audiobook chapters advance sequentially without calling podcast selection', async () => {
  const {context} = bootCaster();
  vm.runInContext(`(() => {
    window.MediaMetadata = class { constructor(values){ Object.assign(this, values); } };
    audiobookClient={
      reportStopped:async()=>{},
      getPlaybackInfo:async ch=>({PlaySessionId:'session-'+ch.id,MediaSources:[{Id:'source-'+ch.id}]}),
      reportStarted:async()=>{},reportProgress:async()=>{},
    };
    audiobookUser={Id:'user'};
    audiobookBooks=[{id:'book',title:'Harry Potter 1',missingChapterNumbers:[],duplicateChapterNumbers:[],chapters:[
      {id:'ch1',title:'one',chapterNumber:1,positionTicks:0,mediaSourceId:'src1'},
      {id:'ch2',title:'two',chapterNumber:2,positionTicks:0,mediaSourceId:'src2'},
    ]}];
    audiobookActiveBookId='book';audiobookActiveChapterId='ch1';playerMode='audiobook';
    currentShowId=null;currentGuid=null;
    pickEpisode=()=>{throw new Error('podcast shuffle called from audiobook mode')};
    nextAudiobookChapter();
  })()`, context);
  await vm.runInContext('Promise.resolve(audiobookReportChain)',context);
  const result=vm.runInContext('({mode:playerMode,book:audiobookActiveBookId,chapter:audiobookActiveChapterId,src:audio.src})',context);
  assert.equal(result.mode,'audiobook');
  assert.equal(result.book,'book');
  assert.equal(result.chapter,'ch2');
  assert.match(result.src,/Audio\/ch2/);
});

test('the saved Jellyfin token stays in its own key — never in state, source or the log', () => {
  // This used to claim "tokens are never written to browser storage" with a regex that could
  // not fail: the write site has `localStorage.setItem(` on one line and `accessToken:` on the
  // next, and `.` does not cross a newline. The persistence is deliberate; these are the
  // invariants that actually hold and are actually worth failing on.
  assert.match(script,/localStorage\.setItem\(JELLYFIN_TOKEN_KEY/,
    'session durability is deliberate — a reload must not demand the password again');
  assert.doesNotMatch(script,/setItem\([^)]*password/i, 'the password is never stored');
  assert.doesNotMatch(script,/state\.[A-Za-z_.]*[Tt]oken/,
    'the token must not ride along inside app state, which is rewritten on a hot path');
  assert.doesNotMatch(script,/diag\([^)]*accessToken/, 'the token must never reach the diagnostics log');
});

test('Jellyfin server address is supplied at sign-in, not published as a personal default', () => {
  assert.match(script,/const JELLYFIN_DEFAULT_SERVER = ''/);
  assert.match(script,/id="jfServer"/);
  assert.match(script,/connectJellyfin\(server,user,password\)/);
});

test('an invalid server URL is shown in the form without sending a request', async () => {
  const {context}=bootCaster();
  context.JellyfinClient={authenticate:async()=>{throw new Error('must not authenticate')}};
  const result=vm.runInContext(`(()=>{
    let sent=0;
    JellyfinClient.authenticate=async()=>{sent++;throw new Error('must not authenticate')};
    return connectJellyfin('not a url','test','')
      .then(()=>({sent,error:audiobookError}))
      .catch(()=>({sent,error:audiobookError}));
  })()`,context);
  const value=await result;
  assert.equal(value.sent,0);
  assert.match(value.error,/valid HTTP\(S\) URL/);
});

test('blank Jellyfin credentials are reported before a request', async () => {
  const {context}=bootCaster();
  const fetchCalls=[];
  context.fetch=async(...args)=>{fetchCalls.push(args);throw new Error('must not fetch')};
  const value=await vm.runInContext(`connectJellyfin('https://jellyfin.example.test','   ','password').catch(()=>audiobookError)`,context);
  assert.equal(fetchCalls.length,0);
  assert.match(value,/Enter your Jellyfin username/);
});

test('starting a chapter writes a pointer bookmark, never a cached Jellyfin position', async () => {
  // The old version asserted that a key nothing ever writes is absent, so it could not fail.
  const {store} = await playingChapter();
  const bookmark = JSON.parse(store.get('caster.jellyfin.resume'));
  assert.equal(bookmark.bookId, 'b1', 'the bookmark points at the book');
  assert.equal(bookmark.chapterId, 'b1-ch1', 'and at the chapter being played');
  assert.equal('positionTicks' in bookmark, false,
    'a pointer, not a position cache — the server owns how far in you are');
});

test('chapter-end stops at final chapter and does not roll into the next book', async () => {
  const {context}=bootCaster();
  const result=vm.runInContext(`(()=>{
    window.MediaMetadata=class{constructor(values){Object.assign(this,values)}};
    audiobookClient={reportStopped:async()=>{}};
    audiobookUser={Id:'alice'};
    audiobookBooks=[
      {id:'b1',title:'Book 1',missingChapterNumbers:[],duplicateChapterNumbers:[],chapters:[{id:'last',title:'last',chapterNumber:17,positionTicks:0}]},
      {id:'b2',title:'Book 2',missingChapterNumbers:[],duplicateChapterNumbers:[],chapters:[{id:'next-book-first',title:'first',chapterNumber:1,positionTicks:0}]},
    ];
    audiobookActiveBookId='b1';audiobookActiveChapterId='last';audiobookSession={playSessionId:'real-session',mediaSourceId:'source'};
    playerMode='audiobook';audio.currentTime=15;audio.paused=false;
    nextAudiobookChapter();
    return Promise.resolve(audiobookReportChain).then(()=>({book:audiobookActiveBookId,chapter:audiobookActiveChapterId,paused:audio.paused}));
  })()`,context);
  const state=await result;
  assert.equal(state.book,'b1');
  assert.equal(state.chapter,'last');
  assert.equal(state.paused,true);
});

test('resume selection requires a real Jellyfin in-progress position', () => {
  const {context}=bootCaster();
  const result=vm.runInContext(`(()=>{
    audiobookBooks=[{id:'b',chapters:[
      {id:'played',played:true,positionTicks:0,lastPlayedDate:'2026-10-06'},
      {id:'unplayed',played:false,positionTicks:0,lastPlayedDate:''},
    ]}];
    return audiobookResumeTarget(audiobookBooks[0]);
  })()`,context);
  assert.equal(result,null);
});

test('resume position becomes the selected player seek target', async () => {
  const {context}=bootCaster();
  vm.runInContext(`(()=>{
    window.MediaMetadata=class{constructor(values){Object.assign(this,values)}};
    audiobookClient={getPlaybackInfo:async()=>({PlaySessionId:'s',MediaSources:[{Id:'source'}]}),reportStarted:async()=>{},reportProgress:async()=>{}};
    audiobookUser={Id:'alice'};audio.duration=2000;
    audiobookBooks=[{id:'b',title:'Book',missingChapterNumbers:[],duplicateChapterNumbers:[],chapters:[{id:'ch',title:'chapter',chapterNumber:1,positionTicks:7400000000,runTimeTicks:20000000000,mediaSourceId:'source',played:false,container:'mp3'}]}];
    resumeAudiobook('b');
  })()`,context);
  await vm.runInContext('Promise.resolve(audiobookReportChain)',context);
  const seek=vm.runInContext('audio.currentTime',context);
  assert.equal(seek,740);
});

test('progress report writes only when actual session IDs exist', async () => {
  const {context}=bootCaster();
  const result=vm.runInContext(`(()=>{
    const sent=[];
    audiobookClient={reportProgress:async(...args)=>sent.push(args)};
    audiobookBooks=[{id:'b',chapters:[{id:'ch',chapterNumber:1}]}];
    audiobookActiveBookId='b';audiobookActiveChapterId='ch';
    audiobookSession=null;
    const before=queueAudiobookReport('progress',44,true);
    audiobookSession={playSessionId:'real',mediaSourceId:'source'};
    const after=queueAudiobookReport('progress',44,true);
    return Promise.all([before,after]).then(([beforeResult])=>({beforeResult,sent:sent.length}));
  })()`,context);
  const value=await result;
  assert.equal(value.beforeResult,false);
  assert.equal(value.sent,1);
});

test('chapter reports include duration-derived bounds', async () => {
  const {context}=bootCaster();
  const result=vm.runInContext(`(()=>{
    window.MediaMetadata=class{constructor(values){Object.assign(this,values)}};
    audiobookClient={getPlaybackInfo:async()=>({PlaySessionId:'s',MediaSources:[{Id:'source'}]}),reportStarted:async()=>{},reportProgress:async()=>{}};
    audiobookUser={Id:'alice'};audio.duration=2000;
    audiobookBooks=[{id:'b',title:'Book',missingChapterNumbers:[],duplicateChapterNumbers:[],chapters:[{id:'ch',title:'chapter',chapterNumber:1,positionTicks:7400000000,runTimeTicks:20000000000,mediaSourceId:'source',played:false,container:'mp3'}]}];
    resumeAudiobook('b');
    return Promise.resolve(audiobookReportChain).then(()=>audio.currentTime);
  })()`,context);
  assert.equal(await result,740);
});

 test('missing audio time never triggers a zero-position progress report', async () => {
  const {context}=bootCaster();
  const result=vm.runInContext(`(()=>{
    const sent=[];
    audiobookClient={reportProgress:async(...args)=>sent.push(args)};
    audiobookBooks=[{id:'b',chapters:[{id:'ch',chapterNumber:1}]}];
    audiobookActiveBookId='b';audiobookActiveChapterId='ch';
    audiobookSession={playSessionId:'real',mediaSourceId:'source'};
    queueAudiobookReport('progress',null,true);
    return Promise.resolve(audiobookReportChain).then(()=>sent.length);
  })()`,context);
  assert.equal(await result,0);
});

test('navigating to the library root retains what is playing', async () => {
  const {context}=bootCaster();
  const result=vm.runInContext(`(()=>{
    audiobookUser={Id:'alice'};playerMode='audiobook';
    audiobookActiveBookId='b';audiobookActiveChapterId='ch';
    audiobookBooks=[{id:'b',title:'Book',missingChapterNumbers:[],duplicateChapterNumbers:[],chapters:[{id:'ch',chapterNumber:1,positionTicks:0,title:'one'}]}];
    audiobookClient={
      getAudiobooksCatalogue:async()=>({libraryId:'lib'}),
      getFolderItems:async()=>({Items:[{Id:'b',Name:'Book',Type:'Folder'}]}),
    };
    return navigateAudiobooksToRoot().then(()=>({book:audiobookActiveBookId,chapter:audiobookActiveChapterId}));
  })()`,context);
  const value=await result;
  assert.equal(value.book,'b');assert.equal(value.chapter,'ch');
});

test('pause and togglePlay definitions are not duplicated', () => {
  assert.equal((script.match(/function pause\(/g)||[]).length,1);
  assert.equal((script.match(/function togglePlay\(/g)||[]).length,1);
  assert.equal((script.match(/function skipCurrent\(/g)||[]).length,1);
});

/* ---- chapter auto-advance: the overnight regression (see ISA F3) ---- */

const CASTER_CLIENT = `{
  reportStopped:async()=>{}, reportStarted:async()=>{}, reportProgress:async()=>{},
  getPlaybackInfo:async ch=>({PlaySessionId:'s-'+ch.id,MediaSources:[{Id:ch.id||'src'}]}),
  getAudiobooksCatalogue:async()=>({libraryId:'lib'}),
  getFolderItems:async()=>({Items:[{Id:'f1',Name:'Series Folder',Type:'Folder'}]}),
}`;

test('a playback progress report never mutates browse navigation', async () => {
  const {context}=bootCaster();
  const value=await vm.runInContext(`(()=>{
    audiobookClient=${CASTER_CLIENT};
    audiobookUser={Id:'u'}; audiobookBooks=[];
    audiobooksNav=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0},{id:'c2',title:'two',chapterNumber:2,positionTicks:0}];
    audiobooksNavTitle='A Book Title';
    audiobooksNavBack=[{title:'Audiobooks',parentId:null}];
    audiobooksNavParentId='folder';
    audiobookActiveBookId='bryson'; audiobookActiveChapterId='c1';
    audiobookActiveChapter=audiobooksNav[0]; audiobookActiveChapterList=audiobooksNav;
    playerMode='audiobook';
    audiobookSession={playSessionId:'s',mediaSourceId:'c1'};
    audio.paused=false; audio.currentTime=120;
    const snap=()=>JSON.stringify({nav:audiobooksNav,title:audiobooksNavTitle,back:audiobooksNavBack,parent:audiobooksNavParentId});
    const before=snap();
    return queueAudiobookReport('progress',120,false)
      .then(()=>Promise.resolve(audiobookReportChain))
      .then(()=>({before,after:snap(),chapter:currentAudiobookChapter()&&currentAudiobookChapter().id}));
  })()`,context);
  assert.equal(value.after,value.before,'progress reporting must not touch audiobooksNav*');
  assert.equal(value.chapter,'c1','the active chapter must survive the report');
});

test('chapter resolution survives the browse view being replaced', async () => {
  const {context}=bootCaster();
  const value=vm.runInContext(`(()=>{
    audiobookClient=${CASTER_CLIENT};
    audiobookUser={Id:'u'}; audiobookBooks=[];
    const chapters=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0},{id:'c2',title:'two',chapterNumber:2,positionTicks:0}];
    audiobooksNav=chapters; audiobooksNavTitle='A Book Title';
    audiobookActiveBookId='bryson'; audiobookActiveChapterId='c1';
    adoptAudiobookChapter('bryson',chapters[0]);
    playerMode='audiobook'; currentShowId=null; currentGuid=null;
    // the reader backs out to the folder list mid-listen
    audiobooksNav=[{id:'f1',name:'Series Folder',type:'Folder'}];
    audiobooksNavTitle='Audiobooks'; audiobooksNavBack=[];
    return {
      chapter: currentAudiobookChapter() && currentAudiobookChapter().id,
      list: getCurrentChapters().map(c=>c.id),
      current: current() && current().id,
      show: currentShow() && currentShow().title,
    };
  })()`,context);
  assert.equal(value.chapter,'c1');
  assert.equal(value.list.join(','),'c1,c2');
  assert.equal(value.current,'c1','the player bar must keep showing the playing chapter');
  assert.equal(value.show,'A Book Title');
});

test('chapter end advances and plays the next chapter with no tap, after a progress report', async () => {
  const {context}=bootCaster();
  await vm.runInContext(`(()=>{
    window.MediaMetadata=class{constructor(v){Object.assign(this,v)}};
    audiobookClient=${CASTER_CLIENT};
    audiobookUser={Id:'u'}; audiobookBooks=[];
    audiobooksNav=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0},{id:'c2',title:'two',chapterNumber:2,positionTicks:0}];
    audiobooksNavTitle='A Book Title';
    audiobookActiveBookId='bryson'; audiobookActiveChapterId='c1';
    playerMode='audiobook'; currentShowId=null; currentGuid=null;
    audiobookSession={playSessionId:'s',mediaSourceId:'c1'};
    audio.paused=true; audio.currentTime=0; audio.playCalls=0;
    return queueAudiobookReport('progress',10,false);
  })()`,context);
  await flushChains(context);
  await vm.runInContext('audio.paused=true; audio.ended=true; next()',context);
  await flushChains(context);
  const state=vm.runInContext('({chapter:audiobookActiveChapterId,src:audio.src,plays:audio.playCalls})',context);
  assert.equal(state.chapter,'c2','ended must advance to the next chapter');
  assert.match(state.src,/Audio\/c2/);
  assert.ok(state.plays>=1,'audio.play() must be called without further user input');
});

test('a hung PlaybackInfo cannot stop the chapter from starting', async () => {
  const {context}=bootCaster();
  vm.runInContext(`(()=>{
    window.MediaMetadata=class{constructor(v){Object.assign(this,v)}};
    audiobookClient={ getPlaybackInfo:()=>new Promise(()=>{}) };
    audiobookUser={Id:'u'}; audiobookBooks=[];
    audiobooksNav=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0}];
    audiobooksNavTitle='A Book Title';
    playerMode='audiobook'; currentShowId=null; currentGuid=null;
    audio.playCalls=0;
    playAudiobook('bryson','c1',{positionTicks:0,autoplay:true});
  })()`,context);
  await new Promise(r=>setImmediate(r));
  await new Promise(r=>setImmediate(r));
  const plays=vm.runInContext('audio.playCalls',context);
  assert.ok(plays>=1,'playback must start before any awaited Jellyfin round-trip');
});

// Scope: literal specifiers in the app shell. Dynamic fetches (search, artwork) and
// manifest.webmanifest are not versioned by design — they are not shell assets.
test('every literal module import and bundled fetch in the shell is cache-busted', () => {
  const specs=[...script.matchAll(/from '([^']+)'|fetch\('([^']+)'\)/g)].map(m=>m[1]||m[2]);
  assert.ok(specs.some(s=>s.startsWith('./jellyfin.mjs')),'jellyfin.mjs is imported');
  assert.ok(specs.some(s=>s.startsWith('./sleep.mjs')),'sleep.mjs is imported');
  assert.ok(specs.some(s=>s.startsWith('feeds.json')),'feeds.json is fetched');
  // all three must agree on one version (the rule), and never fall behind the floor
  const versions = specs.map(s => (s.match(/\?v=(\d+)$/) || [])[1]);
  assert.ok(versions.every(v => v), `every shell specifier needs a cache-bust: ${specs.join(', ')}`);
  assert.equal(new Set(versions).size, 1, `all three specifiers must agree on one version, got ${versions.join(',')}`);
  assert.ok(Number(versions[0]) >= 3, `version must be at least 3 (pre-cache-bust), got ${versions[0]}`);
});

/* ---- harness invariant: a module export the vm can't see makes a whole
   code path throw inside the app's own try/catch, so tests pass while the
   path is untestable. Catch that structurally, once. ---- */
test('the vm harness injects every export that index.html imports', () => {
  const imported=[...script.matchAll(/^import\s*\{([^}]+)\}\s*from/gm)]
    .flatMap(m=>m[1].split(','))
    .map(s=>s.trim())
    .filter(Boolean);
  assert.ok(imported.length>=2,'index.html imports its modules');
  const {context}=bootCaster();
  for(const name of imported){
    assert.ok(name in context,
      `${name} is imported by index.html but not injected into the vm context — every path using it would throw and be swallowed`);
  }
});

/* ---- second-look findings 1/3/4: browse must never decide playback ---- */

test('browsing into another folder while listening never changes what is playing', async () => {
  const {context}=bootCaster();
  const value=await vm.runInContext(`(async()=>{
    const sent=[];
    audiobookClient={
      reportStopped:async()=>{}, reportStarted:async()=>{},
      reportProgress:async(ch)=>sent.push(ch.id),
      getPlaybackInfo:async ch=>({PlaySessionId:'s-'+ch.id,MediaSources:[{Id:ch.id}]}),
      getAudiobooksCatalogue:async()=>({libraryId:'lib'}),
      getFolderItems:async(id)=> id==='book-b'
        ? {Items:[{Type:'AudioBook',Id:'c9',Name:'CH09 nine',Path:'/Book B/CH09.mp3',RunTimeTicks:1e10,UserData:{}}]}
        : {Items:[{Id:'f1',Name:'Series Folder',Type:'Folder'}]},
    };
    audiobookUser={Id:'u'}; audiobookBooks=[];
    const chapters=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0},{id:'c2',title:'two',chapterNumber:2,positionTicks:0}];
    audiobooksNav=chapters; audiobooksNavTitle='Book A'; audiobooksNavParentId='book-a';
    adoptAudiobookChapter('book-a', chapters[0]);
    playerMode='audiobook'; currentShowId=null; currentGuid=null;
    audiobookLibraryState='ready'; audiobooksNavBack=[{title:'Audiobooks',parentId:null}];
    audiobookSession={playSessionId:'s',mediaSourceId:'c1'};
    audio.paused=false; audio.currentTime=300;
    // the reader backs out and opens a DIFFERENT book's folder mid-listen
    await navigateAudiobooksToFolder('book-b','Book B');
    const snapshot={book:audiobookActiveBookId,chapter:audiobookActiveChapterId,
                    current:current()&&current().id,browse:audiobooksNavParentId};
    await queueAudiobookReport('progress',300,false);
    await Promise.resolve(audiobookReportChain);
    return {snapshot,book:audiobookActiveBookId,chapter:audiobookActiveChapterId,
            list:getCurrentChapters().map(c=>c.id),reported:sent};
  })()`,context);
  assert.equal(value.snapshot.book,'book-a','opening a folder must not rewrite the active book');
  assert.equal(value.snapshot.chapter,'c1','opening a folder must not rewrite the active chapter');
  assert.equal(value.snapshot.current,'c1','the player bar keeps showing what is playing');
  assert.equal(value.snapshot.browse,'book-b','the browse target must still move to the opened folder');
  assert.equal(value.book,'book-a');
  assert.equal(value.chapter,'c1');
  assert.equal(value.list.join(','),'c1,c2','the held chapter list belongs to the book being played');
  assert.equal(value.reported.join(','),'c1','progress must be reported against the playing chapter');
});

test('going back to a chapter list while listening never changes what is playing', async () => {
  const {context}=bootCaster();
  const value=await vm.runInContext(`(async()=>{
    audiobookClient={
      reportStopped:async()=>{}, reportStarted:async()=>{}, reportProgress:async()=>{},
      getPlaybackInfo:async ch=>({PlaySessionId:'s-'+ch.id,MediaSources:[{Id:ch.id}]}),
      getAudiobooksCatalogue:async()=>({libraryId:'lib'}),
      getFolderItems:async(id)=> ({Items:[{Type:'AudioBook',Id:'c7',Name:'CH07 seven',Path:'/Book C/CH07.mp3',RunTimeTicks:1e10,UserData:{}}]}),
    };
    audiobookUser={Id:'u'}; audiobookBooks=[];
    const chapters=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0},{id:'c2',title:'two',chapterNumber:2,positionTicks:0}];
    audiobooksNav=chapters; audiobooksNavTitle='Book A'; audiobooksNavParentId='book-a';
    adoptAudiobookChapter('book-a', chapters[0]);
    playerMode='audiobook'; currentShowId=null; currentGuid=null;
    audiobookLibraryState='ready';
    // the reader backed out to the folder list, and the back-stack now restores Book C
    audiobooksNav=[{id:'f1',name:'Series Folder',type:'Folder'}];
    audiobooksNavTitle='Audiobooks'; audiobooksNavParentId=null;
    audiobooksNavBack=[{title:'Book C', parentId:'book-c'}];
    await navigateAudiobookBack();
    return {book:audiobookActiveBookId,chapter:audiobookActiveChapterId,
            current:current()&&current().id,browse:audiobooksNavParentId,
            list:getCurrentChapters().map(c=>c.id)};
  })()`,context);
  assert.equal(value.book,'book-a','restoring a chapter list must not rewrite the active book');
  assert.equal(value.chapter,'c1','restoring a chapter list must not rewrite the active chapter');
  assert.equal(value.current,'c1');
  assert.equal(value.browse,'book-c','the browse target must still follow the back stack');
  assert.equal(value.list.join(','),'c1,c2');
});

test('the chapter served for playback comes from the browse list, not a stale copy', () => {
  const {context}=bootCaster();
  const value=vm.runInContext(`(()=>{
    audiobookClient=${CASTER_CLIENT};
    audiobookUser={Id:'u'}; audiobookBooks=[];
    const stale=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0}];
    audiobooksNav=stale; audiobooksNavTitle='Book A';
    adoptAudiobookChapter('book-a', stale[0]);
    playerMode='audiobook';
    // the list is refetched from the server: same id, fresher position
    audiobooksNav=[{id:'c1',title:'one',chapterNumber:1,positionTicks:5000000000}];
    const served=currentAudiobookChapter();
    return {ticks:served.positionTicks, isFresh:served===audiobooksNav[0]};
  })()`,context);
  assert.equal(value.ticks,5000000000,'a newer server position must win over the copy captured at playback start');
  assert.equal(value.isFresh,true);
});

test('leaving audiobook mode clears every piece of held playback state', () => {
  const {context}=bootCaster();
  const value=vm.runInContext(`(()=>{
    audiobookUser={Id:'u'}; audiobookBooks=[];
    const chapters=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0}];
    audiobooksNav=chapters; audiobooksNavTitle='Book A';
    adoptAudiobookChapter('book-a', chapters[0]);
    playerMode='audiobook';
    adoptAudiobookChapter(null, null);
    return {book:audiobookActiveBookId,chapter:audiobookActiveChapterId,
            held:!!audiobookActiveChapter,list:audiobookActiveChapterList,
            title:audiobookActiveBookTitle,resolves:currentAudiobookChapter()};
  })()`,context);
  assert.equal(value.book,null);
  assert.equal(value.chapter,null);
  assert.equal(value.held,false,'the held chapter must not survive the mode switch');
  assert.equal(value.list,null);
  assert.equal(value.title,'');
  assert.equal(value.resolves,null);
});

test('a hung PlaybackInfo surfaces a visible error without stopping playback', async () => {
  const {context, elements} = bootCaster();
  vm.runInContext(`(()=>{
    window.MediaMetadata=class{constructor(v){Object.assign(this,v)}};
    // fire ONLY the session timeout (8000ms); every other app timer stays inert
    setTimeout = (fn, ms) => { if(ms === 8000) fn(); return 0; };
    audiobookClient={ getPlaybackInfo:()=>new Promise(()=>{}) };
    audiobookUser={Id:'u'}; audiobookBooks=[];
    audiobooksNav=[{id:'c1',title:'one',chapterNumber:1,positionTicks:0}];
    audiobooksNavTitle='A Book Title';
    playerMode='audiobook'; currentShowId=null; currentGuid=null;
    audio.playCalls=0;
    playAudiobook('bryson','c1',{positionTicks:0,autoplay:true});
  })()`,context);
  await flushChains(context);
  const state=vm.runInContext('({err:audiobookError,plays:audio.playCalls,session:!!audiobookSession})',context);
  assert.match(state.err, /Jellyfin did not respond/,
    'a session that never settles must say so instead of failing silently');
  assert.match(state.err, /won't be saved/);
  assert.ok(state.plays>=1,'playback must still start');
  assert.equal(state.session,false);
  vm.runInContext('renderOverlay()',context);
  assert.equal(elements.get('ovError').textContent, state.err,
    'the player itself must show the error, not only the list view');
  assert.equal(elements.get('ovError').style.display, '');
});

test('the audiobook screen states its build, server host and session state', () => {
  const {context} = bootCaster();
  const html = vm.runInContext(`(()=>{
    audiobookUser={Id:'u',Name:'Justin'};
    audiobookClient={};
    playerMode='audiobook';
    audiobookServerUrl='https://jellyfin.example.test';
    audiobookLibraryState='ready'; audiobooksNavBack=[];
    audiobooksNav=[{id:'f1',name:'Series Folder',type:'Folder'}];
    audiobooksNavTitle='Audiobooks';
    audiobookSession=null; audiobookError=''; audiobookSessionState='';
    renderAll();
    return document.querySelector('#view').innerHTML;
  })()`,context);
  assert.match(html, /id="abDiag"/, 'the diagnostic line must render on the audiobook screen');
  assert.match(html, /build \d{4}-\d{2}-\d{2}/, 'the build stamp must be readable off the screen');
  assert.match(html, /jellyfin\.example\.test/, 'the connected server host must be readable');
  assert.match(html, /idle/, 'an untouched player must read as idle, not as a session');
  assert.doesNotMatch(html, /session ok/, 'idle must not read as healthy');

  const withSession = vm.runInContext(`(()=>{
    audiobookSession={playSessionId:'s',mediaSourceId:'m'}; audiobookError='';
    audiobookSessionState='ok';
    playerMode='audiobook'; renderAll();
    return document.querySelector('#view').innerHTML;
  })()`,context);
  assert.match(withSession, /session ok/, 'a healthy session must read as healthy');

  // a failure must survive navigation clearing audiobookError — that is the whole point
  const afterFailure = vm.runInContext(`(()=>{
    audiobookSession=null; audiobookError='';          // navigation wiped the error
    audiobookSessionState='failed: Jellyfin did not respond';
    playerMode='audiobook'; renderAll();
    return document.querySelector('#view').innerHTML;
  })()`,context);
  assert.match(afterFailure, /failed: Jellyfin did not respond/,
    'the sticky session state must still name the failure after navigation clears the banner');
});

test('chapter rows and the resume button bind to the folder being browsed', () => {
  assert.match(script,/playAudiobook\(audiobooksNavParentId, el\.dataset\.chapter/,
    'a tapped chapter row must start the book whose folder is open, not whatever is playing');
  assert.match(script,/playAudiobook\(audiobooksNavParentId, resume\.chapter\.id/,
    'the resume button must start the book whose folder is open');
  assert.doesNotMatch(script,/playAudiobook\(audiobookActiveBookId, el\.dataset\.chapter/,
    'row clicks must not resolve the book through playback state');
});

// Fixtures for the session/diagnostics tests. The harness records listeners and timers, so
// element events, window events and timers can all be driven (dispatchEvent, fireWindow,
// fireTimeout, fireInterval); these helpers exist to drive the session function directly
// where booting a whole chapter would only add noise.
const ticksFromDuration = (duration) => {
  const [h, m, sec] = duration.split(':').map(Number);
  return ((h * 3600) + (m * 60) + sec) * 1e7;
};
const audioItem = (index, duration = '00:10:00') => ({
  Id: `b1-ch${index}`, Name: `Chapter ${index}`, Type: 'AudioBook',
  RunTimeTicks: ticksFromDuration(duration),
});
const makeChapterContext = (context, chapters) => {
  context.__chapters = chapters; // the vm cannot see test-module scope, so hand it over
  vm.runInContext('var chapterList = __chapters;', context, {timeout:5000});
  vm.runInContext([
    "audiobooksNav = chapterList.slice();",
    "audiobooksNavTitle = 'a book'; audiobooksNavParentId = 'b1';",
    "audiobookBooks = [{id:'b1', title:'a book', chapters:chapterList}];",
    "audiobookActiveBookId = 'b1'; audiobookActiveBookTitle = 'a book';",
    "adoptAudiobookChapter('b1', chapterList[0]);",
  ].join(';'), context, {timeout:5000});
  return context;
};
const makeJellyfinClient = (chapters) => ({
  getPlaybackInfo: async () => ({
    PlaySessionId: 'play-1',
    MediaSources: [{ Id: chapters[0].mediaSourceId, Path: 'x.mp3', RunTimeTicks: chapters[0].runTimeTicks }],
  }),
  reportStarted: async () => {}, reportProgress: async () => {}, reportStopped: async () => {},
});
const chaptersOf = (name) => genericNormalizeChapters([audioItem(1), audioItem(2)], 'b1', name).chapters;

test('a session that fails once is retried and then reports, instead of staying dead', async () => {
  const {context} = bootCaster();
  vm.runInContext("audiobookUser={Id:'u',Name:'Justin'};", context);
  const chapters = chaptersOf('a book');
  const client = makeJellyfinClient(chapters);
  const reports = [];                       // the mock records what the app sends
  client.reportStarted = async (_c,_s,p) => reports.push({kind:'started',p});
  client.reportProgress = async (_c,_s,p) => reports.push({kind:'progress',p});
  client.reportStopped = async (_c,_s,p) => reports.push({kind:'stopped',p});
  let calls = 0;
  const real = client.getPlaybackInfo.bind(client);
  client.getPlaybackInfo = async (chapter) => {
    calls += 1;
    if(calls === 1) throw new Error('server said no');
    return real(chapter);
  };
  context.__client = client;
  makeChapterContext(context, chapters);
  vm.runInContext('audiobookClient=__client;', context, {timeout:5000});

  const first = await vm.runInContext(
    "ensureAudiobookSession(chapterList[0], audiobookPlaybackGeneration, 0)", context, {timeout:5000});
  assert.equal(first, false, 'the first attempt fails');
  assert.equal(calls, 1);
  assert.match(vm.runInContext('audiobookSessionState', context), /failed: server said no/);

  const second = await vm.runInContext(
    "ensureAudiobookSession(chapterList[0], audiobookPlaybackGeneration, 0)", context, {timeout:5000});
  await flushChains(context);
  assert.equal(second, true, 'the retry establishes a session');
  assert.equal(vm.runInContext('audiobookSession ? 1 : 0', context), 1);
  assert.equal(reports.filter(r => r.kind === 'started').length, 1,
    'once a session exists the started report goes out, so a late session still records history');
  assert.match(vm.runInContext("casterDiag.join(' | ')", context), /session attempt 2\/6/);
});

test('the retry is wired to the media clock and to the play button', () => {
  assert.match(executable, /now\(\) - lastPosSave > 10000 && !audio\.paused/,
    'progress must be gated on the media clock, not a timer chain');
  assert.match(executable, /ensureAudiobookSession\(chapter, audiobookPlaybackGeneration, audio\.currentTime\)/,
    'a chapter playing with no session must retry itself');
  assert.match(executable, /if\(!audiobookSession && ch\)\{ diag\('play without a session/,
    'pressing play on a loaded file must establish the session it never had');
});

test('the session retry gives up loudly rather than retrying forever', async () => {
  const {context} = bootCaster();
  vm.runInContext("audiobookUser={Id:'u',Name:'Justin'};", context);
  const chapters = chaptersOf('a book');
  const client = makeJellyfinClient(chapters);
  const reports = [];
  client.reportStarted = async () => reports.push('started');
  client.reportProgress = async () => reports.push('progress');
  client.reportStopped = async () => reports.push('stopped');
  client.getPlaybackInfo = async () => { throw new Error('always down'); };
  context.__client = client;
  makeChapterContext(context, chapters);
  vm.runInContext('audiobookClient=__client;', context, {timeout:5000});

  for(let i = 1; i <= 8; i++){
    const ok = await vm.runInContext(
      "ensureAudiobookSession(chapterList[0], audiobookPlaybackGeneration, 0)", context, {timeout:5000});
    await flushChains(context);
    if(i <= 6) assert.equal(ok, false, `attempt ${i} must fail`);
  }
  assert.match(vm.runInContext('audiobookSessionState', context), /gave up after 6 attempts/,
    'the readout must say how many attempts were made');
  assert.equal(reports.length, 0, 'no session, so nothing was reported');
});

test('the diagnostic log records the session lifecycle and is persisted and bounded', async () => {
  const {context, store} = bootCaster();
  vm.runInContext("audiobookUser={Id:'u',Name:'Justin'};", context);
  const chapters = chaptersOf('a book');
  context.__client = makeJellyfinClient(chapters);
  makeChapterContext(context, chapters);
  vm.runInContext('audiobookClient=__client;', context, {timeout:5000});
  await vm.runInContext(
    "ensureAudiobookSession(chapterList[0], audiobookPlaybackGeneration, 0)", context, {timeout:5000});
  await flushChains(context);

  const log = vm.runInContext("casterDiag.join(' | ')", context);
  assert.match(log, /session attempt 1\/6/);
  assert.match(log, /session ok/);

  vm.runInContext('diagFlush()', context);   // writes are batched; pagehide flushes in the app
  const stored = store.get('caster.diag.v1');
  assert.ok(stored, 'the log must survive a reload');
  const parsed = JSON.parse(stored);
  // The bound is the constant's, not a magic 150: the buffer was raised to cover a
  // whole night's listening (a swallowed window is the failure we are hunting).
  const max = Number((script.match(/CASTER_DIAG_MAX = (\d+)/) || [])[1]);
  assert.ok(max >= 150 && max <= 5000, `the log bound must be sane, got ${max}`);
  assert.ok(Array.isArray(parsed) && parsed.length <= max, 'the log must stay bounded');
});

/* ---- The 2026-10-16 night: a four-minute silent window could have been a stalled
   element, a frozen page or a pause, and the log could not say which, because nothing
   recorded the element's own state. These pin the signals that tell them apart. ---- */

test('the media element logs its own transitions, including where a seek came from', () => {
  const {context, elements} = bootCaster();
  const audio = elements.get('audio');
  const types = ['play','playing','pause','ended','waiting','stalled','suspend','abort','emptied',
    'error','loadedmetadata','loadeddata','durationchange','ratechange'];
  vm.runInContext('casterDiag.length = 0', context);
  types.forEach(type => audio.dispatchEvent({type}));
  vm.runInContext('mediaLastPos = 300; audio.currentTime = 620', context);
  audio.dispatchEvent({type:'seeking'});
  audio.dispatchEvent({type:'seeked'});

  const log = vm.runInContext("casterDiag.join(' | ')", context);
  types.forEach(type => assert.match(log, new RegExp(`media ${type} pos=`),
    `a ${type} on the element must be logged`));
  assert.match(log, /media seeking 300->620/,
    'a position jump must record where it came FROM — a backwards 340s jump was unexplainable');
  assert.match(log, /media seeked 300->620/);
});

test('a pause names its reason and a blocked play is recorded, not swallowed', async () => {
  const {context, elements} = bootCaster();
  const audio = elements.get('audio');
  vm.runInContext('casterDiag.length = 0; playerMode="audiobook"', context);
  vm.runInContext("pause('sleep')", context);
  assert.match(vm.runInContext("casterDiag.join(' | ')", context), /pause requested: sleep/,
    'the sleep timer firing and a tap-pause must not look identical in the log');

  audio.play = () => Promise.reject(new Error('not allowed'));
  vm.runInContext('togglePlay()', context);
  await new Promise(r => setImmediate(r));
  assert.match(vm.runInContext("casterDiag.join(' | ')", context), /play rejected \(toggle\): Error not allowed/,
    'a rejected play() used to vanish into an empty catch — the exact "chapter loaded, silence" report');
});

test('pagehide and visibility are recorded, with the position they happened at', () => {
  const {context, fireWindow} = bootCaster();
  vm.runInContext('casterDiag.length = 0', context);
  fireWindow('visibilitychange');
  fireWindow('pagehide');
  const log = vm.runInContext("casterDiag.join(' | ')", context);
  assert.match(log, /visibility /, 'a screen-off/on transition is the one event we could never see');
  assert.match(log, /pagehide pos=/, 'the position the page was hidden at is the baseline for the gap');
});

test('the heartbeat only speaks when nothing else has — the gap IS the signal', () => {
  const {context, fireInterval} = bootCaster();
  vm.runInContext('casterDiag.length = 0', context);
  fireInterval(30000);
  assert.equal(vm.runInContext("casterDiag.filter(l => l.indexOf(' hb ') >= 0).length", context), 0,
    'a live app must not pad its own log');
  vm.runInContext('lastDiagAt = Date.now() - 30000', context);
  fireInterval(30000);
  assert.ok(vm.runInContext("casterDiag.filter(l => l.indexOf(' hb ') >= 0).length", context) >= 1,
    'a log that has gone quiet must beat, so a frozen page reads as a gap rather than as nothing');
});

/* ---- The stream can die mid-chapter, and it did: 2026-10-17, `media error` 14m52s into
   THE CHAMBER OF SECRETS with nothing in the app reacting to it. These pin the reaction. ---- */

// Put the app in "a chapter is playing", which is the state every recovery path needs.
const playingChapter = async () => {
  const boot = bootCaster();
  vm.runInContext("audiobookUser={Id:'u',Name:'Justin'};", boot.context);
  const chapters = chaptersOf('a book');
  boot.context.__client = makeJellyfinClient(chapters);
  makeChapterContext(boot.context, chapters);
  vm.runInContext('audiobookClient=__client;', boot.context, {timeout:5000});
  await vm.runInContext(
    "startAudiobookSession({id:'b1'}, chapterList[0], {positionTicks:0, autoplay:true})", boot.context, {timeout:5000});
  await flushChains(boot.context);
  vm.runInContext('casterDiag.length = 0', boot.context);
  boot.audio = boot.elements.get('audio');
  return boot;
};

test('a media error restarts the chapter where it died instead of ending the night', async () => {
  const {context, audio, fireTimeout} = await playingChapter();
  let loads = 0;
  audio.load = () => { loads += 1; };
  vm.runInContext('audio.currentTime = 892', context);
  audio.dispatchEvent({type:'error'});

  const armed = vm.runInContext("casterDiag.join(' | ')", context);
  assert.match(armed, /media error pos=892/, 'the element failing must be recorded, with its position');
  assert.match(armed, /media recovery 1\/3 \(error\) in 2000ms from 892s/,
    'the failure must arm a recovery at the position it died, not from 0');

  fireTimeout(2000);
  await new Promise(r => setImmediate(r));
  assert.equal(loads, 1, 'the dead stream must actually be reloaded');
  assert.match(vm.runInContext('JSON.stringify(audiobookPendingResume)', context), /"seconds":892/,
    'the seek must ride the loadedmetadata resume path — a seek before metadata is dropped');
  assert.match(vm.runInContext("casterDiag.join(' | ')", context), /media recovery 1 playing from/,
    'recovery must end in playback, not in a reload nobody notices');
});

test('recovery gives up loudly after three attempts instead of thrashing a dead stream', async () => {
  const {context, audio, fireTimeout} = await playingChapter();
  audio.load = () => {};
  vm.runInContext('audio.currentTime = 500', context);
  for(const delay of [2000, 5000, 12000]){
    audio.dispatchEvent({type:'error'});
    fireTimeout(delay);
  }
  audio.dispatchEvent({type:'error'});   // a fourth failure must not arm a fifth attempt

  const log = vm.runInContext("casterDiag.join(' | ')", context);
  [1, 2, 3].forEach(n => assert.match(log, new RegExp(`media recovery ${n}/3`), `attempt ${n} must run`));
  assert.match(log, /media recovery gave up after 3 attempts/);
  assert.equal(vm.runInContext('mediaRecoveryTimer ? 1 : 0', context), 0, 'nothing may be left in flight');
  assert.match(vm.runInContext('audiobookError', context), /could not be restarted/,
    'when it truly cannot recover he must be told, not left with silence');
});

test('a stream that stops yielding media is recovered, not waited on', async () => {
  const {context, audio, fireInterval} = await playingChapter();
  vm.runInContext('audio.currentTime = 300; audio.paused = false; lastTimeupdateAt = Date.now()', context);
  fireInterval(30000);
  assert.doesNotMatch(vm.runInContext("casterDiag.join(' | ')", context), /media recovery/,
    'a healthy stream must be left alone');

  vm.runInContext('lastTimeupdateAt = Date.now() - 60000', context);
  fireInterval(30000);
  assert.match(vm.runInContext("casterDiag.join(' | ')", context), /media recovery 1\/3 \(stalled 40s\)/,
    'a media clock that has stopped is a dead stream, and it must be recovered unattended');
});

test('recovery leaves a chapter he deliberately paused alone', async () => {
  const {context, audio, fireInterval} = await playingChapter();
  audio.load = () => {};
  vm.runInContext("playerMode='audiobook'; pause('user')", context);
  audio.dispatchEvent({type:'error'});
  vm.runInContext('lastTimeupdateAt = Date.now() - 60000', context);
  fireInterval(30000);

  const log = vm.runInContext("casterDiag.join(' | ')", context);
  assert.match(log, /pause requested: user/);
  assert.doesNotMatch(log, /media recovery/,
    'a failure after a deliberate pause must not be "fixed" by restarting playback at him');
});

/* ---- Replaying the RECORDED sequences rather than my idea of them. The 2026-10-16/17 logs
   are the fixture: the phone's actual event stream, fed through the real app. A failure here
   is a failure of the behaviour he hit, not of an invented scenario. ---- */
const replay = (context, audio, stream) => stream.forEach(([type, state]) => {
  if(state) vm.runInContext(`Object.assign(audio, ${JSON.stringify(state)})`, context);
  audio.dispatchEvent({type});
});

test('replay: the recorded failure — `media error` at 892s of a 2385s chapter — is survived', async () => {
  const {context, audio, fireTimeout} = await playingChapter();
  let loads = 0;
  audio.load = () => { loads += 1; };
  vm.runInContext('casterDiag.length = 0', context);
  replay(context, audio, [
    ['play', {paused:false, duration:2385, currentTime:0}],
    ['durationchange', {}], ['loadedmetadata', {}], ['loadeddata', {}], ['playing', {}],
    // 23:15:48 — 14m52s in, with 1493s of chapter still in front of it
    ['error', {currentTime:892, paused:true}],
    ['pause', {}],
  ]);

  const log = vm.runInContext("casterDiag.join(' | ')", context);
  assert.match(log, /media error pos=892 dur=2385/, 'the recorded failure must be recognisable in the log');
  assert.match(log, /media recovery 1\/3 \(error\) in 2000ms from 892s/,
    'the replay must arm the recovery at the position the real one died at');
  fireTimeout(2000);
  await new Promise(r => setImmediate(r));
  assert.equal(loads, 1, 'the dead stream must be reloaded');
  // the observable proof, not the internal: the armed resume is consumed by the render path
  // the moment duration is known, which is exactly how the seek lands (see resume-seek)
  assert.match(vm.runInContext("casterDiag.join(' | ')", context), /resume-seek \d+->892/,
    'it must come back at 892s, not at 0 — 1493s of chapter would otherwise be re-listened');
  assert.match(vm.runInContext("casterDiag.join(' | ')", context), /media recovery 1 playing from/);
});

test('a chapter that ends while the page is suspended still advances when it comes back', async () => {
  const {context, audio, fireWindow} = await playingChapter();
  const ids = vm.runInContext('chapterList.map(c => c.id)', context);
  vm.runInContext([
    'casterDiag.length = 0; document.visibilityState = "visible";',
    'audio.currentTime = 600; audio.duration = 600; audio.ended = true; audio.paused = true',
  ].join(' '), context);
  fireWindow('visibilitychange');
  await flushChains(context);

  assert.equal(vm.runInContext('audiobookActiveChapterId', context), ids[1],
    '`ended` fired into a suspended page and was lost: coming back must notice it finished');
  assert.match(vm.runInContext("casterDiag.join(' | ')", context),
    /chapter finished while the page was not running \(page visible\) — advancing/,
    'the log must say WHY it advanced without an ended event');
});

test('a finished last chapter is handled once, not once per watchdog tick', async () => {
  const {context, audio, fireWindow, fireInterval} = await playingChapter();
  vm.runInContext('adoptAudiobookChapter("b1", chapterList[1])', context);
  vm.runInContext([
    'casterDiag.length = 0; document.visibilityState = "visible";',
    'audio.currentTime = 600; audio.duration = 600; audio.ended = true; audio.paused = true',
  ].join(' '), context);
  fireWindow('visibilitychange');
  fireInterval(30000);
  fireWindow('visibilitychange');

  const log = vm.runInContext("casterDiag.join(' | ')", context);
  const handled = (log.match(/end of book/g) || []).length;
  assert.equal(handled, 1,
    `the end of the book must be announced once, not on every wake-up (got ${handled})`);
});

test('the diagnostics are reachable from the audiobook screen and copyable', () => {
  assert.match(html, /id="abDiagBtn"/, 'the audiobook screen must offer the log');
  assert.match(html, /id="diagCopy"/, 'the log must be copyable without typing anything by hand');
  assert.match(executable, /function openDiagModal/);
});

test('the render path only touches elements that exist in the static markup', async () => {
  // The harness's $() answers with a fake element for ANY id, so a query that returns
  // null in a real browser is invisible here. His phone reported
  // "Cannot read properties of null (reading 'style')" the moment a session was created —
  // this test makes that class reproducible: only ids present in the static HTML exist.
  const {context} = bootCaster();
  const staticIds = new Set(
    Array.from(html.split('<script type="module">')[0].matchAll(/id="([^"]+)"/g), m => m[1]));
  const orig = context.document.querySelector.bind(context.document);
  context.document.querySelector = (sel) =>
    staticIds.has(String(sel).replace(/^#/, '')) ? orig(sel) : null;
  context.document.getElementById = (id) => staticIds.has(String(id)) ? orig('#' + id) : null;

  vm.runInContext("audiobookUser={Id:'u',Name:'Justin'};", context);
  const chapters = chaptersOf('a book');
  context.__client = makeJellyfinClient(chapters);
  makeChapterContext(context, chapters);
  vm.runInContext('audiobookClient=__client;', context, {timeout:5000});

  await vm.runInContext(
    "ensureAudiobookSession(chapterList[0], audiobookPlaybackGeneration, 0)", context, {timeout:5000});
  await flushChains(context);
  assert.equal(vm.runInContext('audiobookSessionState', context), 'ok',
    'creating a session must not crash the render path');

  // and the same once something is playing and the overlay is open
  vm.runInContext("audio.paused=false; playerMode='audiobook'; renderAll();", context, {timeout:5000});
  assert.equal(vm.runInContext('audiobookSessionState', context), 'ok');
});

test('setting text on a player element must not destroy a queryable child', () => {
  // The real crash behind every "position not saved" night: #pbarCached was nested inside
  // #pbarShow, and renderPlayerBar sets #pbarShow.textContent — which REPLACES all child
  // nodes. The first render destroyed the span; the very next line queried it and threw.
  // The vm harness cannot reproduce child destruction (fake elements just hold a string),
  // so this asserts the structure instead.
  const staticHtml = html.split('<script type="module">')[0];
  const targets = Array.from(executable.matchAll(/\$\('#([A-Za-z0-9_]+)'\)\.textContent\s*=/g), m => m[1]);
  assert.ok(targets.includes('pbarShow') && targets.includes('ovShow'),
    'the test must cover the elements the player actually writes to');
  for (const id of targets) {
    const at = staticHtml.indexOf(`id="${id}"`);
    if (at < 0) continue;                       // built at runtime, not static markup
    const own = staticHtml.indexOf('>', at);
    // bounded by the element's OWN closing tag — otherwise a self-contained span reads
    // as if it contains its following sibling
    const tag = /<([a-z0-9]+)[^>]*$/.exec(staticHtml.slice(0, at))?.[1] || 'div';
    const closer = staticHtml.indexOf(`</${tag}>`, own);
    const closers = [closer].filter(i => i >= 0);
    const end = closers.length ? Math.min(...closers) : staticHtml.length;
    const inner = /id="([^"]+)"/.exec(staticHtml.slice(own + 1, end));
    assert.equal(inner, null,
      `#${id} contains #${inner?.[1]} — writing textContent would destroy it and the next query would throw`);
  }
});

/* ---- The 2026-10-20 log: a chapter play that stopped when nobody asked it to. `media pause`
   at 924s of 1253s with no `pause requested` line, then 44 minutes of heartbeats and no
   playback at all — so the chapter never finished and the book never reached the next one. ---- */

test('replay: the recorded 2026-10-20 interruption is resumed, and a requested pause is not', async () => {
  const {context, audio, fireInterval} = await playingChapter();
  replay(context, audio, [
    ['play', {paused:false, duration:1253, currentTime:924}],
    ['pause', {paused:true, currentTime:924}],   // 06:42:10 — nobody asked for this
  ]);
  const plays = vm.runInContext('audio.playCalls', context);
  fireInterval(30000);

  const log = vm.runInContext("casterDiag.join(' | ')", context);
  assert.match(log, /media interrupted \(watchdog\) — resuming from 924s/,
    'an interruption must be resumed: nothing else was ever going to');
  assert.ok(vm.runInContext('audio.playCalls', context) > plays, 'and it must actually play');
});

test('a pause he asked for is left alone', async () => {
  const {context, audio, fireInterval} = await playingChapter();
  replay(context, audio, [['play', {paused:false, duration:1253, currentTime:924}]]);
  vm.runInContext("pause('user')", context);
  const plays = vm.runInContext('audio.playCalls', context);
  fireInterval(30000);

  assert.doesNotMatch(vm.runInContext("casterDiag.join(' | ')", context), /media interrupted/,
    'resuming a deliberate pause would be the app fighting him');
  assert.equal(vm.runInContext('audio.playCalls', context), plays, 'and it must not play');
});

/* ---- Findings from the whole-repo audit, one test each: the invariants that were claimed
   but not checked, and the two hot paths that used to write far more than they needed. ---- */

test('feed durations parse leniently — the values that used to delete whole shows', () => {
  const {context} = bootCaster();
  const out = vm.runInContext(`[
    parseDuration('3600'), parseDuration('1:02:03'), parseDuration('1:02:03.5'),
    parseDuration('3723.5'), parseDuration('PT1H2M3S'), parseDuration('')
  ].join(',')`, context);
  assert.equal(out, '3600,3723,3723.5,3723.5,0,0',
    'a fractional or ISO duration must not throw: the Python twin treated it as a dead feed');
});

test('the 4-second position save writes the small position key, not the whole library', () => {
  const {context} = bootCaster();
  const res = vm.runInContext(`(() => {
    const keys = [];
    const real = localStorage.setItem;
    localStorage.setItem = (k, v) => { keys.push(k); return real(k, v); };
    state.shows = [{ id:'s', feedUrl:'f', title:'t', episodes:[{guid:'g1', url:'u.mp3', duration:100, title:'t'}] }];
    currentShowId='s'; currentGuid='g1'; playerMode='podcast';
    audio.duration = 100; audio.currentTime = 42; lastPosSave = 0;
    audio.dispatchEvent({type:'timeupdate'});       // the hot path, once
    localStorage.setItem = real;
    return {keys, stored: positions['g1']};
  })()`, context);
  assert.ok(res.keys.includes('caster.positions.v1'), 'the position must still be persisted');
  assert.equal(res.keys.includes('caster.v1'), false,
    'rewriting the 515 KB library to store one number was the finding');
  assert.equal(res.stored, 42, 'and the value is the position');
});

test('a chapter advance opens ONE Jellyfin session when both callers race', async () => {
  const {context} = bootCaster();
  vm.runInContext("audiobookUser={Id:'u',Name:'Justin'};", context);
  const chapters = chaptersOf('a book');
  const client = makeJellyfinClient(chapters);
  let calls = 0, reports = 0;
  const real = client.getPlaybackInfo.bind(client);
  client.getPlaybackInfo = async (c) => { calls += 1; return real(c); };
  client.reportStarted = async () => { reports += 1; };
  context.__client = client;
  makeChapterContext(context, chapters);
  vm.runInContext('audiobookClient=__client;', context, {timeout:5000});

  // exactly what the chapter start and the media element's play event do, in one tick
  await vm.runInContext(`Promise.all([
    ensureAudiobookSession(chapterList[0], audiobookPlaybackGeneration, 0),
    ensureAudiobookSession(chapterList[0], audiobookPlaybackGeneration, 0),
  ])`, context, {timeout:5000});
  await flushChains(context);

  assert.equal(calls, 1, 'two requests meant two server sessions per advance (69 on his server)');
  assert.equal(reports, 1, 'and the session is reported once');
});

test('the interruption resume gives up after three tries instead of logging forever', async () => {
  const {context, audio, fireInterval} = await playingChapter();
  replay(context, audio, [['play', {paused:false}]]);          // a chapter that is playing
  vm.runInContext('audio.duration = 1253; audio.currentTime = 924; audiobookPendingResume = null', context);
  audio.dispatchEvent({type:'pause'});                          // 06:42:10 — nobody asked for this
  audio.play = () => Promise.reject(new Error('no audio focus'));
  for(let i = 0; i < 5; i++){
    vm.runInContext('audio.paused = true; lastStopReason = ""', context);
    fireInterval(30000);
  }
  const log = vm.runInContext("casterDiag.join(' | ')", context);
  assert.equal((log.match(/media interrupted/g) || []).length, 3,
    'unbounded, this retried and logged on every 30s tick for as long as the focus was held');
  assert.match(log, /interrupted resume gave up after 3 attempts/);
  assert.match(vm.runInContext('audiobookError', context), /could not be resumed/,
    'and the give-up is visible in the player, not just the log');
});

test('a failed boot check keeps the token; only a rejection clears it', async () => {
  const boot = bootCaster();
  const token = JSON.stringify({ serverUrl:'https://jellyfin.example.test', accessToken:'tok', userId:'u1', deviceId:'d1' });
  const bootWith = async (thrown) => {
    boot.store.set('caster.jellyfin.token', token);
    boot.context.__thrown = thrown;
    // the app builds its own client, and the class uses Node's real fetch, so stand in for it
    vm.runInContext('JellyfinClient = class { constructor(){} request(){ return Promise.reject(__thrown); } }', boot.context);
    await vm.runInContext('tryResumeJellyfinSession()', boot.context, {timeout:5000});
    return boot.store.get('caster.jellyfin.token');
  };
  assert.equal(await bootWith(new Error('network down')), token,
    'being offline must not sign him out — the password is not stored anywhere');
  assert.equal((await bootWith(Object.assign(new Error('rejected'), { status: 401 }))) ?? null, null,
    'a real rejection still clears it');
});
