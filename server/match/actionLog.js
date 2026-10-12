// server/match/actionLog.js — per-match record of every human action plus board snapshots (玩家操作记录).
//
// Purpose: collect real players' decisions (buy / sell / refresh / level / place / equip / band and card picks / ready)
// in the state they were made, as training and comparison material for the AI teammates. Pure bookkeeping: it reads
// the match, never changes it, and every hook is wrapped so a failure here can never affect play.
//
// Layout (JSON, written by the lobby at match end to logs/actionlogs/<id>.json; GET /api/actionlog/<id>.json):
//   { version, id, meta: { roomCode, matchNo, seed, mode, difficulty, stageId, bossId, startedAt, seats },
//     events: [ { i, t /* match ms */, wall, pid, round, phase, msg, pre?, ok, err? } ],
//     snapshots: [ { kind: 'prepStart'|'prepEnd'|'final', round, t, players: { [pid]: PlayerSnapshot } } ],
//     result: { victory, roundsPassed, reason } | null }
// PlayerSnapshot: { isBot, alive, lp, funds, band, level, upgradePrice, freeRefreshes, frozen, shop: [...],
//   hand: [...], temp: [...], board: { 'r,c': {...} }, bonds: { id: [tier, count, layers] }, offers, last? }
// `last` (prepStart only): the player's previous combat — { leaked, killed, perfect }.
// Messages that are not decisions (battle progress, emotes, watching, stats queries, pause) are not recorded.

export const ACTION_LOG_VERSION = 1;
const SKIP = new Set(['b.progress', 'b.result', 'g.emote', 'g.watch', 'g.unitStats', 'g.pause']);
const MAX_EVENTS = 20000;

function pieceView(p) {
  if (!p) return null;
  const v = { kind: p.kind, id: p.id, uid: p.uid };
  if (p.kind === 'chess' && Array.isArray(p.items) && p.items.length) v.items = p.items.map((it) => it.id);
  if (p.kind === 'token') { v.owner = p.ownerUid ?? null; if ((p.count || 1) > 1) v.count = p.count; }
  if (p.dir) v.dir = p.dir;
  return v;
}

/** Plain-data snapshot of one player's decision state. */
export function snapshotPlayer(m, ps) {
  const board = {};
  for (const [k, p] of ps.board || []) board[k] = pieceView(p);
  const bonds = {};
  for (const [id, b] of Object.entries(ps.bonds || {})) {
    if (!b || !(b.count > 0)) continue;
    bonds[id] = [b.tier || 0, b.count || 0, Math.round((ps.layers && ps.layers[id]) || b.layers || 0)];
  }
  const shop = ps.shop || {};
  return {
    isBot: !!ps.isBot, alive: ps.alive !== false, lp: ps.lp, funds: ps.funds, band: ps.bandId || null,
    level: shop.level ?? null, upgradePrice: shop.upgradePrice ?? null, freeRefreshes: shop.freeRefreshes ?? 0, frozen: !!shop.frozen,
    shop: (shop.slots || []).map((s) => (s ? { kind: s.kind, id: s.id, price: typeof ps.priceOf === 'function' ? ps.priceOf(s) : s.price, sold: !!s.sold } : null)),
    hand: (ps.hand || []).map(pieceView), temp: (ps.temp || []).map(pieceView), board, bonds,
    offers: (ps.offers || []).map((o) => ({ source: o.source, tier: o.tier, slots: (o.slots || []).map((s) => ({ kind: s.kind, id: s.id, sold: !!s.sold })) })),
  };
}

export class ActionLog {
  /** @param {import('./Match.js').Match} m */
  constructor(m, { roomCode = '', matchNo = null, seed = null } = {}) {
    this.m = m;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    this.id = `${stamp}_${String(roomCode || 'room').replace(/[^A-Za-z0-9]/g, '')}_m${matchNo ?? 0}`;
    this.meta = { roomCode, matchNo, seed, mode: m.mode ?? null, difficulty: m.difficulty ?? null, startedAt: Date.now(), seats: [] };
    this.events = [];
    this.snapshots = [];
    this.result = null;
    this._lastSnapKey = '';
  }

  hasHumans() { return this.m.order.some((p) => !p.isBot); }

  /** Context resolved BEFORE an action runs (what was clicked: the piece, the shop slot, the target). */
  pre(ps, msg) {
    try {
      const out = {};
      if (Number.isInteger(msg.uid)) {
        const loc = ps.find(msg.uid);
        if (loc) out.piece = { id: loc.piece.id, kind: loc.piece.kind, area: loc.area, key: loc.key, idx: loc.idx };
      }
      if (msg.t === 'g.buy' && Number.isInteger(msg.idx ?? msg.slot)) {
        const s = ps.shop?.slots?.[msg.idx ?? msg.slot];
        if (s) out.slot = { kind: s.kind, id: s.id, price: typeof ps.priceOf === 'function' ? ps.priceOf(s) : s.price };
      }
      if (msg.t === 'g.equip' && Number.isInteger(msg.targetUid)) {
        const loc = ps.find(msg.targetUid);
        if (loc) out.target = { id: loc.piece.id, area: loc.area, key: loc.key };
      }
      if (msg.t === 'g.reward' && Number.isInteger(msg.idx)) {
        const o = ps.offers?.[0];
        const s = o?.slots?.[msg.idx];
        if (s) out.reward = { source: o.source, id: s.id, kind: s.kind, options: o.slots.map((x) => x.id) };
      }
      if (msg.t === 'g.choice' && this.m.sp && Number.isInteger(msg.idx)) {
        const c = this.m.sp.cards?.[msg.idx];
        if (c) out.card = { id: c.id, kind: c.kind };
      }
      out.funds = ps.funds;
      return out;
    } catch { return null; }
  }

  record(ps, msg, res, pre) {
    try {
      if (!msg || SKIP.has(msg.t) || this.events.length >= MAX_EVENTS) return;
      this.snapIfNew('prepStart');
      const ok = !(res && typeof res === 'object' && res.error);
      const ev = { i: this.events.length, t: this.m.sched?.now?.() ?? null, wall: Date.now(), pid: ps.playerId, round: this.m.round, phase: this.m.phase, msg: { ...msg }, ok };
      if (pre) ev.pre = pre;
      if (!ok) ev.err = res.error;
      if (ok && msg.t !== 'g.ready') ev.after = { funds: ps.funds, level: ps.shop?.level };
      this.events.push(ev);
    } catch { /* bookkeeping only */ }
  }

  /** Snapshot all players (once per round/kind). */
  snap(kind) {
    try {
      const key = `${kind}:${this.m.round}`;
      if (key === this._lastSnapKey) return;
      this._lastSnapKey = key;
      if (!this.meta.seats.length) this.meta.seats = this.m.order.map((p) => ({ seat: p.seat, pid: p.playerId, name: p.name, isBot: !!p.isBot }));
      if (this.meta.stageId == null) { this.meta.stageId = this.m.stageId ?? null; this.meta.bossId = this.m.bossId ?? null; }
      if (this.meta.mode == null) { this.meta.mode = this.m.mode ?? null; this.meta.difficulty = this.m.difficulty ?? null; }
      const players = {};
      for (const ps of this.m.order) {
        const s = snapshotPlayer(this.m, ps);
        if (kind === 'prepStart') {
          const r = this.m.lastResults?.get?.(ps.playerId);
          if (r) s.last = { leaked: (r.leaked || []).filter((l) => l && l.counted !== false).length, killed: r.killed ?? null, perfect: r.perfect !== false };
        }
        players[ps.playerId] = s;
      }
      this.snapshots.push({ kind, round: this.m.round, t: this.m.sched?.now?.() ?? null, players });
    } catch { /* bookkeeping only */ }
  }

  snapIfNew(kind) { if (this.m.phase === 'PREP') this.snap(kind); }

  finish(outcome, result) {
    try {
      this.snap('final');
      this.result = { victory: !!outcome?.victory, roundsPassed: result?.roundsPassed ?? null, reason: outcome?.reason ?? null };
    } catch { /* bookkeeping only */ }
  }

  toJSON() {
    return { version: ACTION_LOG_VERSION, id: this.id, meta: this.meta, events: this.events, snapshots: this.snapshots, result: this.result };
  }
}
