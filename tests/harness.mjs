// Shared vm harness: boots the real index.html script with stubbed DOM/storage.
// One definition so the behavioural suite and the live server probe test the same app.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { nextChapter, ticksToSeconds, secondsToTicks, buildStreamUrl, normalizeServerUrl, JellyfinClient, genericNormalizeChapters, createDeviceId } from '../jellyfin.mjs';
import { appendEvent, loadEvents, groupEventsByNight, analyzeNight, summarizeNight, pruneOldEvents, localDate } from '../sleep.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('index.html has no inline module application script');

// strip the import lines (a single-match regex would leave a second import executable)
const source = script
  .replace(/^import .*;\s*/gm, '')
  .replace(/renderAll\(\);\s*loadBundledShows\(\)\.then\(renderAll\);\s*$/, '');

export { html, script, source };

export function bootCaster(executable = source) {
  const elements = new Map();
  const element = id => {
    if (elements.has(id)) return elements.get(id);
    const e = {
      id,
      style: {},
      dataset: {},
      classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
      // Listeners are RECORDED, not swallowed: the app's own media-element listeners are
      // the only way to test the instrumentation that tells a stalled element from a
      // frozen page (and the ended→advance path). Nothing fires unless a test dispatches.
      _listeners: {},
      addEventListener(type, fn){ (this._listeners[type] = this._listeners[type] || []).push(fn); },
      removeEventListener(type, fn){ const list = this._listeners[type] || []; const i = list.indexOf(fn); if(i >= 0) list.splice(i, 1); },
      dispatchEvent(event){ (this._listeners[event?.type] || []).slice().forEach(fn => fn(event)); return true; },
      querySelector(){ return element(`${id}:child`); },
      querySelectorAll(){ return []; },
      setAttribute(){}, removeAttribute(){},
      getBoundingClientRect(){ return {left:0,top:0,width:100,height:10}; },
      play(){ this.paused = false; this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve(); },
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
  const windowListeners = new Map();
  const window = {
    scrollTo(){}, location:{href:'https://example.test/'},
    addEventListener(type, fn){ windowListeners.set(type, [...(windowListeners.get(type) || []), fn]); },
  };
  const intervals = new Map();
  const navigator = {mediaSession:{setPositionState(){},setActionHandler(){},playbackState:'paused'}};
  const context = vm.createContext({
    document, window, navigator, nextChapter, ticksToSeconds, secondsToTicks, buildStreamUrl, normalizeServerUrl, JellyfinClient, genericNormalizeChapters, createDeviceId,
    appendEvent, loadEvents, groupEventsByNight, analyzeNight, summarizeNight, pruneOldEvents, localDate,
    localStorage:{get length(){return store.size},getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),key:i=>Array.from(store.keys())[i]??null,[Symbol.iterator]:function*(){for(const entry of store)yield entry}},
    sessionStorage:{getItem:k=>store.get(`session:${k}`)??null,setItem:(k,v)=>store.set(`session:${k}`,String(v)),removeItem:k=>store.delete(`session:${k}`)},
    fetch:async()=>({ok:false,status:404,json:async()=>({})}),
    DOMParser:class{}, URL, URLSearchParams, AbortController, MediaMetadata:class{},
    setTimeout:()=>0, clearTimeout(){}, setInterval:(fn, ms)=>{ intervals.set(ms, [...(intervals.get(ms) || []), fn]); return 0; }, Math, Date, Map, Set, Object, String, Number, Array, Promise, Error, isFinite, console,
  });
  vm.runInContext(executable, context);
  const fireWindow = (type, event = {}) => (windowListeners.get(type) || []).slice().forEach(fn => fn(event));
  const fireInterval = (ms) => (intervals.get(ms) || []).slice().forEach(fn => fn());
  return {context, elements, store, script, fireWindow, fireInterval};
}

// Let every pending promise chain (PlaybackInfo -> report -> play) drain.
export async function flushChains(context, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await new Promise(r => setImmediate(r));
    await vm.runInContext('Promise.resolve(audiobookReportChain).catch(()=>{})', context).catch(() => {});
  }
}
