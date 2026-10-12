#!/usr/bin/env node
// tools/airun.mjs — research runner: 4-AI coop matches, one JSON line per match (rich per-round telemetry).
// Usage: node tools/airun.mjs --seeds 1000,1001,... | --from A --count N  [--difficulty ABYSS] [--policy file.json]
//        [--rehearsal 3] [--out file.jsonl]
// --policy: JSON object of overrides. Keys under "abyss" (or "byDifficulty") merge into the difficulty preset; other
// top-level keys merge into the policy root. Room options match the AI-AUDIT protocol (draw optimisation on,
// all buffs / nerfs / free picks off).
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { BOT_POLICY } from '../server/match/botPolicy.js';
import fs from 'node:fs';
import { PlayerState } from '../server/match/PlayerState.js';
import { rotateOffset } from '../server/sim/dir.js';
// positional layer garrisons (空弦 / 断崖 …, SERVER_ADD_BOND_POSITION): [chessId, dir, neighbourId|null, neighbour active bonds, own active bonds]
function posTele(ps) {
  const out = [];
  for (const [k, p] of ps.board) {
    if (p.kind !== 'chess') continue;
    for (const gid of ps.gd.chess(p.id)?.garrisonIds || []) {
      const g = ps.gd.garrison(gid);
      if (!g || g.effectKey !== 'SERVER_ADD_BOND_POSITION') continue;
      const [r, c] = k.split(',').map(Number);
      const [dr, dc] = rotateOffset(0, g.bbStr?.dir === 'behind' ? -1 : 1, p.dir || 'RIGHT');
      const nb = ps.board.get(`${r + dr},${c + dc}`);
      const act = (id) => (ps.gd.chess(id)?.bonds || []).filter((b) => ps.bonds?.[b]?.active).length;
      out.push([p.id, g.bbStr?.dir || 'front', nb && nb.kind === 'chess' ? nb.id : null, nb && nb.kind === 'chess' ? act(nb.id) : 0, act(p.id)]);
    }
  }
  return out;
}
// economy telemetry per prep: buys [kind,id,price], refreshes, level-ups, sells, equipped items, funds added by reason
const ecOf = (ps) => { const r = ps.m.round; const e = ((ps._econ ||= {})[r] ||= { b: [], rf: 0, lv: 0, s: [], eq: [], add: {} }); return e; };
for (const [name, fn] of Object.entries({
  buy(slotIdx) { const s = this.shop?.slots?.[slotIdx]; const price = s ? this.priceOf(s) : null; const res = PlayerState.prototype.__buy.call(this, slotIdx); try { if (res && res.ok !== false && s) ecOf(this).b.push([s.kind === 'item' ? 'i' : 'c', s.id, price]); } catch {} return res; },
  refresh() { const f0 = this.funds; const res = PlayerState.prototype.__refresh.call(this); try { if (res && res.ok !== false) { const e = ecOf(this); e.rf++; e.rfc = (e.rfc || 0) + (f0 - this.funds); } } catch {} return res; },
  levelUp() { const res = PlayerState.prototype.__levelUp.call(this); try { if (res && res.ok !== false) ecOf(this).lv++; } catch {} return res; },
  sell(uid) { const loc = this.find(uid); const id = loc?.piece?.id; const res = PlayerState.prototype.__sell.call(this, uid); try { if (res && res.ok !== false && id) ecOf(this).s.push(id); } catch {} return res; },
  equip(itemUid, targetUid, replaceUid = null) { const loc = this.find(itemUid); const id = loc?.piece?.id; const res = PlayerState.prototype.__equip.call(this, itemUid, targetUid, replaceUid); try { if (res && res.ok !== false && id) ecOf(this).eq.push(id); } catch {} return res; },
  addFunds(n, o = {}) { const res = PlayerState.prototype.__addFunds.call(this, n, o); try { const k = (o && o.reason) || '?'; const e = ecOf(this); e.add[k] = (e.add[k] || 0) + n; } catch {} return res; },
})) { PlayerState.prototype['__' + name] = PlayerState.prototype[name]; PlayerState.prototype[name] = fn; }
// telemetry: funds lost and unused hand items at each prep end (read-only)
const _endPrep = PlayerState.prototype.endPrep;
PlayerState.prototype.endPrep = function () {
  try {
    const kept = this.gd.leftoverKeptBands.includes(this.bandId);
    (this._tele ||= {})[this.m.round] = { fl: kept ? 0 : this.funds, hi: this.hand.filter((p) => p && p.kind === 'item').length,
      hc: this.hand.filter((p) => p && p.kind === 'chess').length, lv: this.shop.level, up: this.shop.upgradePrice, pos: posTele(this), ec: this._econ?.[this.m.round] || null,
      bank: this.hand.filter((p) => p && p.kind === 'item' && /^chess_item_(1_03|2_05|2_07|3_12)_e/.test(p.id)).map((p) => p.id) };
  } catch { /* telemetry only */ }
  return _endPrep.call(this);
};

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[a.slice(2)] = v;
}
const difficulty = String(opt.difficulty || 'ABYSS').toUpperCase();
let seeds = [];
if (opt.seeds) seeds = String(opt.seeds).split(',').map(Number).filter(Number.isFinite);
else { const a = Number(opt.from) || 1, n = Number(opt.count) || 1; for (let i = 0; i < n; i++) seeds.push(a + i); }
const rehearsal = opt.rehearsal != null ? Math.max(0, Number(opt.rehearsal) || 0) : undefined;
const ov = opt.policy ? JSON.parse(fs.readFileSync(opt.policy, 'utf8')) : {};
const { abyss, byDifficulty, perSeed, ...rootOv } = ov;
const diffOv0 = { ...(byDifficulty?.[difficulty] || {}), ...(difficulty === 'ABYSS' ? (abyss || {}) : {}) };
// perSeed: { "<seed>": { ...difficulty overrides } } layered on top (randomised screening designs).
function buildPolicy(seed) {
  const diffOv = { ...diffOv0, ...((perSeed && perSeed[String(seed)]) || {}) };
  return {
    // Match spreads the root last, so difficulty overrides are mirrored at the root to take precedence.
    ...BOT_POLICY, ...rootOv, ...diffOv,
    byDifficulty: { ...BOT_POLICY.byDifficulty, [difficulty]: { ...(BOT_POLICY.byDifficulty?.[difficulty] || {}), ...diffOv } },
  };
}
const data = getData({ log: { warn() {}, error() {}, info() {} } });
const out = opt.out ? fs.openSync(opt.out, 'a') : null;

function runOne(seed) {
  const sched = new VirtualScheduler();
  const errors = [];
  const log = { info() {}, debug() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
  // --blank <seat>: a connected human seat that never acts (白板队友); every phase runs on its multi-human timers so the
  // match never waits on it (timeouts: default strategy, prep deadline); --blankLp sets its LP after the strategy draft
  const blank = opt.blank != null && opt.blank !== true ? Number(opt.blank) : null;
  const seats = [0, 1, 2, 3].map((i) => (i === blank
    ? { seat: i, playerId: `hu_${i}`, name: `白板-${i + 1}`, isBot: false, connected: true }
    : { seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true }));
  let summary = null;
  const m = new Match({
    roomCode: 'RUN', mode: 'coop', difficulty, seats, seed, data, log, scheduler: sched, battleContent: 'full',
    botRehearsal: rehearsal, botPolicy: buildPolicy(seed), send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  });
  const rounds = [];
  let last = '';
  const t0 = Date.now();
  if (blank != null) m.loneHuman = false;
  let blankLpSet = blank == null || opt.blankLp == null;
  m.start();
  sched.runUntil(() => {
    if (!blankLpSet && m.round >= 1 && m.phase !== 'BAND_DRAFT' && m.phase !== 'INFO_CHECK' && m.phase !== 'LOBBY') {
      const bp = m.players.get(`hu_${blank}`);
      if (bp) { bp.lp = Number(opt.blankLp); bp.dirty?.(); }
      blankLpSet = true;
    }
    const key = `${m.phase}:${m.round}`;
    if (key !== last) {
      last = key;
      if (m.phase === 'SETTLE' || (m.phase === 'RESULT' && (m.round === m.gd.bossRound || m.round === m.gd.hiddenRound))) {
        const row = { r: m.round, unite: !!m.unitePlan, p: {} };
        if (m.unitePlan) row.uh = { h: m.unitePlan.helpers.map((p) => p.playerId), l: m.unitePlan.leakers.map((p) => p.playerId), n: m.unitePlan.leaked.length };
        for (const ps of m.order) {
          const res = m.lastResults.get(ps.playerId);
          const bonds = {};
          for (const [id, b] of Object.entries(ps.bonds || {})) if (b.active) bonds[id] = [b.tier, Math.round(ps.layers?.[id] || 0)];
          row.p[ps.playerId] = {
            lp: ps.lp, alive: ps.alive, lv: ps.shop.level, u: ps.deployCount,
            k: res ? res.killed : null, t: res ? res.total : null,
            lk: res ? (res.leaked || []).filter((l) => l.counted !== false).length : null,
            perf: res ? res.perfect !== false : null, bonds, band: ps.bandId,
            elites: ps.allChess ? ps.allChess().filter((c) => data.chess[c.id]?.isGolden).length : null,
            chess: ps.board ? [...ps.board.values()].filter((p) => p.kind === 'chess').map((p) => p.id) : [],
            tele: ps._tele?.[m.round] || null,
            lkKeys: res ? (res.leaked || []).filter((l) => l.counted !== false).reduce((o, l) => { o[l.enemyKey] = (o[l.enemyKey] || 0) + 1; return o; }, {}) : null,
          };
        }
        if (m.teamLp != null) row.teamLp = m.teamLp;
        if (m.bossPool) row.boss = [Math.round(m.bossPool.hp), m.bossPool.maxHp];
        rounds.push(row);
      }
    }
    return summary != null;
  }, { maxSteps: 5e6 });
  const res = {
    seed, difficulty, stage: m.stageId, boss: m.bossId, win: !!summary?.victory, rp: summary?.roundsPassed ?? null,
    reason: summary?.reason ?? 'stuck', hidden: !!summary?.hiddenReached,
    players: (summary?.players || []).map((p) => ({ band: p.bandId, rp: p.roundsPassed, dmg: p.stats?.dmgDealt, kills: p.stats?.kills, merges: p.stats?.merges, gold: p.stats?.gold })),
    rounds, errors: errors.length + (m.errorCount || 0), simErrors: m.simErrors || 0, ms: Date.now() - t0,
  };
  m.dispose();
  return res;
}

for (const s of seeds) {
  let r;
  try { r = runOne(s); } catch (e) { r = { seed: s, difficulty, crash: String(e && e.stack || e).slice(0, 2000) }; }
  const line = JSON.stringify(r) + '\n';
  if (out != null) fs.writeSync(out, line); else process.stdout.write(line);
}
if (out != null) fs.closeSync(out);
