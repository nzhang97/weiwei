#!/usr/bin/env node
// tools/ai/cfeval.mjs — counterfactual loadout evaluation on captured real battles.
// For each captured normal battle: re-run it unchanged (control), then for each operator re-run it with every other
// legal skill (and, for elites, every other module) — one unit changed at a time — and record the outcome deltas.
// Usage: node tools/ai/cfeval.mjs --in battles.jsonl --shard i --shards n --out cf.jsonl [--maxUnits 8]
import fs from 'node:fs';
import { Battle } from '../../server/sim/Battle.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { loadoutOptions } from '../../shared/protocol.js';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[a.slice(2)] = v;
}
const shard = Number(opt.shard) || 0, shards = Number(opt.shards) || 1;
const ds = getDefaultSource();
const chess = JSON.parse(fs.readFileSync(new URL('../../data/chess.json', import.meta.url), 'utf8'));
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const out = fs.openSync(opt.out, 'a');

function runBattle(o) {
  const b = new Battle({ data: ds, content: 'full', logger, ...structuredClone(o) });
  let guard = 0;
  while (!b.finished && guard++ < 2e6) b.step();
  const r = b.result();
  const pp = Object.values(r.perPlayer)[0] || {};
  return {
    k: pp.killed ?? r.killed, t: pp.total ?? r.total,
    l: (pp.leaked || []).filter((x) => x && x.counted !== false).length,
    d: Math.round(pp.damageDealt || 0), dead: pp.deaths ?? null, time: Math.round(r.time),
  };
}

const lines = fs.readFileSync(opt.in, 'utf8').split('\n').filter(Boolean);
for (let li = shard; li < lines.length; li += shards) {
  let rec;
  try { rec = JSON.parse(lines[li]); } catch { continue; }
  const o = rec.opts;
  if (!o) continue;
  const units = o.players?.[0]?.units || [];
  let base;
  try { base = runBattle(o); } catch (e) { fs.writeSync(out, JSON.stringify({ seed: rec.seed, round: rec.round, pid: rec.playerId, err: String(e).slice(0, 200) }) + '\n'); continue; }
  const head = { seed: rec.seed, round: rec.round, pid: rec.playerId, stage: o.stageId, wave: o.waveId };
  fs.writeSync(out, JSON.stringify({ ...head, ctrl: base }) + '\n');
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    if (u.kind !== 'chess') continue;
    if (units.some((x) => x.kind === 'token' && x.ownerUid === u.uid)) continue; // placed summons depend on the skill
    const c = chess[u.chessId];
    if (!c) continue;
    const baseRec = c.isGolden ? chess[c.baseId] || c : c;
    const goldenRec = c.isGolden ? c : (c.goldenId ? chess[c.goldenId] : null);
    const lo = loadoutOptions(baseRec, goldenRec);
    const variants = [];
    for (const s of lo.skills) if (s !== u.skillIndex) variants.push({ skillIndex: s, moduleId: u.moduleId });
    if (c.isGolden) for (const md of lo.modules) if (md !== (u.moduleId ?? 'none')) variants.push({ skillIndex: u.skillIndex, moduleId: md });
    for (const v of variants) {
      const o2 = structuredClone(o);
      const uu = o2.players[0].units[ui];
      uu.skillIndex = v.skillIndex;
      uu.moduleId = v.moduleId === 'none' ? 'none' : v.moduleId;
      let alt;
      try { alt = runBattle(o2); } catch (e) { continue; }
      fs.writeSync(out, JSON.stringify({ ...head, chessId: u.chessId, golden: !!c.isGolden, from: [u.skillIndex, u.moduleId ?? null], to: [v.skillIndex, v.moduleId ?? null],
        dk: alt.k - base.k, dl: alt.l - base.l, dd: alt.d - base.d, bl: base.l, bk: base.k, t: base.t }) + '\n');
    }
  }
}
fs.closeSync(out);
