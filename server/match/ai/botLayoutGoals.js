// server/match/ai/botLayoutGoals.js — the objectives of the one-click 「AI站位」 (g.autoArrange { goal, bench }).
//
// The default AI layout (bot.js rehearse) ranks candidate layouts by a rehearsal of this round's enemies: fewest leaks,
// then kills. A human asking for a layout may want something else, so the recommendation can rank the same rehearsed
// candidates by one of three goals:
//
//   combat  战斗力优先 — weighted leaks: a leaked bounty enemy (赏金怪) counts BOUNTY_LEAK_WEIGHT normal enemies, then
//                       kills. Bounty enemies are the ones the player paid for; leaking one also loses its payout.
//   layers  叠层优先   — bond layers this layout yields: the rehearsal's in-battle gains plus what the position-dependent
//                       特质 of this prep end (SERVER_PREP_FIN) and of the next prep start (SERVER_PREP_START) add.
//   economy 经济优先   — funds-equivalent income of the next round: battle bounty coins, perfect-payout bounties, 特质
//                       funds, free refreshes, equipment and operators gained (e.g. 歌蕾蒂娅's same-row 斯卡蒂/幽灵鲨/
//                       深巡, valued by price plus a 三合一 bonus when it completes a merge), and the funds the layers
//                       turn into: 远见 (2 per 10 layers), 奇迹 (20 per 100 layers plus its free-refresh chance).
//
// Leaks always remain the tiebreak of layers / economy, so equal yields prefer the safer layout.
//
// The 特质 part is a dry run of the real garrison handlers (content/garrisons) with the candidate layout applied: the
// context is the real makeCtx with every mutating method replaced by a recorder, so the handlers' own conditions
// (front / behind tile, same row, in-board, bond active, counters) decide, nothing in the match changes and no match
// RNG is consumed (rolls use a private generator, chess rolls are valued by their pool's expectation).

import { boardOrder } from '../board.js';
import { makeCtx, GARRISON_HOOK } from '../effectsMeta.js';
import { createRng } from '../../sim/rng.js';
import { layerGainRoom } from '../../../shared/constants.js';

export const LAYOUT_GOALS = Object.freeze(['combat', 'layers', 'economy']);
export const BOUNTY_LEAK_WEIGHT = 12;
const ITEM_FUNDS = 3; // one piece of equipment ≈ 3 funds (a tier-2 shop item)
const ROLL_SAMPLES = 16;

/** Normalised goal id ('combat' when unknown). */
export function layoutGoal(goal) {
  return LAYOUT_GOALS.includes(goal) ? goal : 'combat';
}

/** Is a leak entry of a battle result a bounty enemy (赏金怪)? */
export function isBountyLeak(l) {
  if (!l) return false;
  if (l.tag === 'bounty') return true;
  const mods = l.mods || {};
  return mods.bountyId != null || Number(mods.bountyCoins) > 0;
}

/** Leaks of one player's rehearsal result: { counted, bounty, weighted }. */
export function leakSummary(pp) {
  let counted = 0, bounty = 0;
  for (const l of (pp && pp.leaked) || []) {
    if (!l || l.counted === false) continue;
    counted++;
    if (isBountyLeak(l)) bounty++;
  }
  return { counted, bounty, weighted: counted - bounty + bounty * BOUNTY_LEAK_WEIGHT };
}

// ---------------------------------------------------------------------------------------------------------------------
// dry run of the prep-time 特质

const READ_ONLY = new Set(['hook', 'source', 'playerId', 'seat', 'name', 'round', 'phase', 'modeId', 'difficulty', 'isSolo',
  'isCoop', 'data', 'gd', 'log', 'funds', 'lp', 'alive', 'bandId', 'teamMedicGranted', 'shopLevel', 'bond', 'bonds',
  'bondActive', 'bondCount', 'layers', 'board', 'hand', 'temp', 'piece', 'pieceAt', 'chessRecord', 'pieceBonds',
  'garrisonsOf', 'stats', 'roundStats', 'shopSlots', 'pieceCounter', 'effect']);

function emptyRecord() {
  return { layers: {}, funds: 0, refresh: 0, items: [], chess: [], handlers: 0 };
}

/**
 * What the prep-time 特质 of `ps`'s current board and hand would give: { layers: {bondId: n}, funds, refresh,
 * items: [itemId | {alts}], chess: [{ id, golden, alts? }] }. `hooks`: the dispatcher hooks to run, in order (default
 * this prep end, then the next prep start). Never mutates the match.
 */
export function dryRunPrepTraits(m, ps, { hooks = ['onPrepEnd', 'onRoundStart'] } = {}) {
  const rec = emptyRecord();
  const disp = m.dispatcher;
  if (!disp || !disp.registry || !ps) return rec;
  const gd = ps.gd || m.gd;
  const rng = createRng(0x5eed ^ ((m.round || 0) * 977) ^ ((ps.seat || 0) * 131));
  const layersNow = { ...(ps.layers || {}) };
  const counters = Object.create(null);
  const rolled = new Map(); // rolled id → alternatives (expectation of the roll)
  let depth = 0;
  // the private-RNG view of the match the roll helpers run on (this.pool / this.gd / this.itemPool via the prototype)
  const rollView = Object.create(m, { rngMeta: { value: rng } });

  const recorder = (base, source, hook) => {
    const c = Object.create(null);
    for (const k of Object.keys(base)) {
      const d = Object.getOwnPropertyDescriptor(base, k);
      if (READ_ONLY.has(k)) Object.defineProperty(c, k, d);
      else if (typeof d.value === 'function') c[k] = () => null;
      else Object.defineProperty(c, k, d);
    }
    c.rng = rng;
    c.counter = (k) => (k in counters ? counters[k] : Number.isFinite(ps.counters?.[k]) ? ps.counters[k] : 0);
    c.setCounter = (k, v) => { if (typeof k === 'string' && Number.isFinite(v)) counters[k] = v; return c.counter(k); };
    c.incCounter = (k, n = 1) => { if (typeof k !== 'string' || !Number.isFinite(n)) return 0; counters[k] = c.counter(k) + n; return counters[k]; };
    c.incPieceCounter = (uid, k, n = 1) => { const key = `#${uid}:${k}`; counters[key] = (counters[key] || 0) + n; return (base.pieceCounter(uid, k) || 0) + counters[key]; };
    c.pieceCounter = (uid, k) => (base.pieceCounter(uid, k) || 0) + (counters[`#${uid}:${k}`] || 0);
    c.addFunds = (n) => { const v = Math.trunc(Number(n) || 0); if (v > 0) rec.funds += v; return v > 0 ? v : 0; };
    c.addPendingFunds = (n) => { const v = Math.trunc(Number(n) || 0); if (v > 0) rec.funds += v; return v > 0 ? v : 0; };
    c.spendFunds = () => false;
    c.grantFreeRefresh = (n = 1) => { const v = Math.trunc(Number(n) || 0); if (v > 0) rec.refresh += v; return (ps.shop?.freeRefreshes || 0) + rec.refresh; };
    c.addLayers = (bondId, n, opts = {}) => {
      if (!gd.bond(bondId) || !Number.isFinite(n) || n <= 0) return 0;
      if (opts.requireActive && !(ps.bonds?.[bondId] && ps.bonds[bondId].active)) return 0;
      const before = layersNow[bondId] || 0;
      const add = layerGainRoom(before, Math.floor(n));
      if (add <= 0) return 0;
      layersNow[bondId] = before + add;
      rec.layers[bondId] = (rec.layers[bondId] || 0) + add;
      return add;
    };
    c.layers = (bondId) => (bondId == null ? { ...layersNow } : layersNow[bondId] || 0);
    c.grantChess = (chessId, opts = {}) => {
      let id = chessId;
      if (opts.golden) id = gd.goldenIdOf(chessId) || chessId;
      if (!gd.chess(id)) return null;
      rec.chess.push({ id, golden: !!opts.golden || gd.isGolden(id), alts: rolled.get(chessId) || null });
      return { uid: -1, kind: 'chess', id, items: [] };
    };
    c.grantItem = (itemId) => {
      if (!gd.item(itemId)) return null;
      rec.items.push(itemId);
      return { uid: -1, kind: 'item', id: itemId };
    };
    c.rollPool = (poolId, opts = {}) => {
      const roll = () => m.rollPool.call(rollView, poolId, { shopLevel: ps.shop?.level, chessOf: (id) => gd.chess(id), ...opts });
      const first = roll();
      if (first && first.kind === 'chess') {
        const alts = [first.id];
        for (let i = 1; i < ROLL_SAMPLES; i++) { const r = roll(); if (r && r.id) alts.push(r.id); }
        rolled.set(first.id, alts);
      }
      return first;
    };
    c.rollChess = (opts = {}) => {
      const f = (id) => {
        if (opts.bond) { const cr = gd.chess(id); if (!cr || !Array.isArray(cr.bonds) || !cr.bonds.includes(opts.bond)) return false; }
        return typeof opts.filter === 'function' ? !!opts.filter(id) : true;
      };
      const args = { maxTier: Number.isInteger(opts.maxTier) ? opts.maxTier : 6, tier: Number.isInteger(opts.tier) ? opts.tier : null, filter: f, ignoreCounts: opts.ignoreCounts === true };
      const first = m.pool.roll(rng, args);
      if (first) {
        const alts = [first];
        for (let i = 1; i < ROLL_SAMPLES; i++) { const r = m.pool.roll(rng, args); if (r) alts.push(r); }
        rolled.set(first, alts);
      }
      return first;
    };
    c.rollItem = (opts = {}) => m.rollItemId.call(rollView, opts);
    c.triggerGarrisons = (uid, eventType, opts = {}) => {
      const l = ps.find(uid);
      if (!l || l.piece.kind !== 'chess' || typeof eventType !== 'string') return 0;
      const as = opts.asUid != null ? ps.find(opts.asUid) : null;
      if (opts.asUid != null && (!as || as.piece.kind !== 'chess')) return 0;
      return runTriggered(l.piece, eventType, as ? as.piece : null, source.key || null);
    };
    c.teammates = () => [];
    c.player = () => null;
    c.hook = hook;
    c.source = source;
    return c;
  };

  const call = (h, hook, source, ev, repeat = 1) => {
    const fn = typeof h[hook] === 'function' ? h[hook] : source.kind === 'garrison' && typeof h.run === 'function' ? h.run : null;
    if (!fn) return;
    const ctx = recorder(makeCtx(m, ps, source, hook, ev), source, hook);
    for (let i = 0; i < repeat; i++) {
      try { fn.call(h, ctx, ev); rec.handlers++; } catch { /* a handler that cannot run on the dry context counts nothing */ }
    }
  };

  const runTriggered = (piece, eventType, asPiece, triggeredBy) => {
    const hook = eventType === 'SERVER_PRICE' ? null : GARRISON_HOOK[eventType];
    const cr = piece && piece.kind === 'chess' ? gd.chess(piece.id) : null;
    if (!hook || !cr || !Array.isArray(cr.garrisonIds) || depth >= 5) return 0;
    const self = asPiece || piece;
    let n = 0;
    depth++;
    try {
      for (const gid of cr.garrisonIds) {
        const g = gd.garrison(gid);
        if (!g || g.eventType !== eventType) continue;
        const key = `garrison:${g.effectKey}`;
        const h = disp.registry.get(key);
        if (!h) continue;
        const ev = hook === 'onGain' ? { piece: self, kind: 'chess', source: 'trigger' } : { round: m.round, trigger: true };
        const repeat = hook === 'onGain' && typeof disp.investRepeat === 'function' ? disp.investRepeat(ps) : 1;
        const loc = ps.find(self.uid);
        const where = loc ? (loc.area === 'board' ? 'board' : loc.area) : 'trigger';
        call(h, hook, { kind: 'garrison', key, piece: self, copiedFrom: asPiece ? piece : null, garrisonId: gid, garrison: g,
          bb: g.bb || {}, bbStr: g.bbStr || {}, where, trigger: true, triggeredBy }, ev, repeat);
        n++;
      }
    } finally { depth--; }
    return n;
  };

  const runPiece = (piece, where, hook) => {
    const cr = gd.chess(piece.id);
    if (!cr || !Array.isArray(cr.garrisonIds)) return;
    for (const gid of cr.garrisonIds) {
      const g = gd.garrison(gid);
      if (!g) continue;
      const key = `garrison:${g.effectKey}`;
      const h = disp.registry.get(key);
      if (!h || !disp._garrisonHooks(h, g).includes(hook)) continue;
      if (where === 'hand' && g.bbStr && g.bbStr.conditionkey === 'character_target_inboard') continue;
      call(h, hook, { kind: 'garrison', key, piece, garrisonId: gid, garrison: g, bb: g.bb || {}, bbStr: g.bbStr || {}, where },
        { round: hook === 'onRoundStart' ? (m.round || 0) + 1 : m.round });
    }
  };

  for (const hook of hooks) {
    for (const { piece } of boardOrder(ps.board)) if (piece && piece.kind === 'chess') runPiece(piece, 'board', hook);
    for (const p of ps.hand) if (p && p.kind === 'chess') runPiece(p, 'hand', hook);
  }
  return rec;
}

// ---------------------------------------------------------------------------------------------------------------------
// valuation

/** Funds-equivalent of gaining one chess `id` for `ps` (price, plus a 三合一 bonus when it completes / advances a merge). */
export function chessFundsValue(m, ps, id, extraCopies = 0) {
  const gd = ps.gd || m.gd;
  const c = gd.chess(id);
  if (!c) return 0;
  const price = Number(gd.chessPrice(id)) || 3;
  if (gd.isGolden(id)) return price * 3;
  const base = gd.baseIdOf(id);
  const need = Math.max(2, Number(gd.mergeCount?.(base)) || 3);
  const have = (ps.countCopies(base) || 0) + extraCopies;
  const r = have % need;
  if (r === need - 1) return price + price * 2; // completes an elite: worth well beyond its copies
  if (r > 0) return price + price * 0.4; // advances a merge
  return price;
}

function bondNumbers(gd, bondId, key) {
  const b = gd.bond(bondId);
  const buffs = b && Array.isArray(b.buffs) ? b.buffs : [];
  const f = buffs.find((x) => x && x.key === key);
  return f ? f.bb || {} : null;
}

/** Funds the bond layers `gains` turn into for `ps` (远见 / 奇迹), from its current layers. */
export function layerFunds(m, ps, gains) {
  const gd = ps.gd || m.gd;
  let funds = 0;
  for (const [bondId, n] of Object.entries(gains || {})) {
    if (!(n > 0)) continue;
    const bb = bondNumbers(gd, bondId, 'bond_layer_gain_coin');
    if (!bb) continue;
    const step = Number(bb.layer) || 0;
    const coin = Number(bb.count) || 0;
    if (!(step > 0) || !(coin > 0)) continue;
    const before = ps.layers?.[bondId] || 0;
    funds += (Math.floor((before + n) / step) - Math.floor(before / step)) * coin;
    // 奇迹: each layer also raises the chance that a refresh is free (prob per layer) — about 3 refreshes a round
    const nf = bondNumbers(gd, bondId, 'bond_refresh_shop_next_free');
    if (nf && Number(nf.prob) > 0) funds += n * Number(nf.prob) * 3 * (Number(gd.refreshPrice) || 1) * 4;
  }
  return funds;
}

/** Merge battle and prep layer gains, clamped to each bond's room under the cap. */
export function totalLayerGains(ps, battleGains, prepGains) {
  const out = {};
  for (const src of [battleGains, prepGains]) {
    for (const [bondId, n] of Object.entries(src || {})) {
      if (!(n > 0)) continue;
      out[bondId] = (out[bondId] || 0) + Math.floor(n);
    }
  }
  for (const bondId of Object.keys(out)) {
    const room = layerGainRoom(ps.layers?.[bondId] || 0, out[bondId]);
    if (room > 0) out[bondId] = room; else delete out[bondId];
  }
  return out;
}

/** Funds-equivalent of a dry-run record (without its layers). */
export function recordFunds(m, ps, rec) {
  const gd = ps.gd || m.gd;
  let v = (rec.funds || 0) + (rec.refresh || 0) * (Number(gd.refreshPrice) || 1);
  v += (rec.items || []).length * ITEM_FUNDS;
  const extra = new Map();
  for (const c of rec.chess || []) {
    const alts = Array.isArray(c.alts) && c.alts.length ? c.alts : [c.id];
    let s = 0;
    for (const id of alts) {
      const base = gd.baseIdOf(id);
      s += chessFundsValue(m, ps, c.golden ? gd.goldenIdOf(id) || id : id, extra.get(base) || 0);
    }
    v += s / alts.length;
    const b = gd.baseIdOf(c.id);
    if (!c.golden) extra.set(b, (extra.get(b) || 0) + 1);
  }
  return v;
}

/** Perfect-payout bounty coins (战术特训) this round's bounties pay when the phase has no counted leak. */
export function perfectBountyCoins(ps) {
  let n = 0;
  for (const b of ps.bounties || []) if (b && b.card && b.card.payout === 'perfect') n += Number(b.card.coin) || 0;
  return n;
}

/**
 * Score of one rehearsed candidate under `goal` (higher is better) and its metrics. `pp` = the player's rehearsal
 * result, `rec` = the dry run of this layout's prep 特质 (dryRunPrepTraits).
 */
export function goalScore(m, ps, goal, pp, rec) {
  const lk = leakSummary(pp);
  const killed = Number(pp && pp.killed) || 0;
  const layers = totalLayerGains(ps, pp && pp.layerGains, rec && rec.layers);
  const layerSum = Object.values(layers).reduce((a, b) => a + b, 0);
  const perfect = lk.counted === 0 && !(pp && pp.perfect === false);
  const coins = Math.max(0, Math.trunc(Number(pp && pp.coins) || 0)) + (perfect ? perfectBountyCoins(ps) : 0);
  const funds = coins + (rec ? recordFunds(m, ps, rec) : 0) + layerFunds(m, ps, layers);
  const metrics = { leaks: lk.counted, bountyLeaks: lk.bounty, killed, layers: layerSum, funds: Math.round(funds * 10) / 10 };
  // a layout whose leaks would end the player (LP loss = min(lpCapPerRound, counted leaks)) is never worth its yield
  const cap = Number(m.gd && m.gd.lpCapPerRound) || Infinity;
  const lethal = Number.isFinite(ps.lp) && lk.counted > 0 && Math.min(cap, lk.counted) >= ps.lp ? 1e9 : 0;
  let score;
  if (goal === 'layers') score = layerSum * 100 - lk.weighted * 2 + killed * 0.01 - lethal;
  else if (goal === 'economy') score = funds * 100 - lk.weighted * 2 + killed * 0.01 - lethal;
  else score = -lk.weighted * 10000 + killed * 10 + (layerSum + funds) * 0.01;
  return { score, metrics };
}
