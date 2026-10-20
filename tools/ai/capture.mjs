#!/usr/bin/env node
// tools/ai/capture.mjs — run 4-AI coop matches and capture every normal battle's full input (rounds >= --minRound).
// Usage: node tools/ai/capture.mjs --seeds a,b,c [--difficulty ABYSS] [--minRound 3] --out battles.jsonl
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { getData } from '../../server/data.js';
import { BOT_POLICY } from '../../server/match/ai/botPolicy.js';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[a.slice(2)] = v;
}
const difficulty = String(opt.difficulty || 'ABYSS').toUpperCase();
const seeds = String(opt.seeds).split(',').map(Number).filter(Number.isFinite);
const minRound = Number(opt.minRound) || 3;
const data = getData({ log: { warn() {}, error() {}, info() {} } });
const out = fs.openSync(opt.out, 'a');

let current = null;
const orig = Match.prototype._normalOpts;
Match.prototype._normalOpts = function (ps) {
  const o = orig.call(this, ps);
  if (this.round >= minRound && this.phase === 'COMBAT') {
    try {
      const rec = { seed: current, round: this.round, playerId: ps.playerId, opts: o };
      fs.writeSync(out, JSON.stringify(rec) + '\n');
    } catch { /* capture only */ }
  }
  return o;
};

for (const seed of seeds) {
  current = seed;
  const sched = new VirtualScheduler();
  const seats = [0, 1, 2, 3].map((i) => ({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true }));
  let summary = null;
  const m = new Match({
    roomCode: 'CAP', mode: 'coop', difficulty, seats, seed, data, log: { info() {}, debug() {}, warn() {}, error() {} },
    scheduler: sched, battleContent: 'full', botPolicy: BOT_POLICY, send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  });
  m.start();
  let last = '';
  sched.runUntil(() => {
    const key = `${m.phase}:${m.round}`;
    if (key !== last) {
      last = key;
      if (m.phase === 'UNITE' || m.phase === 'SETTLE') {
        for (const ps of m.order) {
          const r = m.lastResults.get(ps.playerId);
          if (r && m.round >= minRound) fs.writeSync(out, JSON.stringify({ seed, round: m.round, playerId: ps.playerId, phase: m.phase,
            real: { k: r.killed, l: (r.leaked || []).filter((l) => l.counted !== false).length, d: Math.round(r.damageDealt || 0) } }) + '\n');
        }
      }
    }
    return summary != null;
  }, { maxSteps: 5e6 });
  m.dispose();
}
fs.closeSync(out);
