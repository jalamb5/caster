// Sleep pattern inference from Caster playback interaction logs.
// Pure, testable logic: night segmentation, awakening estimation, quiet-time.
// All data lives in localStorage; nothing leaves the device.

const EVENT_KEY = 'caster.sleep.events.v1';
const NIGHT_START_HOUR = 12;   // noon: events before noon belong to the previous night
const NIGHT_WINDOW_START = 20; // 20:00 — earliest hour counted as "night" activity
const NIGHT_WINDOW_END = 7;    // 07:00 — latest hour counted as "night" activity
const AWAKENING_GAP_MIN = 10;  // minutes a play event must follow the last event to count as new awakening
const BURST_GAP_MIN = 10;      // plays closer than this are the same awakening (burst of tapping)

export function localDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Which "night" (by its starting calendar date) does a timestamp belong to?
export function nightKey(t) {
  const d = new Date(t);
  if (d.getHours() >= NIGHT_START_HOUR) return localDate(t);
  return localDate(t - 24 * 60 * 60 * 1000);
}

export function inNightWindow(t) {
  const h = new Date(t).getHours();
  return h >= NIGHT_WINDOW_START || h < NIGHT_WINDOW_END;
}

export function loadEvents() {
  try {
    const raw = localStorage.getItem(EVENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(e => e && typeof e.t === 'number' && (e.type === 'play' || e.type === 'timer')) : [];
  } catch { return []; }
}

export function saveEvents(events) {
  try {
    localStorage.setItem(EVENT_KEY, JSON.stringify(events));
    return true;
  } catch { return false; }
}

export function appendEvent(type) {
  const events = loadEvents();
  const ev = { t: Date.now(), type };
  events.push(ev);
  // Keep it bounded: ~2 years of nightly events is plenty
  if (events.length > 5000) events.splice(0, events.length - 5000);
  saveEvents(events);
  return ev;
}

export function pruneOldEvents(maxAgeMs = 400 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const events = loadEvents().filter(e => now - e.t < maxAgeMs);
  saveEvents(events);
  return events;
}

// Group flat events into per-night sessions, sorted by time.
export function groupEventsByNight(events) {
  const nights = new Map();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const key = nightKey(e.t);
    if (!nights.has(key)) nights.set(key, []);
    nights.get(key).push(e);
  }
  return nights;
}

// Analyze one night's events: awakenings (play bursts in the night window,
// separated by > AWAKENING_GAP_MIN), quiet start/end when a timer fired.
export function analyzeNight(events) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const windowEvents = sorted.filter(e => inNightWindow(e.t));
  if (!windowEvents.length) return null;

  const plays = windowEvents.filter(e => e.type === 'play');
  const timerEvents = windowEvents.filter(e => e.type === 'timer');

  // Cluster plays: a new awakening when gap from previous play/timer > threshold
  const clusters = [];
  let current = null;
  for (const e of windowEvents) {
    if (e.type === 'timer') {
      // A timer firing ends a listening block; a play after it can start a new cluster
      if (current) { clusters.push(current); current = null; }
      continue;
    }
    if (!current) {
      current = { t: e.t, last: e.t };
      continue;
    }
    if (e.t - current.last > AWAKENING_GAP_MIN * 60 * 1000) {
      clusters.push(current);
      current = { t: e.t, last: e.t };
    } else {
      current.last = e.t;
    }
  }
  if (current) clusters.push(current);

  const result = {
    awakenings: clusters.length,
    firstAwakeAt: clusters.length ? clusters[0].t : null,
    lastAwakeAt: clusters.length ? clusters[clusters.length - 1].t : null,
    quietStart: null,
    quietEnd: null,
    quietMinutes: null,
  };

  // Quiet time: timer fired → last night-window activity (or morning resume)
  if (timerEvents.length) {
    const firstTimer = Math.min(...timerEvents.map(e => e.t));
    const activeAfterTimer = windowEvents.filter(e => e.t > firstTimer);
    // Morning = first event after 05:00 local, else last event overall
    const morning = activeAfterTimer.find(e => new Date(e.t).getHours() >= 5) || activeAfterTimer[activeAfterTimer.length - 1];
    if (morning) {
      result.quietStart = firstTimer;
      result.quietEnd = morning.t;
      result.quietMinutes = Math.round((morning.t - firstTimer) / 60000);
    }
  }

  return result;
}

export function summarizeNight(analysis) {
  if (!analysis) return null;
  const parts = [];
  parts.push(`${analysis.awakenings} est. awakening${analysis.awakenings === 1 ? '' : 's'}`);
  if (analysis.quietMinutes != null) {
    const h = Math.floor(analysis.quietMinutes / 60);
    const m = analysis.quietMinutes % 60;
    parts.push(`${h}h ${m}m playback-free`);
  } else {
    parts.push('no sleep timer');
  }
  if (analysis.lastAwakeAt) {
    parts.push(`last tap ${new Date(analysis.lastAwakeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  }
  return parts.join(' · ');
}