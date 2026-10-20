#!/usr/bin/env node
// tools/ai/cfitems.mjs — headroom of equipment reassignment on captured battles vs a seed-noise floor.
// For each captured battle (rounds >= minRound): control; K reruns with a different battle seed (noise floor);
// every single-item move from its carrier to another chess unit (carrier limit 2) — one change per run.
import fs from 'node:fs';
import { Battle } from '../../server/sim/Battle.js';
import { getDefaultSource } from '../../server/sim/simdata.js';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[a.slice(2)] = v;
}
const shard = Number(opt.shard) || 0, shards = Number(opt.shards) || 1, minRound = Number(opt.minRound) || 7;
const K = Number(opt.noise) || 6, every = Number(opt.every) || 1;
const ds = getDefaultSource();
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const out = fs.openSync(opt.out, 'a');
function runBattle(o) {
  const b = new Battle({ data: ds, content: 'full', logger, ...structuredClone(o) });
  let g = 0;
  while (!b.finished && g++ < 2e6) b.step();
  const r = b.result();
  const pp = Object.values(r.perPlayer)[0] || {};
  return { k: pp.killed ?? r.killed, l: (pp.leaked || []).filter((x) => x && x.counted !== false).length };
}
const lines = fs.readFileSync(opt.in, 'utf8').split('\n').filter(Boolean);
let idx = -1;
for (let li = 0; li < lines.length; li++) {
  let rec; try { rec = JSON.parse(lines[li]); } catch { continue; }
  if (!rec.opts || rec.round < minRound) continue;
  idx++;
  if (idx % every !== 0 || (idx / every) % shards !== shard) continue;
  const o = rec.opts, units = o.players[0].units;
  const base = runBattle(o);
  const noise = [];
  for (let k = 1; k <= K; k++) { const o2 = structuredClone(o); o2.seed = (o.seed * 7919 + k * 104729) >>> 0; noise.push(runBattle(o2).l - base.l); }
  const moves = [];
  for (let a = 0; a < units.length; a++) {
    const ua = units[a];
    if (ua.kind !== 'chess' || !ua.items || !ua.items.length) continue;
    for (let ii = 0; ii < ua.items.length; ii++) {
      for (let bI = 0; bI < units.length; bI++) {
        const ub = units[bI];
        if (bI === a || ub.kind !== 'chess' || (ub.items || []).length >= 2) continue;
        const o2 = structuredClone(o);
        const A = o2.players[0].units[a], Bu = o2.players[0].units[bI];
        const [it] = A.items.splice(ii, 1);
        Bu.items = [...(Bu.items || []), it];
        moves.push({ item: it, from: ua.chessId, to: ub.chessId, dl: runBattle(o2).l - base.l });
      }
    }
  }
  fs.writeSync(out, JSON.stringify({ seed: rec.seed, round: rec.round, pid: rec.playerId, bl: base.l, noise, moves }) + '\n');
}
fs.closeSync(out);
