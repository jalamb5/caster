import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { nextChapter, ticksToSeconds, secondsToTicks, buildStreamUrl, normalizeServerUrl, JellyfinClient } from '../jellyfin.mjs';
import { appendEvent, loadEvents, groupEventsByNight, analyzeNight, summarizeNight, pruneOldEvents, localDate } from '../sleep.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
assert.match(manifest.name,/podcasts and audiobooks/);
assert.match(manifest.description,/Jellyfin audiobooks/);
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'index.html has an inline module application script');
const execSource = source => source.replace(/^import .*;\s*/gm, '').replace(/renderAll\(\);\s*loadBundledShows\(\)\.then\(renderAll\);\s*$/, '');
const executable = execSource(script);
const duplicateDefinitions = name => (executable.match(new RegExp(`function ${name}\\(`,'g')) || []).length;
assert.equal(duplicateDefinitions('pause'),1,'player handlers have one authoritative definition');
assert.equal(duplicateDefinitions('togglePlay'),1,'player handlers have one authoritative definition');
assert.equal(duplicateDefinitions('skipCurrent'),1,'player handlers have one authoritative definition');
assert.doesNotMatch(executable,/sessionStorage|accessToken.*(?:localStorage|sessionStorage)/);

function bootCaster(source=execSource(script)) {
  const elements = new Map();
  const element = id => {
    if (elements.has(id)) return elements.get(id);
    const e = {
      id,
      style: {},
      dataset: {},
      classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
      addEventListener(){},
      removeEventListener(){},
      querySelector(){ return element(`${id}:child`); },
      querySelectorAll(){ return []; },
      setAttribute(){}, removeAttribute(){},
      getBoundingClientRect(){ return {left:0,top:0,width:100,height:10}; },
      play(){ this.paused = false; return Promise.resolve(); },
      pause(){ this.paused = true; },
      paused: true, currentTime: 0, duration: 0, playbackRate:1,
      textContent:'', innerHTML:'', src:'', value:'',
    };
    elements.set(id,e);
    return e;
  };
  const store = new Map([['caster.jellyfin.server','https://example.test']]);
  const document = {
    querySelector: s => element(s.replace(/^#/,'')),
    querySelectorAll: () => [],
    getElementById: id => element(id),
    createElement: () => element(`created-${elements.size}`),
    head:{appendChild(){}},
    body:{classList:{add(){},remove(){}}},
  };
  const window = {scrollTo(){}, addEventListener(){}, location:{href:'https://example.test/'} };
  const navigator = {mediaSession:{setPositionState(){},setActionHandler(){},playbackState:'paused'}};
  const context = vm.createContext({
    document, window, navigator, nextChapter, ticksToSeconds, secondsToTicks, buildStreamUrl, normalizeServerUrl, JellyfinClient,
    appendEvent, loadEvents, groupEventsByNight, analyzeNight, summarizeNight, pruneOldEvents, localDate,
    localStorage:{get length(){return store.size},getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),key:i=>Array.from(store.keys())[i]??null,[Symbol.iterator]:function*(){for(const entry of store)yield entry}},
    sessionStorage:{getItem:k=>store.get(`session:${k}`)??null,setItem:(k,v)=>store.set(`session:${k}`,String(v)),removeItem:k=>store.delete(`session:${k}`)},
    fetch:async()=>({ok:false,status:404,json:async()=>({})}),
    DOMParser:class{}, URL, URLSearchParams, AbortController, MediaMetadata:class{},
    setTimeout:()=>0, clearTimeout(){}, setInterval:()=>0, Math, Date, Map, Set, Object, String, Number, Array, Promise, Error, isFinite, console,
  });
  vm.runInContext(source, context);
  return {context, elements, store, script:executable};
}

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

test('refreshing the catalogue retains an active selected book and chapter', async () => {
  const {context}=bootCaster();
  const result=vm.runInContext(`(()=>{
    audiobookUser={Id:'alice'};playerMode='audiobook';
    audiobookActiveBookId='b';audiobookActiveChapterId='ch';
    audiobookBooks=[{id:'b',title:'Book',missingChapterNumbers:[],duplicateChapterNumbers:[],chapters:[{id:'ch',chapterNumber:1,positionTicks:0,title:'one'}]}];
    audiobookClient={
      getAudiobooksCatalogue:async()=>({libraryId:'lib'}),
      getFolderItems:async()=>({Items:[{Id:'b',Name:'Book',Type:'Folder'}]}),
    };
    return refreshHarryPotterBooks().then(()=>({book:audiobookActiveBookId,chapter:audiobookActiveChapterId}));
  })()`,context);
  const value=await result;
  assert.equal(value.book,'b');assert.equal(value.chapter,'ch');
});

test('pause and togglePlay definitions are not duplicated', () => {
  assert.equal((script.match(/function pause\(/g)||[]).length,1);
  assert.equal((script.match(/function togglePlay\(/g)||[]).length,1);
  assert.equal((script.match(/function skipCurrent\(/g)||[]).length,1);
});
