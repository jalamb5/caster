import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { script, source as executable, bootCaster, flushChains } from './harness.mjs';

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

test('Jellyfin access tokens are never written to browser storage', () => {
  assert.doesNotMatch(script,/sessionStorage|accessToken.*(?:localStorage|sessionStorage)/);
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

test('resume position does not overwrite Jellyfin user data in browser storage', () => {
  const {store}=bootCaster();
  assert.equal([...store.keys()].some(key=>key.includes('audiobook.position')),false);
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
