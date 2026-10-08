import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nightKey, localDate, inNightWindow, groupEventsByNight,
  analyzeNight, summarizeNight,
} from '../sleep.mjs';

test('nightKey assigns events before noon to the prior date', () => {
  // Oct 8 2026 02:00 → should belong to Oct 7's night
  const late = new Date('2026-10-08T02:00:00').getTime();
  assert.equal(nightKey(late), '2026-10-07');
  // Oct 8 2026 14:00 → belongs to Oct 8's night
  const early = new Date('2026-10-08T14:00:00').getTime();
  assert.equal(nightKey(early), '2026-10-08');
});

test('inNightWindow returns true between 20:00 and 06:59', () => {
  assert.ok(inNightWindow(new Date('2026-10-08T22:00:00').getTime()));
  assert.ok(inNightWindow(new Date('2026-10-08T03:00:00').getTime()));
  assert.ok(!inNightWindow(new Date('2026-10-08T12:00:00').getTime()));
  assert.ok(!inNightWindow(new Date('2026-10-08T19:00:00').getTime()));
});

test('groupEventsByNight splits events into calendar-night buckets', () => {
  const events = [
    { t: new Date('2026-10-07T23:00:00').getTime(), type: 'timer' },
    { t: new Date('2026-10-08T02:00:00').getTime(), type: 'play' },
    { t: new Date('2026-10-08T15:00:00').getTime(), type: 'play' }, // should be in next night
  ];
  const nights = groupEventsByNight(events);
  assert.equal([...nights.keys()].length, 2);
  assert.equal(nights.get('2026-10-07').length, 2);  // timer + midnight play
  assert.equal(nights.get('2026-10-08').length, 1);  // afternoon play
});

test('analyzeNight returns null for an empty night', () => {
  assert.equal(analyzeNight([]), null);
  assert.equal(analyzeNight([{ t: new Date('2026-10-08T12:00:00').getTime(), type: 'play' }]), null);
});

test('analyzeNight counts a single isolated play as one awakening', () => {
  const events = [{ t: new Date('2026-10-08T02:00:00').getTime(), type: 'play' }];
  const r = analyzeNight(events);
  assert.equal(r.awakenings, 1);
});

test('analyzeNight merges plays inside 10-min burst as one awakening', () => {
  const t0 = new Date('2026-10-08T02:00:00').getTime();
  const events = [
    { t: t0, type: 'play' },
    { t: t0 + 3 * 60 * 1000, type: 'play' },
    { t: t0 + 6 * 60 * 1000, type: 'play' },
  ];
  assert.equal(analyzeNight(events).awakenings, 1);
});

test('analyzeNight counts plays >10min apart as separate awakenings', () => {
  const t0 = new Date('2026-10-08T02:00:00').getTime();
  const events = [
    { t: t0, type: 'play' },
    { t: t0 + 20 * 60 * 1000, type: 'play' },
  ];
  assert.equal(analyzeNight(events).awakenings, 2);
});

test('analyzeNight calculates quiet time from timer to morning play', () => {
  const timer = new Date('2026-10-07T23:30:00').getTime();
  const morning = new Date('2026-10-08T06:15:00').getTime();
  const events = [
    { t: timer, type: 'timer' },
    { t: morning, type: 'play' },
  ];
  const r = analyzeNight(events);
  assert.equal(r.awakenings, 1);
  assert.ok(r.quietMinutes >= 400 && r.quietMinutes <= 410); // ~405 min
  assert.equal(r.quietStart, timer);
  assert.equal(r.quietEnd, morning);
});

test('analyzeNight ignores timer if timer event is missing', () => {
  const events = [
    { t: new Date('2026-10-08T02:00:00').getTime(), type: 'play' },
    { t: new Date('2026-10-08T03:30:00').getTime(), type: 'play' },
  ];
  const r = analyzeNight(events);
  assert.equal(r.awakenings, 2);
  assert.equal(r.quietMinutes, null);
});

test('summarizeNight produces a human-readable string', () => {
  const s = summarizeNight({ awakenings: 3, quietMinutes: 360, lastAwakeAt: new Date('2026-10-08T05:45:00').getTime() });
  assert.match(s, /3 est./);
  assert.match(s, /360.*min|6h/);
  assert.match(s, /05:45/);
});

test('summarizeNight returns null when given null input', () => {
  assert.equal(summarizeNight(null), null);
});