// test/match/bot-warp.test.js — 加速 (server/match/match/clientCombat.js _maybeWarpFields): once no human battle of the
// phase is left, the server-run AI fields play out BOT_WARP_FACTOR× faster — field clock, result release and the
// b.start their viewers get (speed / elapsed) all follow; boss fields and phases with a human still fighting do not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { BOT_WARP_FACTOR } from '../../server/match/match/clientCombat.js';
import { PHASE } from '../../shared/constants.js';

function rig() {
  const clock = { now: 1000 };
  const sent = [];
  const m = Object.create(Match.prototype);
  Object.assign(m, {
    gameSpeed: 2, paused: false, phase: PHASE.COMBAT, sched: { instant: false, now: () => clock.now },
    fields: [], players: new Map(), spectators: new Map(), order: [], watchers: new Map(), timers: [],
  });
  m.later = (ms, fn) => { const t = { at: clock.now + ms, fn }; m.timers.push(t); return t; };
  m.cancel = (t) => { m.timers = m.timers.filter((x) => x !== t); };
  m.markPublic = () => {};
  m.sendTo = (pid, msg) => { sent.push([pid, msg]); return true; };
  m._maybeFieldsDone = () => {};
  const human = { playerId: 'p_0', isBot: false, left: false, connected: true, alive: true, seat: 0 };
  const bot = { playerId: 'p_1', isBot: true, left: false, connected: true, alive: true, seat: 1 };
  m.players.set('p_0', human); m.players.set('p_1', bot); m.order.push(human, bot);
  const field = (pid, extra) => ({ cc: true, kind: 'normal', fieldId: `n:${pid}`, battleId: `b.${pid}`, players: [pid], spec: { timeLimit: 60 },
    startAt: 1000, done: false, live: true, progress: { done: false }, ...extra });
  const fH = field('p_0', { mode: 'client', authority: 'p_0' });
  const fB = field('p_1', { mode: 'server', result: { time: 40, perPlayer: {} }, endGt: 40 });
  m.fields.push(fH, fB);
  return { m, clock, sent, fH, fB };
}

test('AI fields warp once the human battle is done', () => {
  assert.ok(BOT_WARP_FACTOR > 1);
  const { m, clock, sent, fH, fB } = rig();
  m._armRelease(fB);
  assert.equal(fB.doneTimer.at, 1000 + 20000, 'unwarped: released at the natural end (40 gs at ×2)');
  clock.now = 11000;
  m._maybeWarpFields();
  assert.equal(fB.warp, undefined, 'a human battle still runs');
  assert.equal(m._fieldElapsed(fB), 20);
  m.watchers.set('p_0', fB.fieldId);
  fH.result = { time: 20, perPlayer: {} };
  m._fieldDone(fH);
  assert.deepEqual(fB.warp, { at: 11000, gt: 20, factor: BOT_WARP_FACTOR });
  const rate = 2 * BOT_WARP_FACTOR;
  assert.equal(fB.doneTimer.at, 11000 + Math.round((20 / rate) * 1000), 'release re-armed on the warped clock');
  clock.now = 12000;
  assert.equal(m._fieldElapsed(fB), 20 + rate);
  const starts = sent.filter(([pid, msg]) => pid === 'p_0' && msg.t === 'b.start' && msg.fieldId === fB.fieldId);
  assert.equal(starts.length, 1, 'the watcher is told the new rate');
  assert.equal(starts[0][1].speed, rate);
  assert.equal(starts[0][1].elapsed, 20);
  assert.equal(starts[0][1].watch, true);
  assert.equal(m._startMsg(fH, 'p_0').speed, 2, 'the human field keeps the match speed');
});

test('boss fields and virtual-time runs never warp', () => {
  const { m, clock, fH, fB } = rig();
  fB.kind = 'boss';
  fH.done = true;
  clock.now = 5000;
  m._maybeWarpFields();
  assert.equal(fB.warp, undefined, 'boss');
  fB.kind = 'normal';
  m.sched.instant = true;
  m._maybeWarpFields();
  assert.equal(fB.warp, undefined, 'instant');
  m.sched.instant = false;
  m.phase = PHASE.PREP;
  m._maybeWarpFields();
  assert.equal(fB.warp, undefined, 'not a battle phase');
});
