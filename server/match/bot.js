// server/match/bot.js — AI player (DESIGN §6.6). Used for AI teammates and "AI 托管" (g.autoplay; a departed human
// is eliminated, Match._quit). Every action goes through the same validated
// PlayerState handlers a human uses; randomness only from the match's bot rng (deterministic per seed).
//
// It reads only what a player can see: its own state, the shop, and the round's enemy preview (composition and
// routes, research 06 §4.3 "查看当前回合即将迎击的敌方单位").
//
// Prep routine (botPrep):
//   1. take a pending reward offer (merge progress, bond synergy, tier)
//   2. sell bench chess that neither make the lineup nor build toward something (sellJunk), buy toward a full board
//      first (the deploy cap is 8 from round 1; leftover funds are lost at prep end), level the 调度中心 on a curve
//      (free levels always; the −1/round discount is waited for early), then keep buying / refreshing with what is
//      left: merge progress (pairs → elites) > bond thresholds (focus core bond, add-ons 2/3) > role needs
//      (blockers, anti-air when the wave flies, one or two healers) > tier; with a full board a buy must improve the
//      best lineup. Items only when a deployed operator can carry them. A merge that consumes a deployed copy leaves
//      the elite on that copy's tile (PRTS 卫戍协议/帮助, PlayerState._mergeChess): nothing here assumes it in the hand —
//      steps 3–4 plan it like any owned unit (kept, moved or benched).
//   3. lineup: the deployed set maximizes unit value + activated bond tiers (exact counting via computeBonds) +
//      composition (chooseLineup: greedy seed, single swaps, and bounded complementary support pairs).
//   4. placement (planLayout): the round's routes are traced over the own board from the enemy preview (ground
//      routes on the stage's device-aware ground paths, flying routes through their checkpoints; 近地悬浮 enemies walk
//      the ground path but count as flyers) and weighted by their enemies; an exposure model (tile time × DPS of the
//      covering units, blocker hold time, flyers only for anti-air) is maximized greedily — blockers first, then damage
//      dealers by DPS, then healers — over every
//      (legal tile, direction) pair: each unit's range grid is rotated per direction (DESIGN §3; RIGHT is tried first
//      and kept on ties, so symmetric ranges and melee units whose front adds nothing stay facing the gates), so
//      ranged units turn toward the enemy path tiles they cover best and blockers toward the road; on 气流 tiles
//      (act2 m01 blowers) the DPS is scaled by the blower ATK bonus of that direction (with / against / across). The last
//      arrangement of a prep REHEARSES up to m.botRehearsal roster/layout variants with the real Battle (rehearsal
//      seed, read-only team context, combat layers isolated inside Battle, board restored exactly) and keeps the
//      one with the fewest leaks. The default plan is
//      placed first; Match steps the rehearsal in wall-clock-bounded slices (botPrepBegin → job.run → botPrepEnd) so
//      whole simulated battles never block the server's event loop. The prep routine itself is sliced the same way:
//      botPrepBeginSteps / botPrepEndSteps (and planLayoutSteps, arrangeSteps, createRehearsalSteps) are step
//      generators that yield between whole actions (never with a transient board) — the same actions in the same
//      order as the one-shot functions (runSteps), hence the same rng draws and decisions.
//      The summon cards of the placed operators (赫默's 医疗探机, 伺夜's 狼群 …; user playtest #6) are placed after
//      them on the best remaining tiles, 凯瑟琳's 支援装置 next to the best operator no device faces yet, facing it.
//   5. allocate equipment by role, signatures, combinations and marginal replacement value; reinvest consumables.
//   6. resolve temp/reward slots, reserve an unaffordable merge copy with freeze, then Ready.
// Measured strength and known limitations are recorded in docs/AI-AUDIT.md (four-player ABYSS, no extra buffs/nerfs).

import { GEO } from '../../shared/constants.js';
import { deriveSeed } from '../sim/rng.js';
import { ASPD_MIN } from '../sim/constants.js';
import { freeSlot, legalTiles, canPlace, positionClass, parseKey, tileKey, FIELD, pieceDir, boardTileOf, BOSS_MIRROR_COL } from './board.js';
import { rotateOffset, normDir, mirrorDir, oppositeDir } from '../sim/dir.js';
import { itemKey } from './gamedata.js';
import { pieceBonds } from './bondsMeta.js';
import { resolveProfile } from '../sim/professions.js';
import { withBounties } from './waves.js';
import { HOVER_KEYS } from '../sim/content/enemies.js';
import { makeCtx } from './effectsMeta.js';
import { relayCarryValue, relayUpgradeWanted, createRelayRehearsal, relayDefenseValue } from './botTeam.js';
import { bandScore, bandBonds, corePlan, coreReserveValue, coreUpgradeWanted, economyRecruitValue, garrisons, lineupState, layerValue, traitValue, recurringValue, combatBondValue, combatRecord, benchValue, refreshValue, bestEquipmentTarget } from './botStrategy.js';

/**
 * Drive a step generator (planLayoutSteps, createRehearsalSteps, arrangeSteps, botPrepBeginSteps …) to its end in one
 * go and return its value — the synchronous form every step generator also has (tools, tests, botPrep).
 */
export function runSteps(gen) {
  let r;
  do r = gen.next(); while (!r.done);
  return r.value;
}

/** Shop level the bot aims for at the start of round r (index = round). */
const LEVEL_TARGET = [1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 6];
const TIER_POWER = [0, 10, 12.5, 15, 18, 21.5, 25];
const DEFAULT_MELEE_RANGE = [[0, 0], [0, 1]];

/**
 * Band pick: life buffer, recurring economy/layers, gift timing and faction availability. Softmax keeps seeded
 * variety; missing allies make early income suppression risky even in a one-seat co-op room.
 */
export function botPickBand(m, ps) {
  const ids = m.gd.bandIds().filter((id) => !m.bandTaken(id, ps.playerId));
  if (!ids.length) return m.gd.defaultBandId;
  const scores = ids.map((id) => [id, bandScore(m, ps, id)]);
  const top = Math.max(...scores.map(([, s]) => s));
  const pairs = scores.map(([id, s]) => [id, Math.exp((s - top) / (m.difficulty === 'ABYSS' ? 2 : 7))]);
  let total = 0;
  for (const [, w] of pairs) total += w;
  let r = m.rngBots() * total;
  for (const [id, w] of pairs) { r -= w; if (r < 0) return id; }
  return pairs[pairs.length - 1][0];
}

/** 机变 card pick among the untaken indexes: items and team buffs first; bounties (extra enemies) last. */
export function botPickCard(m, ps, cards, available) {
  let best = available[0];
  let bestScore = -Infinity;
  for (const i of available) {
    const c = cards[i];
    if (!c) continue;
    let s = 0;
    if (c.kind === 'item') s = m.gd.item(c.id) ? (bestEquipmentTarget(m, ps, c.id, ps.allChess())?.score || 0) : 8 + (c.tier || 1) * 4;
    else if (c.kind === 'bounty') s = (c.payout === 'kill' ? 4 : 2) + (c.coin || 0) - (c.tier || 1) * 2 - Math.max(0, (c.count || 1) - 1) - (c.rounds >= 90 ? 4 : 0);
    else if (c.kind === 'tactic') {
      s = (c.team ? 12 : 8) + (c.tacticKind === 'ally' ? 4 : 0);
      for (const buff of m.gd.effect(c.effectId)?.buffs || []) {
        const p = { ...buff.bb, ...buff.bbStr };
        if (buff.key === 'global_special_choice_bond_addlayer') {
          const ids = String(p.bond_list || '').split(',');
          s = ids.reduce((n, id) => n + layerValue(m, ps, id, p.count), 0) * 2;
          if (c.team) for (const mate of m.order) if (mate !== ps && mate.alive) s += ids.reduce((n, id) => n + layerValue(m, mate, id, p.count), 0);
        } else if (buff.key === 'global_special_choice_gain_coin') s += (p.count || 0) * 2;
        else if (buff.key === 'global_special_choice_refresh_free') s += (p.count || 0) * 2;
      }
    }
    if (c.kind === 'bounty' && ps.lp < m.gd.startLp(ps.bandId) * 0.4) s -= 10 + (c.count || 1) * 2;
    s += m.rngBots() * 0.5;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------
// evaluation helpers

const chessRec = (m, id) => m.gd.chess(id);
const isHealer = (c) => !!c && (c.dmgType === 'heal' || c.attackKind === 'heal');
const isBlocker = (c) => !!c && positionClass(c) === 'melee' && (c.stats?.blockCnt ?? 1) > 0 && c.attackKind !== 'none';
/** 近地悬浮 enemies walk a ground route but are air units (no block, anti-air only — DESIGN §19). */
const HOVER = new Set(HOVER_KEYS);
const hitsFly = (c) => !!c && !!c.canHitFly && !isHealer(c) && c.attackKind !== 'none';

/** Distinct owned members per bond (board + hand + temp), and per-bond member sets. */
function ownedBonds(m, ps, exclude = null) {
  const counts = new Map();
  const seen = new Set();
  for (const p of ps.allChess()) {
    if (exclude && p.uid === exclude) continue;
    const base = m.gd.baseIdOf(p.id);
    if (seen.has(base)) continue;
    seen.add(base);
    const c = chessRec(m, p.id);
    for (const b of (c && c.bonds) || []) counts.set(b, (counts.get(b) || 0) + 1);
  }
  return { counts, bases: seen };
}

/** Core direction follows the opening strategy, distinct recruits, layers and current shop access. */
function focusBond(m, ps) {
  return corePlan(m, ps)?.id || null;
}

/** Role census of the owned chess. */
function roles(m, ps) {
  const r = { blockers: 0, antiAir: 0, healers: 0, total: 0 };
  for (const p of ps.allChess()) {
    const c = chessRec(m, p.id);
    if (!c) continue;
    r.total++;
    if (isBlocker(c)) r.blockers++;
    if (hitsFly(c)) r.antiAir++;
    if (isHealer(c)) r.healers++;
  }
  return r;
}

/** Bond value of adding chess `c` to what is owned (owned counts exclude it). */
function bondValue(m, c, owned, focus) {
  let v = 0;
  for (const b of (c && c.bonds) || []) {
    const bond = m.gd.bond(b);
    if (!bond || m.gd.modeInactiveBonds.has(b)) continue;
    const n = owned.counts.get(b) || 0;
    const th = Array.isArray(bond.thresholds) && bond.thresholds.length ? bond.thresholds : [bond.activeCount || 2];
    const w = b === focus ? 2.2 : bond.isCore ? 1.1 : 0.7;
    v += (2 + n * 2) * w;
    if (th.includes(n + 1)) v += 10 * w;
    else if (th.some((t) => t > n + 1 && t - (n + 1) <= 1)) v += 3 * w;
    if (bond.thresholdTemplate === 'count_threshold_downward') v -= n > 0 ? 12 : 0; // 独行 breaks with a second member
    if (b === focus) v += 18;
  }
  return v;
}

/**
 * Power of a chess record. Base stats barely grow with the tier (research 03: T1 E1 Lv55 … T6 E2 Lv1); higher tiers
 * bring better skills and talents, elites (精锐) +25 % stats and skill level 7 — so the tier weight is modest and the
 * elite weight large.
 */
function power(c) {
  if (!c) return 0;
  const p = TIER_POWER[Math.max(1, Math.min(6, c.tier || 1))];
  return c.isGolden ? p * 1.9 : p;
}

/**
 * Fit against the current enemy preview (defenses, air proportion, and multi-target attack profiles).
 */
function waveFit(c, model) {
  if (!c || isHealer(c) || c.attackKind === 'none') return 0;
  const routes = model.routes;
  const total = routes.reduce((n, r) => n + r.n, 0) || 1;
  const effectiveness = routes.reduce((n, r) => n + r.n * (r.fly && !hitsFly(c) ? 0 : damageRatio(c, r) * crowdMultiplier(c, r)), 0) / total;
  return Math.max(-5, Math.min(7, (effectiveness - 0.65) * 9));
}

/** Stand-alone value of an owned piece (no bond context): power, items, role fit, layer engines. */
function unitBase(m, piece, ctx) {
  const c = chessRec(m, piece.id);
  if (!c) return 0;
  let v = power(c) + (piece.items ? piece.items.length * 5 : 0);
  v += waveFit(c, ctx.model);
  if (c.attackKind === 'none' && !isHealer(c)) v -= 6;
  if (ctx.fly > 0 && hitsFly(c)) v += 2;
  return v;
}

/** Value of an owned piece for bench / sell decisions (its bonds counted against the other owned chess). */
function pieceValue(m, ps, piece, ctx) {
  const c = chessRec(m, piece.id);
  if (!c) return 0;
  return unitBase(m, piece, ctx) + bondValue(m, c, ownedBonds(m, ps, piece.uid), ctx.focus) * 0.8 + recurringValue(m, ps, piece);
}

/**
 * Score of a deployed set: unit values + the bonds it activates (exact tiers via bondsMeta.computeBonds, hand
 * members still count for BOARD_AND_DECK bonds) + composition (blockers, anti-air when the wave flies, ≤ 2 healers).
 */
function lineupScore(m, ps, set, ctx, projected = null) {
  const gd = m.gd;
  const { board, hand, bonds } = projected || lineupState(m, ps, set);
  let v = 0;
  for (const p of set) v += unitBase(m, p, ctx) + Math.min(10, recurringValue(m, ps, p, { board, hand, bonds }));
  for (const p of hand) if (p.kind === 'chess') v += recurringValue(m, ps, p, { board, hand, bonds, bench: true });
  for (const [id, b] of Object.entries(bonds)) {
    if (!b.tier) continue;
    const bond = gd.bond(id);
    const w = id === ctx.focus ? 20 : bond?.isCore ? 8 : 2;
    v += b.tier * w;
  }
  if (ctx.focus) {
    const state = bonds[ctx.focus], target = ps._botCore?.target || 3;
    v += Math.min(target, state?.count || 0) * 3;
    if (state?.count >= target && target > 3) v += 35;
  }
  v += combatBondValue(m, set, bonds, ps);
  let blockers = 0;
  let air = 0;
  let healers = 0;
  for (const p of set) { const c = chessRec(m, p.id); if (isBlocker(c)) blockers++; if (hitsFly(c)) air++; if (isHealer(c)) healers++; }
  const groundRoutes = ctx.model.routes.filter((r) => !r.fly);
  const lanes = new Set(groundRoutes.map((r) => r.tiles.at(-1))).size;
  v -= Math.max(0, Math.min(Math.max(1, lanes), 3, ctx.roles.blockers) - blockers) * 15;
  const flyRatio = ctx.fly / Math.max(1, ctx.model.routes.reduce((n, r) => n + r.n, 0));
  if (ctx.fly > 0) v -= Math.max(0, Math.min(ctx.roles.antiAir, flyRatio > 0.45 ? 3 : 2) - air) * 13;
  if (blockers >= 2 && ctx.roles.healers > 0 && healers === 0) v -= 10;
  v -= Math.max(0, healers - 2) * 10;
  return v;
}

/** A pair of supports can activate a useful addon although either single swap loses power.
 * Try at most one pair per board-counted addon and all outgoing pairs (8 choose 2 at normal cap).
 * Evaluate the actual beneficiaries, layers, wave roles and core together; preserve activation of the established focus core.
 */
function bestSupportSwap(m, ps, set, bench, ctx, floor, required = null) {
  if (set.length < 2 || bench.length < 2) return null;
  const current = lineupState(m, ps, set);
  const ranked = bench.slice().sort((a, b) => pieceValue(m, ps, b, ctx) - pieceValue(m, ps, a, ctx) || a.uid - b.uid);
  let best = null;
  for (const id of m.gd.bondIds) {
    const rec = m.gd.bond(id);
    if (rec.isCore || rec.countMode !== 'BOARD' || m.gd.modeInactiveBonds.has(id)
      || (current.bonds[id]?.tier || 0) >= (rec.thresholds?.length || 1)) continue;
    const members = ranked.filter(p => pieceBonds(m.gd, p).includes(id));
    const a = required == null ? members[0] : members.find(p => p.uid === required);
    const b = a && members.find(p => p.uid !== a.uid && m.gd.baseIdOf(p.id) !== m.gd.baseIdOf(a.id));
    if (!a || !b) continue;
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
      const trial = set.slice(); trial[i] = a; trial[j] = b;
      const state = lineupState(m, ps, trial);
      if ((state.bonds[id]?.tier || 0) <= (current.bonds[id]?.tier || 0)) continue;
      if (ctx.focus && current.bonds[ctx.focus]?.active && !state.bonds[ctx.focus]?.active) continue;
      const score = lineupScore(m, ps, trial, ctx, state);
      if (score > floor + 0.5 && (!best || score > best.score)) best = { set: trial, score };
    }
  }
  return best;
}

/** Best deployable set of at most `cap` owned chess: greedy seed + swap hill-climbing on lineupScore. */
function chooseLineup(m, ps, ctx) {
  const all = ps.allChess();
  const cap = Math.min(ps.deployCap, all.length);
  const seed = all.slice().sort((a, b) => pieceValue(m, ps, b, ctx) - pieceValue(m, ps, a, ctx) || a.uid - b.uid);
  let set = seed.slice(0, cap);
  let bench = seed.slice(cap);
  let score = lineupScore(m, ps, set, ctx);
  for (let iter = 0; iter < 12 && bench.length; iter++) {
    let best = null;
    for (let i = 0; i < set.length; i++) {
      for (let j = 0; j < bench.length; j++) {
        const trial = set.slice();
        trial[i] = bench[j];
        const s = lineupScore(m, ps, trial, ctx);
        if (s > score + 0.5 && (!best || s > best.s)) best = { i, j, s };
      }
    }
    if (!best) break;
    const out = set[best.i];
    set[best.i] = bench[best.j];
    bench[best.j] = out;
    score = best.s;
  }
  const support = bestSupportSwap(m, ps, set, bench, ctx, score);
  if (support) {
    set = support.set; score = support.score;
    const selected = new Set(set.map(p => p.uid));
    bench = all.filter(p => !selected.has(p.uid));
  }
  return { set, bench, score };
}

/** Shop / reward score of acquiring one copy of chess `id` (0 = not worth it). */
function buyScore(m, ps, id, ctx) {
  const gd = m.gd;
  const c = chessRec(m, id);
  if (!c) return 0;
  let s = power(c) * 0.6;
  const probe = { id, kind: 'chess', items: [] };
  s += waveFit(c, ctx.model) + Math.min(12, recurringValue(m, ps, probe)) + traitValue(m, ps, probe, ['SERVER_GAIN'])
    + Math.min(20, economyRecruitValue(m, ps, id));
  const base = gd.baseIdOf(id);
  if (!c.isGolden) {
    const copies = ps.countCopies(base);
    const need = gd.mergeCount(base) || 3;
    if (copies > 0) s += copies + 1 >= need ? 36 : 10;
  }
  if (!ctx.owned.bases.has(base)) s += bondValue(m, c, ctx.owned, ctx.focus);
  // role needs
  if (isBlocker(c) && ctx.roles.blockers < 2) s += 10;
  if (hitsFly(c) && ctx.fly > 0 && ctx.roles.antiAir < 2) s += 8;
  if (isHealer(c)) s += ctx.roles.healers === 0 && m.round >= 3 ? 6 : ctx.roles.healers >= 2 ? -14 : -3;
  if (c.attackKind === 'none' && !isHealer(c)) s -= 4;
  return s;
}

// ---------------------------------------------------------------------------------------------------
// field model: where the round's enemies walk / fly over the own board, and an exposure model of a layout

const inRect = (r, c) => r >= FIELD.r0 && r <= FIELD.r1 && c >= 0 && c <= FIELD.c1;

/** Integer tiles along a polyline of [row, col] points (inclusive, consecutive duplicates removed). */
function traceLine(points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [r0, c0] = points[i];
    const [r1, c1] = points[i + 1];
    const n = Math.max(1, Math.abs(r1 - r0), Math.abs(c1 - c0));
    for (let k = 0; k <= n; k++) {
      const t = [Math.round(r0 + ((r1 - r0) * k) / n), Math.round(c0 + ((c1 - c0) * k) / n)];
      const last = out[out.length - 1];
      if (!last || last[0] !== t[0] || last[1] !== t[1]) out.push(t);
    }
  }
  return out;
}

/** Boss field → own board: board.js boardTileOf (board rows 9–12 are boss rows 2–5; the right side mirrored). */
const BOSS_MID_COL = 10;
/** Dwell (s) the planner assumes on a leader's first own tiles (several leaders fight from their spawn point). */
const BOSS_DWELL = 30;
/** A leader is modeled as LEADER_WEIGHT enemies of LEADER_HP each (its route draws the damage dealers). */
const LEADER_WEIGHT = 10;
const LEADER_HP = 40000;

/** The boss-round wave of a player's group and its side ('L' | 'R'), or null (Match.bossGroupOf). */
function bossWaveOf(m, ps) {
  const g = typeof m.bossGroupOf === 'function' ? m.bossGroupOf(ps) : null;
  return g && g.wave ? { wave: g.wave, side: g.side } : null;
}

/**
 * The round's routes over the own board (cached per round): [{ n, fly (air units: flyers, and the 近地悬浮 HOVER_KEYS
 * on their ground path), tiles: ['r,c'…] (gate → objective, own region only, objective tile excluded), tileTime (s per
 * tile), hp }], a tile → [[route, index]] index, and the
 * aggregated ground flow per tile. Built from the wave preview (spawn counts per route, enemy HP / speed with the
 * round's multipliers). Boss rounds (pass `ps`): the player's boss-field template mapped onto the own board (rows −7,
 * the right player's half mirrored; only the routes that end on the player's half), the leader weighted heavily with
 * a dwell on its first tiles so damage dealers reach it; missing data falls back to every ground path from the own
 * gates.
 */
export function fieldModel(m, ps = null) {
  const boss = m.wave ? null : bossWaveOf(m, ps);
  const wave = m.wave || (boss && boss.wave);
  const cacheKey = `${m.round}|${m.stageId}|${wave ? wave.templateId : 'boss'}|${boss ? boss.side : ''}|${ps?.playerId || ''}|${JSON.stringify(ps?.bounties || [])}`;
  if (m._botPath && m._botPath.key === cacheKey) return m._botPath;
  const gd = m.gd;
  const st = m.stage;
  const gpaths = (st && (st.groundPathsWithDevices || st.groundPaths)) || {};
  const routesOut = [];
  const toBoard = boss
    ? ([r, c]) => boardTileOf(boss.side === 'R' ? 'bossR' : 'bossL', r, c)
    : (p) => p;
  const pushRoute = (tilesRC, n, fly, hp, speed, dwell = 0, threat = {}) => {
    const own = tilesRC.map(toBoard).filter(([r, c]) => inRect(r, c)).map(([r, c]) => tileKey(r, c));
    if (own.length > 1) own.pop(); // the objective / last tile: an enemy there has already leaked
    if (!own.length) return;
    const tileTime = Math.max(0.4, Math.min(6, 1 / Math.max(0.05, speed * 0.5)));
    routesOut.push({ n, fly, tiles: own, tileTime, hp: Math.max(100, hp), dwell, ...threat });
  };
  const routes = wave && Array.isArray(wave.routes) ? wave.routes : [];
  const spawns = wave && Array.isArray(wave.spawns) ? (ps ? withBounties(gd, m.round, wave, ps.bounties, ps.playerId, { side: boss?.side }) : wave.spawns) : [];
  // boss pair templates route to both goals: keep the routes ending on this player's half (mirrored for 'R')
  const ownRoute = (rt) => {
    if (!boss || !Array.isArray(rt.end)) return true;
    const endCol = rt.end[1];
    return boss.side === 'R' ? endCol > BOSS_MID_COL : endCol <= BOSS_MID_COL;
  };
  const mirrorRoute = (rt) => {
    // the right player fights the mirror image of the routes that end on the left goal (its own copy of the leader)
    if (!boss || boss.side !== 'R' || !Array.isArray(rt.end) || rt.end[1] > BOSS_MID_COL) return rt;
    const mc = ([r, c]) => [r, BOSS_MIRROR_COL - c];
    return { ...rt, start: mc(rt.start), end: mc(rt.end), checkpoints: Array.isArray(rt.checkpoints) ? rt.checkpoints.map(mc) : [] };
  };
  if (routes.length && spawns.length) {
    const per = new Map();
    for (const s of spawns) {
      const e = gd.enemy(s.enemyKey);
      const overrides = wave.overrides?.[e?.key] ?? wave.overrides?.[s.enemyKey];
      const stats = { ...e?.stats, ...overrides?.stats };
      const n = Math.max(1, s.count || 1);
      const isLeader = s.tag === 'boss';
      if (s.tag === 'part') continue;
      // the leader counts like LEADER_WEIGHT tough enemies: its huge pool makes damage on it worth a lot everywhere
      const hp = isLeader ? LEADER_HP : (overrides?.stats?.maxHp ?? overrides?.stats?.hp ?? stats.maxHp ?? 1000) * (s.mods?.hpMul ?? 1);
      const spd = (stats.moveSpeed ?? 1) * (s.mods?.speedMul ?? 1);
      const air = HOVER.has(s.enemyKey) || e?.isFlyEnemy || e?.stats?.motion === 'FLY';
      const key = `${s.routeIndex}|${isLeader ? 'boss' : ''}|${s.enemyKey}`;
      const a = per.get(key) || { ri: s.routeIndex, boss: isLeader, air, n: 0, hp: 0, spd: 0,
        threat: { def: (stats.def || 0) * (s.mods?.defMul ?? 1), res: (stats.res || 0) * (s.mods?.resMul ?? 1), atk: (stats.atk || 0) * (s.mods?.atkMul ?? 1),
          interval: s.interval || 4, damageType: e?.stats?.dmgType || 'phys' } };
      a.n += isLeader ? LEADER_WEIGHT : n; a.hp += hp * n; a.spd += spd * n;
      per.set(key, a);
    }
    for (const a of per.values()) {
      let rt = routes[a.ri];
      if (!rt || !Array.isArray(rt.start) || !Array.isArray(rt.end)) continue;
      if (boss && !a.boss && !ownRoute(rt)) continue;
      // in a pair each player fights its own copy of the leader (spawned on its side)
      rt = mirrorRoute(rt);
      const cnt = a.boss ? 1 : a.n;
      const dwell = a.boss ? BOSS_DWELL : 0;
      if (rt.motion === 'FLY') {
        pushRoute(traceLine([rt.start, ...(Array.isArray(rt.checkpoints) ? rt.checkpoints : []), rt.end]), a.n, true, a.hp / cnt, a.spd / cnt, dwell, a.threat);
      } else {
        const key = `${rt.start[0]},${rt.start[1]}->${rt.end[0]},${rt.end[1]}`;
        const path = Array.isArray(gpaths[key]) ? gpaths[key] : traceLine([rt.start, ...(boss && Array.isArray(rt.checkpoints) ? rt.checkpoints : []), rt.end]);
        pushRoute(path, a.n, a.air, a.hp / cnt, a.spd / cnt, dwell, a.threat); // a hovering enemy: ground tiles, air unit
      }
    }
  }
  if (!routesOut.length) {
    for (const [k, arr] of Object.entries(gpaths)) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const [sr, sc] = String(k).split('->')[0].split(',').map(Number);
      if (!(sr >= FIELD.r0 && sr <= FIELD.r1 && sc <= FIELD.c1)) continue;
      // stage ground paths are in normal-field coordinates: no boss mapping
      const own = arr.filter(([r, c]) => inRect(r, c)).map(([r, c]) => tileKey(r, c));
      if (own.length > 1) own.pop();
      if (own.length) routesOut.push({ n: 3, fly: false, tiles: own, tileTime: 2, hp: 3000, dwell: 0 });
    }
  }
  const index = new Map();
  const ground = new Map();
  routesOut.forEach((rt, ri) => {
    rt.tiles.forEach((k, i) => {
      if (!index.has(k)) index.set(k, []);
      index.get(k).push([ri, i]);
      if (!rt.fly) {
        const e = ground.get(k) || { flow: 0, prog: 0 };
        e.flow += rt.n;
        e.prog = Math.max(e.prog, rt.tiles.length > 1 ? i / (rt.tiles.length - 1) : 1);
        ground.set(k, e);
      }
    });
  });
  const flyTotal = routesOut.filter((r) => r.fly).reduce((s, r) => s + r.n, 0);
  m._botPath = { key: cacheKey, routes: routesOut, index, ground, flyTotal, airflow: airflowOf(st, toBoard, boss && boss.side === 'R') };
  return m._botPath;
}

/**
 * 气流 (act2 m01 blowers, sim content/devices.js): own-board tile → { dir, bb } for every tile a (data-)active blower
 * blows over, mapped like the routes (boss rounds: rows −7, the right side mirrored — RIGHT ↔ LEFT). An operator on
 * such a tile facing WITH the flow gets ATK × (1 + blower_s_character[equal].atk), against it [opposite], across it
 * [vertical] (DESIGN §3, research 09 §1.1): the planner scales its DPS accordingly when it picks a direction.
 */
function airflowOf(st, toBoard, mirrored) {
  const out = new Map();
  for (const d of (st && Array.isArray(st.devices) ? st.devices : [])) {
    if (!d || d.role !== 'blower' || d.active === false || d.hidden) continue;
    const bb = (d.skill && d.skill.bb) || {};
    const dir = mirrored ? mirrorDir(normDir(d.dir, 'UP')) : normDir(d.dir, 'UP');
    for (const p of Array.isArray(d.rangeTiles) ? d.rangeTiles : []) {
      if (!Array.isArray(p)) continue;
      const [r, c] = toBoard(p);
      if (inRect(r, c)) out.set(tileKey(r, c), { dir, bb });
    }
  }
  return out;
}

/** ATK factor of an operator standing on `key` facing `dir` in the model's airflow (1 off the flow). */
export function airflowAtkMul(model, key, dir) {
  const f = model && model.airflow instanceof Map ? model.airflow.get(key) : null;
  if (!f) return 1;
  const rel = dir === f.dir ? 'equal' : dir === oppositeDir(f.dir) ? 'opposite' : 'vertical';
  const v = Number(f.bb[`blower_s_character[${rel}].atk`]);
  return Number.isFinite(v) ? Math.max(0, 1 + v) : 1;
}

/** Direction candidates of the planner, in preference order (ties keep the earlier one: RIGHT = toward the gates). */
export const PLAN_DIRS = Object.freeze(['RIGHT', 'UP', 'DOWN', 'LEFT']);

/** Board tile keys covered by a record's range grid standing on (r, c) facing `dir` (grid rotated, DESIGN §3). */
export function rangeTiles(rec, r, c, dir = 'RIGHT') {
  const grid = rec && Array.isArray(rec.rangeGrid) && rec.rangeGrid.length ? rec.rangeGrid : DEFAULT_MELEE_RANGE;
  return grid.map(([dr, dc]) => { const [a, b] = rotateOffset(dr, dc, dir); return tileKey(r + a, c + b); });
}

/** Damage per second of a record (attack / attack interval; healers and non-attackers 0). */
function dpsOf(rec) {
  const st = rec && rec.stats;
  if (!st || isHealer(rec)) return 0;
  const interval = Math.max(0.2, (st.bat || 1) * 100 / Math.max(ASPD_MIN, st.aspd || 100));
  const d = (st.atk || 0) / interval * (rec.botDamageScale || 1);
  return rec.attackKind === 'none' ? d * 0.4 : d;
}

/** Damage after visible enemy defenses; skills remain the real rehearsal's responsibility. */
export function damageRatio(rec, route) {
  if (rec.dmgType === 'arts') return Math.max(0.05, 1 - (route.res || 0) / 100);
  if (rec.dmgType === 'true') return 1;
  return Math.max(0.05, 1 - (route.def || 0) / Math.max(1, rec.stats?.atk || 1));
}
const PROFILES = new WeakMap();
function crowdMultiplier(rec, route) {
  if (!PROFILES.has(rec)) PROFILES.set(rec, resolveProfile({ ...rec, subProf: rec.subProfessionId }));
  const p = PROFILES.get(rec);
  const targets = p.allInRange || p.splashRadius > 0 ? 3 : p.hitAllBlocked ? rec.stats?.blockCnt || 1 : p.maxTargets || 1;
  const density = Math.min(1, (route.n - 1) / 12) * Math.min(1, 3 / Math.max(1, route.interval || 4));
  return 1 + Math.min(2, targets - 1) * Math.max(0, density);
}

/** Tunables of the exposure model (tuned offline against the real simulation, tools/matchrun.mjs sweeps). */
export const LAYOUT_PARAMS = Object.freeze({ hold: 4, kill: 1.5, secondHold: 0.5, healHold: 0.5, roadPenalty: 0.15, spread: 99 });

/**
 * Exposure model of a layout: every enemy of route ρ spends tileTime on each tile of its route (plus the hold time
 * of blockers standing on it: hold × blockCnt, later blockers on the same route secondHold ×, healer-covered
 * blockers (1 + healHold) ×) and takes the DPS of every unit whose range covers that tile (flyers: anti-air only).
 * Value = Σρ n × (1 − e^(−exposure / (kill × hp))) — the expected enemies killed.
 */
class Layout {
  constructor(model, params) {
    this.model = model;
    this.p = params;
    this.units = []; // { rec, key, dps, air, ground, block, heal, cover: Set }
  }

  value() {
    const { routes } = this.model;
    const p = this.p;
    const cover = new Map(); // key → units; damage is evaluated against each route's enemy defenses
    const healCover = new Map();
    for (const u of this.units) {
      for (const k of u.cover) {
        const e = cover.get(k) || [];
        e.push(u);
        cover.set(k, e);
        if (u.heal) healCover.set(k, (healCover.get(k) || 0) + 1);
      }
    }
    const blockAt = new Map();
    for (const u of this.units) if (u.block > 0 && this.model.ground.has(u.key)) blockAt.set(u.key, u);
    let total = 0;
    for (const rt of routes) {
      let exp = 0;
      let lastBlock = -Infinity;
      for (let i = 0; i < rt.tiles.length; i++) {
        const k = rt.tiles[i];
        let t = rt.tileTime + (i < 2 && rt.dwell ? rt.dwell : 0);
        if (!rt.fly && blockAt.has(k)) {
          // a blocker right behind another one mostly holds what slipped past; a separate line holds again
          const fresh = i - lastBlock >= p.spread;
          const guard = blockAt.get(k);
          const stats = guard.rec.stats || {};
          const incoming = rt.damageType === 'arts' ? (rt.atk || 300) * (1 - Math.min(95, stats.res || 0) / 100) : Math.max((rt.atk || 300) * 0.05, (rt.atk || 300) - (stats.def || 0));
          const survival = Math.max(0.75, Math.min(1.2, (stats.maxHp || 1500) / Math.max(1, incoming * 8)));
          t += p.hold * guard.block * survival * (fresh ? 1 : p.secondHold) * (1 + p.healHold * Math.min(2, healCover.get(k) || 0));
          lastBlock = i;
        }
        const c = cover.get(k);
        // Base attacks underestimate skill damage/penetration: retain a conservative skill allowance.
        if (c) for (const u of c) if (rt.fly ? u.air : u.ground) exp += t * u.dps * (0.4 + 0.6 * damageRatio(u.rec, rt)) * crowdMultiplier(u.rec, rt);
      }
      total += rt.n * (1 - Math.exp(-exp / (p.kill * rt.hp)));
    }
    // ranged units standing on a road block and get hit: a small penalty per road tile they occupy
    for (const u of this.units) if (!u.block && this.model.ground.has(u.key)) total -= p.roadPenalty * this.model.ground.get(u.key).flow;
    return total;
  }
}

function unitOf(rec, key, r, c, dir = 'RIGHT', model = null) {
  const block = isBlocker(rec) ? Math.max(1, rec.stats?.blockCnt ?? 1) : 0;
  const atkMul = airflowAtkMul(model, key, dir);
  return {
    rec, key, dir, dps: dpsOf(rec) * atkMul, atkMul, air: hitsFly(rec), ground: rec.attackKind !== 'heal' && !isHealer(rec),
    block, heal: isHealer(rec), cover: new Set(rangeTiles(rec, r, c, dir)),
  };
}

/** A layout plan: Map uid → tile key, plus `dirs`: Map uid → direction (UP|RIGHT|DOWN|LEFT). */
export class LayoutPlan extends Map {
  constructor(entries) { super(entries); this.dirs = new Map(); }
  /** The planned direction of a piece (RIGHT when unplanned). */
  dirOf(uid) { return this.dirs.get(uid) ?? 'RIGHT'; }
}

/**
 * Plan tiles and directions for `pieces` (chess or token pieces with `id`): blockers first, then damage dealers by
 * DPS, then healers and the rest; each takes the legal free (tile, direction) with the best marginal layout value
 * (directions in PLAN_DIRS order, a direction whose rotated range equals an earlier one's is skipped; one rng draw per
 * tile breaks ties between tiles). Returns a LayoutPlan (Map uid → key, `.dirs` uid → dir).
 * @param {import('./Match.js').Match} m
 * @param {import('./PlayerState.js').PlayerState} ps
 */
export function planLayout(m, ps, pieces, params = LAYOUT_PARAMS, opts = {}) {
  return runSteps(planLayoutSteps(m, ps, pieces, params, opts));
}

/** Small tie-breaker for actual adjacent/row traits; combat route coverage remains the main objective. */
function formationGrowth(m, ps, entries) {
  let v = 0;
  for (const { piece, r, c, dir } of entries) {
    for (const g of garrisons(m, piece.id)) {
      if (!['SERVER_PREP_FIN', 'SERVER_PREP_START'].includes(g.eventType)) continue;
      const b = g.bb || {}, s = g.bbStr || {};
      const [dr, dc] = rotateOffset(0, s.dir === 'behind' ? -1 : 1, dir);
      const neighbour = entries.find((e) => e.r === r + dr && e.c === c + dc);
      if (g.effectKey === 'SERVER_ADD_BOND_POSITION' && neighbour) {
        for (const id of m.gd.chess(neighbour.piece.id)?.bonds || []) if (ps.bonds[id]?.active) v += layerValue(m, ps, id, b.count);
      }
      if (g.effectKey === 'SERVER_TRIGGER_ANOTHER' && neighbour) v += traitValue(m, ps, neighbour.piece, ['SERVER_GAIN']);
      if (g.effectKey === 'SERVER_FRONT_SAME_EFFECT_PREP_FIN' && neighbour) v += traitValue(m, ps, neighbour.piece, ['SERVER_PREP_FIN']);
      if (g.effectKey === 'SERVER_FRONT_SAME_EFFECT_PREP_START' && neighbour) v += traitValue(m, ps, neighbour.piece, ['SERVER_PREP_START']);
      const rowCount = entries.filter((e) => e.r === r).length;
      if (s.add_method === 'same_row') for (const id of String(s.bond || '').split(',')) if (ps.bonds[id]?.active) v += layerValue(m, ps, id, rowCount * (b.multi || 1));
      if (s.conditionkey === 'character_same_row' && rowCount >= (b.check_count || 3)) v += 4;
    }
  }
  return v * 0.025;
}

/** planLayout as a step generator: yields after each placed piece (Match slices a bot's prep, see botPrepBeginSteps). */
export function* planLayoutSteps(m, ps, pieces, params = LAYOUT_PARAMS, { occupied = new Set(), recOf = null } = {}) {
  const model = fieldModel(m, ps);
  const map = ps.deployMap();
  const state = recOf ? null : lineupState(m, ps, pieces.filter((p) => p.kind === 'chess'));
  const records = recOf ? null : new Map(pieces.map((p) => [p.uid, p.kind === 'token' ? m.gd.token(p.id) : combatRecord(m, ps, p, state.bonds, pieces.length)]));
  const rec = recOf || ((p) => records.get(p.uid));
  const layout = new Layout(model, params);
  const rank = (p) => { const r = rec(p); return isBlocker(r) ? 0 : isHealer(r) ? 2 : 1; };
  const order = pieces.slice().sort((a, b) => rank(a) - rank(b) || dpsOf(rec(b)) - dpsOf(rec(a)) || a.uid - b.uid);
  const taken = new Set(occupied);
  const out = new LayoutPlan();
  const placed = [];
  for (const p of order) {
    const r0 = rec(p);
    if (!r0) continue;
    let best = null;
    let bestV = -Infinity;
    for (const [r, c] of legalTiles(map, positionClass(r0))) {
      const k = tileKey(r, c);
      if (taken.has(k)) continue;
      const noise = m.rngBots() * 1e-6;
      const seen = new Set();
      for (const dir of PLAN_DIRS) {
        const u = unitOf(r0, k, r, c, dir, model);
        // (the same covered tiles under a different airflow ATK factor are a different candidate)
        const positional = garrisons(m, p.id).some((g) => /POSITION|FRONT|TRIGGER/.test(g.effectKey));
        const sig = `${positional ? dir : ''}|${u.atkMul}|${[...u.cover].sort().join(' ')}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        layout.units.push(u);
        const v = layout.value() + formationGrowth(m, ps, [...placed, { piece: p, r, c, dir }]) + noise;
        layout.units.pop();
        if (v > bestV) { bestV = v; best = [k, r, c, dir]; }
      }
    }
    if (!best) continue;
    taken.add(best[0]);
    layout.units.push(unitOf(r0, best[0], best[1], best[2], best[3], model));
    out.set(p.uid, best[0]);
    out.dirs.set(p.uid, best[3]);
    placed.push({ piece: p, r: best[1], c: best[2], dir: best[3] });
    yield;
  }
  return out;
}

/** A plan's direction for a piece (plans without directions ⇒ RIGHT). */
const planDir = (plan, uid) => (plan && plan.dirs instanceof Map ? plan.dirs.get(uid) : null) ?? 'RIGHT';

/** Layout-model variants the rehearsal compares (the first one is the default plan). */
export const REHEARSAL_VARIANTS = Object.freeze([
  {},
  { spread: 3, secondHold: 0.2 },
  { hold: 2 },
  { hold: 8 },
  { kill: 3 },
]);

/** Distinct plans (same unit → tile assignment ⇒ one candidate), in order. */
function distinctPlans(plans) {
  const out = [];
  const seen = new Set();
  for (const plan of plans) {
    const sig = [...plan.entries()].sort((a, b) => a[0] - b[0]).map(([u, k]) => `${u}@${k}:${planDir(plan, u)}`).join(' ');
    if (!seen.has(sig)) { seen.add(sig); out.push(plan); }
  }
  return out;
}

/** Counted leaks of the bot's player in a (possibly still running) rehearsal battle. */
function countedLeaks(battle, playerId) {
  const r = battle.result();
  const pp = r && r.perPlayer && r.perPlayer[playerId];
  return pp ? (pp.leaked || []).filter((l) => l && l.counted !== false).length : 0;
}

/**
 * Rehearsal job: a player "tries out" candidate layouts — each distinct plan (up to m.botRehearsal) is simulated once
 * against the round's enemies with the real Battle (a rehearsal seed, never the real battle's; only the read-only
 * combat-context handler runs, so it has no side effect on the match). Prefer fewer counted leaks, then more kills,
 * then useful persistent layer gains when another round remains. Three-AI relay teams also compare remaining
 * HP and a bounded single-helper escape-route trial, only after a perfect own-field result.
 * Every normal candidate's Battle is built right away (each layout is on the board only while its input is taken; the board
 * is restored exactly before this returns), so the job can be stepped later: `job.run(budgetMs)` simulates until the
 * wall-clock budget is used (checked every 4 ticks) and returns true once every candidate is done. A candidate whose
 * counted leaks already exceed the best finished one's stops early (it can no longer win).
 * Relay trials are created from saved inputs after normal combat, with no live-board mutation. Match steps
 * normal and relay simulations under the same slice budget between other callbacks.
 * @returns {null | { chosen: any[], plans: Array<Map<number, string>>, best: Map<number, string>, done: boolean, run: (budgetMs?: number) => boolean }}
 *   null when there is nothing to compare (no wave, < 2 distinct plans, rehearsal off)
 */
export function createRehearsal(m, ps, chosen, plans) {
  return runSteps(createRehearsalSteps(m, ps, chosen, plans));
}

/**
 * createRehearsal as a step generator: yields after each candidate's Battle is built. Each candidate puts its layout on
 * the board, takes the battle input and restores the board exactly before the next yield — a bot prep dropped between
 * two steps (the prep ended) never leaves a rehearsal layout on the board.
 */
export function* createRehearsalSteps(m, ps, chosen, plans) {
  const wave = m.wave;
  const distinct = distinctPlans(plans);
  if (!wave || distinct.length < 2 || !(m.botRehearsal > 0)) return null;
  const cands = distinct.slice(0, m.botRehearsal);
  const byUid = new Map(ps.allChess().concat(chosen).map((p) => [p.uid, p]));
  const battles = [];
  const candidateBonds = [];
  const candidateInputs = [];
  for (const plan of cands) {
    const saved = [...ps.board.entries()];
    const savedHand = ps.hand.slice();
    const savedTemp = ps.temp.slice();
    // the candidate's directions are set on the pieces while its input is taken; restored exactly afterwards
    const savedDirs = new Map([...byUid.values(), ...saved.map(([, p]) => p)].map((p) => [p, Object.hasOwn(p, 'dir') ? { v: p.dir } : null]));
    let failed = false;
    try {
      ps.board.clear();
      for (const [uid, k] of plan) { const p = byUid.get(uid); if (p) { p.dir = planDir(plan, uid); ps.board.set(k, p); } }
      const proposed = [...ps.board.values()];
      const state = lineupState(m, { ...ps, board: new Map(saved), hand: savedHand, temp: savedTemp }, proposed);
      ps.hand.splice(0, ps.hand.length, ...state.hand, ...Array(Math.max(0, savedHand.length - state.hand.length)).fill(null));
      ps.temp.splice(0, ps.temp.length, ...savedTemp.map((p) => p && plan.has(p.uid) ? null : p));
      // Existing owned summon pieces are included in rehearsal; relocating one must not grant new pieces/UIDs.
      for (const [k, token] of saved) if (token.kind === 'token' && plan.has(token.ownerUid) && !ps.board.has(k)) ps.board.set(k, token);
      ps.recompute();
      const input = ps.battleInput({ side: 'L', colOffset: 0 });
      // This read-only handler supplies hand counts and team strategies (including Touch) used by combat content.
      m.registry.get('global:contentb_info')?.onBattleStart(makeCtx(m, ps, {}, 'onBattleStart'), { input, kind: 'normal' });
      const spawns = withBounties(m.gd, m.round, wave, ps.bounties, ps.playerId).map((sp) => ({ ...sp, ownerPlayerId: ps.playerId }));
      battles.push(m.newBattle({
        seed: deriveSeed(m.seed, `rehearse:${m.round}:${ps.seat}`), kind: 'normal', modeId: m.modeId, round: m.round,
        stageId: m.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: wave.timeLimit, players: [input],
        spawns: m._sanitizeSpawns(spawns, ps.playerId), routes: wave.routes, sharedBoss: null,
        // Battle clones its bonds; its results are never committed to the match. In-battle growth is safe here.
        flags: { layerGainsEnabled: true, ...m.gd.dp }, fieldId: `r:${ps.playerId}`, enemyOverrides: wave.overrides, waveId: wave.templateId,
      }));
      candidateBonds.push(input.bonds);
      candidateInputs.push(structuredClone(input));
    } catch (e) {
      failed = true;
      m.log.warn?.(`[match ${m.roomCode}] bot rehearsal failed: ${e && e.message}`);
    } finally {
      ps.board.clear();
      for (const [p, d] of savedDirs) { if (d) p.dir = d.v; else delete p.dir; }
      for (const [k, p] of saved) ps.board.set(k, p);
      ps.hand.splice(0, ps.hand.length, ...savedHand);
      ps.temp.splice(0, ps.temp.length, ...savedTemp);
      ps.recompute();
    }
    if (failed) break;
    yield;
  }
  const cap = Math.ceil(((wave.timeLimit || 60) + 5) * 30);
  let i = 0;
  let t = 0;
  let bestScore = -Infinity;
  let bestLeaks = Infinity;
  let relayPending = null;
  const job = {
    chosen,
    plans: cands,
    best: cands[0],
    done: false,
    run(budgetMs = Infinity) {
      const timed = Number.isFinite(budgetMs);
      const t0 = timed ? performance.now() : 0;
      let n = 0;
      while (i < battles.length) {
        // a candidate that ended mid-slice (finished, cap, or beaten at a 64-tick check that skipped the budget test):
        // check the budget before stepping the next one, so a slice never exceeds 4 ticks past its budget
        if (timed && n > 0 && performance.now() - t0 >= budgetMs) return false;
        const battle = battles[i];
        try {
          let beaten = false;
          while (t < cap && !battle.finished) {
            battle.step();
            t++;
            n++;
            if (!relayPending && (t & 63) === 0 && bestLeaks < Infinity && countedLeaks(battle, ps.playerId) > bestLeaks) { beaten = true; break; }
            if (timed && (n & 3) === 0 && performance.now() - t0 >= budgetMs) return false;
          }
          if (!beaten) {
            if (!battle.finished) battle.forceEnd('timeout');
            const r = battle.result();
            const pp = r && !r.synthetic && r.perPlayer && r.perPlayer[ps.playerId];
            if (relayPending) {
              const score = relayPending.score + relayDefenseValue(r, relayPending.count);
              if (score > bestScore) { bestScore = score; bestLeaks = 0; job.best = cands[i]; job.chosen = [...cands[i].keys()].map((uid) => byUid.get(uid)).filter(Boolean); }
              relayPending = null;
            } else if (pp) {
              const leaks = (pp.leaked || []).filter((l) => l && l.counted !== false).length;
              const growth = m.round < m.gd.bossRound ? Object.entries(pp.layerGains || {}).reduce((n, [id, amount]) =>
                n + layerValue(m, ps, id, amount, candidateBonds[i]), 0) : 0;
              const score = -leaks * 10000 + (pp.killed || 0) * 10 + Math.min(5, Math.log1p(growth)) + relayCarryValue(m, ps, pp) - i * 0.0001;
              const relay = leaks === 0 ? createRelayRehearsal(m, ps, candidateInputs[i], pp) : null;
              if (relay) { relayPending = { score, count: relay.count }; battles[i] = relay.battle; t = 0; continue; }
              if (score > bestScore) { bestScore = score; bestLeaks = leaks; job.best = cands[i]; job.chosen = [...cands[i].keys()].map((uid) => byUid.get(uid)).filter(Boolean); }
            }
          }
        } catch (e) {
          m.log.warn?.(`[match ${m.roomCode}] bot rehearsal failed: ${e && e.message}`);
        }
        relayPending = null;
        battles[i] = null;
        i++;
        t = 0;
      }
      job.done = true;
      return true;
    },
  };
  return job;
}

/**
 * Synchronous rehearsal (tools, tests): see createRehearsal. The board is restored exactly afterwards.
 * @returns {Map<number, string>} the chosen plan
 */
export function rehearse(m, ps, chosen, plans) {
  const job = createRehearsal(m, ps, chosen, plans);
  if (!job) return distinctPlans(plans)[0] || plans[0];
  job.run();
  return job.best;
}

// ---------------------------------------------------------------------------------------------------
// prep routine

function tryDo(fn) {
  try { const r = fn(); return !!(r && r.ok); } catch { return false; }
}

function canUseItem(m, ps, item) {
  const rec = m.gd.item(item.id);
  if (!rec) return false;
  if (rec.itemType === 'MAGIC') return m.registry.has('item:' + itemKey(item.id));
  const consume = typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip');
  if (consume) return m.registry.has('item:' + itemKey(item.id));
  return true;
}

function context(m, ps) {
  const owned = ownedBonds(m, ps);
  const model = fieldModel(m, ps);
  return { owned, focus: focusBond(m, ps), roles: roles(m, ps), fly: model.flyTotal, model };
}

/** Sell the weakest bench chess that is not part of a merge pair (or anything when keepPairs is false). */
function sellWeakestHand(m, ps, { keepPairs = true, below = Infinity } = {}) {
  const ctx = context(m, ps);
  let worst = null;
  let worstV = Infinity;
  for (const p of [...ps.temp, ...ps.hand]) {
    if (!p || p.kind !== 'chess') continue;
    const base = m.gd.baseIdOf(p.id);
    if (keepPairs && !m.gd.isGolden(p.id) && ps.countCopies(base) >= 2) continue;
    const v = pieceValue(m, ps, p, ctx) + benchValue(m, ps, p) * 3;
    if (v < worstV) { worstV = v; worst = p; }
  }
  if (!worst || worstV >= below) return false;
  return tryDo(() => ps.sell(worst.uid));
}

/** Lineup gain of a recruit: a single swap or a complementary pair with an already-owned support. */
function lineupGain(m, ps, id, ctx, cur) {
  const probe = { uid: -1, kind: 'chess', id, items: [] };
  let best = cur.score;
  for (let i = 0; i < cur.set.length; i++) {
    const trial = cur.set.slice();
    trial[i] = probe;
    best = Math.max(best, lineupScore(m, ps, trial, ctx));
  }
  const support = bestSupportSwap(m, ps, cur.set, cur.bench.concat(probe), ctx, best, probe.uid);
  return Math.max(best, support?.score ?? best) - cur.score;
}

/**
 * Prep start: sell bench chess that neither make the lineup nor build toward something (a pair that can still
 * merge, the focus bond, an elite) — they only block merges; the refund buys more. Keeps a few spare bench units.
 */
function sellJunk(m, ps) {
  const ctx = context(m, ps);
  const { bench } = chooseLineup(m, ps, ctx);
  const keep = [];
  const junk = [];
  for (const p of bench) {
    const c = chessRec(m, p.id);
    if (!c) continue;
    const base = m.gd.baseIdOf(p.id);
    const copies = c.isGolden ? 0 : ps.countCopies(base);
    const pairLive = copies >= 2 && (m.pool.left(base) > 0 || !m.pool.has(base)) && (c.tier >= ps.shop.level - 2 || (c.bonds || []).includes(ctx.focus));
    const engine = benchValue(m, ps, p);
    const useful = c.isGolden || pairLive || engine >= 1 || (ctx.focus && (c.bonds || []).includes(ctx.focus)) || (copies >= 2 && m.round <= 6);
    (useful ? keep : junk).push({ p, v: pieceValue(m, ps, p, ctx) + engine * 3 + (useful ? 100 : 0) });
  }
  // Leave space for offers/merges; productive bench traits and live pairs outrank stale singles.
  const all = keep.concat(junk).sort((a, b) => b.v - a.v);
  for (const { p } of all.slice(6)) tryDo(() => ps.sell(p.uid));
  for (const { p } of junk.slice(0, 4)) if (m.round >= 5 && ps.find(p.uid)) tryDo(() => ps.sell(p.uid));
}

/** Take the queued pick-one offers (merge rewards, special refreshes — free; they expire at prep end). */
function takeOffers(m, ps) {
  for (let guard = 0; guard < 4 && ps.offers.length; guard++) {
    const offer = ps.offers[0];
    const ctx = context(m, ps);
    let best = -1;
    let bestS = -Infinity;
    offer.slots.forEach((s, i) => {
      if (s.sold) return;
      const sc = s.kind === 'item' ? (bestEquipmentTarget(m, ps, s.id, ps.allChess())?.score || 0) : buyScore(m, ps, s.id, ctx);
      if (sc > bestS) { bestS = sc; best = i; }
    });
    if (best < 0) break;
    if (freeSlot(ps.hand) < 0) sellWeakestHand(m, ps, { keepPairs: false });
    if (!tryDo(() => ps.pickReward(best))) {
      // could not take it (sold out / no room): drop the offer
      ps.offers.shift();
      ps.dirty();
    }
  }
}

/**
 * Prep routine up to the final arrangement, whose default plan is already on the board. Returns the layout
 * rehearsal still to run (Match steps it in wall-clock-bounded slices, then calls botPrepEnd) or null.
 */
export function botPrepBegin(m, ps) {
  return runSteps(botPrepBeginSteps(m, ps));
}

/**
 * botPrepBegin as a step generator (the same actions in the same order, hence the same rng draws and decisions): it
 * yields between whole prep actions — never while the board holds a transient layout — so Match.scheduleBotPrep runs
 * it in wall-clock-bounded slices like the rehearsal (50–120 ms of planning in one callback late in a 4-bot match
 * otherwise). Returns the rehearsal job (or null).
 */
export function* botPrepBeginSteps(m, ps) {
  if (!ps.alive || ps.ready) return null;
  // 1. reward offers (free)
  takeOffers(m, ps);
  yield;
  // 2. economy: dead bench weight back to funds, units toward a full board, the level curve, then everything else;
  //    merges completed while buying queue reward offers that expire at prep end — take them right away
  sellJunk(m, ps);
  yield;
  // Reach tier-II recruits before the first large waves instead of filling every slot with tier-I units.
  if (m.difficulty === 'ABYSS' && m.round === 3 && ps.allChess().length >= 4) levelUp(m, ps);
  yield* buyLoopSteps(m, ps, { fillOnly: true, maxRefreshes: 0 });
  takeOffers(m, ps);
  // Activate the current lineup before onGain/onRefresh effects check its bonds.
  yield* arrangeSteps(m, ps);
  equipItems(m, ps);
  takeOffers(m, ps);
  levelUp(m, ps);
  yield;
  yield* buyLoopSteps(m, ps, { fillOnly: false, maxRefreshes: 8 });
  takeOffers(m, ps);
  levelUp(m, ps, { spare: true });
  yield;
  // 3. placement, 4. items, placement again (item carriers gain value; rehearsed when the match allows it)
  yield* arrangeSteps(m, ps);
  equipItems(m, ps);
  takeOffers(m, ps);
  // Consumables and recruitment/merge rewards can add money, pieces and offers after shopping.
  yield* buyLoopSteps(m, ps, { maxRefreshes: 2 });
  takeOffers(m, ps);
  yield* arrangeSteps(m, ps);
  equipItems(m, ps);
  takeOffers(m, ps);
  yield;
  return yield* arrangeSteps(m, ps, { final: true, defer: true });
}

/** Prep routine, end: the rehearsed layout (when it beat the default plan), temp, a free hand slot, Ready. */
export function botPrepEnd(m, ps, job = null) {
  runSteps(botPrepEndSteps(m, ps, job));
}

/** botPrepEnd as a step generator (see botPrepBeginSteps). */
export function* botPrepEndSteps(m, ps, job = null) {
  if (!ps.alive || ps.ready) return;
  if (job && job.done && job.best !== job.plans[0]) yield* applyPlanSteps(m, ps, job.chosen, job.best);
  // 5. temp → hand / sell / destroy; keep one hand slot free for next round's merges
  resolveTemp(m, ps);
  if (freeSlot(ps.hand) < 0) sellWeakestHand(m, ps);
  takeOffers(m, ps);
  resolveTemp(m, ps);
  // Keep an unaffordable third copy; do not freeze a stale shop just because it was frozen before.
  const keepShop = ps.shop.slots.some((s) => s && !s.sold && s.kind === 'chess' && ps.completesChessMerge(s.id) && ps.priceOf(s) > ps.funds);
  if (ps.shop.frozen !== keepShop) tryDo(() => ps.freeze());
  tryDo(() => ps.setReady(true));
}

/** The whole prep routine in one go (the rehearsal, if any, runs synchronously). */
export function botPrep(m, ps) {
  const job = botPrepBegin(m, ps);
  if (job) job.run();
  botPrepEnd(m, ps, job);
}

function levelUp(m, ps, { spare = false } = {}) {
  const gd = m.gd;
  for (let guard = 0; guard < 6; guard++) {
    if (ps.shop.level >= gd.maxShopLevel) return;
    const price = Math.max(0, ps.shop.upgradePrice);
    if (ps.funds < price) return;
    const r = m.round;
    const target = LEVEL_TARGET[Math.min(LEVEL_TARGET.length - 1, r)];
    const nextTarget = LEVEL_TARGET[Math.min(LEVEL_TARGET.length - 1, r + 1)];
    // early levels only once the board is full (units first); later a 6-unit core is enough
    const boardReady = ps.allChess().length >= (m.difficulty === 'ABYSS' && r === 3 ? 4 : r <= 4 ? ps.deployCap : Math.min(ps.deployCap, 6));
    let want = price === 0 || coreUpgradeWanted(m, ps, target, price) || relayUpgradeWanted(m, ps, price);
    if (!want && ps.shop.level < target && (boardReady || r >= 6)) want = true;
    if (!want && ps.shop.level < nextTarget && price <= 2 && boardReady) want = true;
    if (!want && spare && ps.funds >= price + 1 && ps.shop.level < nextTarget + 1 && boardReady) want = true;
    if (!want && ps.funds >= price + 14) want = true;
    if (!want || !tryDo(() => ps.levelUp())) return;
  }
}

/** Buying / rerolling toward the lineup; a step generator (yields after each purchase or reroll). */
function* buyLoopSteps(m, ps, { fillOnly = false, maxRefreshes = 0 } = {}) {
  const gd = m.gd;
  let paidRefreshes = 0, freeRefreshes = 0;
  const minPrice = 2;
  for (let guard = 0; guard < 40; guard++) {
    if (guard > 0) yield;
    takeOffers(m, ps);
    const ctx = context(m, ps);
    const ownedN = ps.allChess().length;
    const boardFull = ownedN >= ps.deployCap;
    if (fillOnly && boardFull) return;
    // keep room for merges: a crowded bench sheds its weakest single
    const used = ps.hand.filter(Boolean).length;
    if (used >= gd.benchSize - 1) sellWeakestHand(m, ps);
    let best = -1;
    let bestS = 0;
    let trade = false;
    let cur = null;
    ps.shop.slots.forEach((s, i) => {
      if (!s || s.sold) return;
      const price = ps.priceOf(s);
      if (price > ps.funds) return;
      let sc;
      let sellAfter = false;
      if (s.kind === 'chess') {
        const base = gd.baseIdOf(s.id);
        if (m.pool.has(base) && m.pool.left(base) < (gd.isGolden(s.id) ? gd.goldenCopies : 1)) return;
        if (freeSlot(ps.hand) < 0 && !ps.completesChessMerge(s.id)) return;
        const merges = ps.completesChessMerge(s.id);
        sc = buyScore(m, ps, s.id, ctx) - price;
        // with a full board a buy must improve the lineup (or be merge progress)
        if (boardFull && !merges && ps.countCopies(gd.baseIdOf(s.id)) === 0) {
          cur ||= chooseLineup(m, ps, ctx);
          const gain = lineupGain(m, ps, s.id, ctx, cur);
          const probe = { id: s.id, kind: 'chess', items: [] };
          const engine = recurringValue(m, ps, probe, { bench: true }) + coreReserveValue(m, ps, s.id) + economyRecruitValue(m, ps, s.id);
          const immediate = traitValue(m, ps, probe, ['SERVER_GAIN', 'SERVER_CHESS_SOLD']);
          const netCost = Math.max(0, price - gd.sellPrice(s.id));
          if (gain <= 2 && engine < 1 && immediate < 2 + netCost * 2.5) return;
          sellAfter = gain <= 2 && engine < 1;
          if (sellAfter) sc = immediate * 2 - netCost * 2.5;
          sc += Math.min(15, gain * 0.5);
        }
        if (!boardFull) sc += 8;
      } else {
        if (fillOnly) return;
        if (!canUseItem(m, ps, { id: s.id })) return;
        if (freeSlot(ps.hand) < 0 && !ps.completesItemMerge(s.id)) return;
        const target = bestEquipmentTarget(m, ps, s.id);
        if (!target) return;
        sc = target.score - price * 1.5 + (ps.completesItemMerge(s.id) ? 8 : 0);
      }
      if (sc > bestS) { bestS = sc; best = i; trade = sellAfter; }
    });
    if (best >= 0 && bestS >= 3) {
      const id = ps.shop.slots[best].id;
      const before = trade ? new Set(ps.allChess().map((p) => p.uid)) : null;
      const beforeCore = ps._botCore;
      if (!tryDo(() => ps.buy(best))) return;
      if (!trade && beforeCore && m.gd.chess(id)?.bonds?.includes(beforeCore.id)) {
        const next = corePlan(m, ps);
        const thresholds = m.gd.bond(beforeCore.id)?.thresholds || [3];
        if (next?.id === beforeCore.id && thresholds.some((n) => beforeCore.count < n && next.count >= n
          && (ps.bonds[next.id]?.count || 0) < n)) yield* arrangeSteps(m, ps);
      }
      if (trade) {
        const bought = ps.allChess().find((p) => p.id === id && !before.has(p.uid) && ps.find(p.uid)?.area !== 'board');
        if (bought && !m.gd.isGolden(bought.id)) tryDo(() => ps.sell(bought.uid));
      }
      continue;
    }
    // leftover funds are lost at prep end: reroll while a purchase stays affordable
    const refreshCost = ps.shop.freeRefreshes > 0 ? 0 : gd.refreshPrice;
    const affordable = ps.funds >= refreshCost + (ps.shop.level >= 3 ? 1 : minPrice);
    const growth = refreshValue(m, ps);
    // Earned free rolls have their own bounded allowance, so they do not consume the paid-search budget.
    const refreshRoom = maxRefreshes > 0 && (refreshCost === 0 ? freeRefreshes < Math.max(4, maxRefreshes * 2) : paidRefreshes < maxRefreshes);
    if (refreshRoom && ps.funds >= refreshCost && (affordable || refreshCost === 0 || growth >= refreshCost * 1.5)) {
      if (!tryDo(() => ps.refresh())) return;
      if (refreshCost === 0) freeRefreshes++; else paidRefreshes++;
      continue;
    }
    return;
  }
}

/**
 * Choose the deployed set and put it on the best tiles for this round's enemies (planLayout). `final`: the last
 * arrangement of the prep — candidate plans are rehearsed (see createRehearsal) when the match allows it; with `defer`
 * the default plan is placed now and the rehearsal job is returned (the caller runs it and applies `job.best`).
 * @returns {null | ReturnType<typeof createRehearsal>}
 */
export function arrange(m, ps, opts = {}) {
  return runSteps(arrangeSteps(m, ps, opts));
}

/** arrange as a step generator (yields inside the layout planning, see planLayoutSteps). */
export function* arrangeSteps(m, ps, { final = false, defer = false } = {}) {
  const ctx = context(m, ps);
  const lineup = chooseLineup(m, ps, ctx);
  const chosen = lineup.set;
  const chosenSet = new Set(chosen.map((p) => p.uid));
  // withdraw board chess that are not chosen (to free cap) when the hand has space
  for (const [, p] of [...ps.board]) {
    if (p.kind !== 'chess' || chosenSet.has(p.uid)) continue;
    const idx = freeSlot(ps.hand);
    if (idx >= 0) tryDo(() => ps.move(p.uid, { area: 'hand', idx }));
    else {
      // Preserve merge pairs and core reserves; incoming chosen pieces swap them back to the hand.
      const keep = ps.countCopies(m.gd.baseIdOf(p.id)) >= 2 || m.gd.isGolden(p.id)
        || (p.items || []).length > 0 || benchValue(m, ps, p) >= 1 || m.gd.chess(p.id)?.bonds?.includes(ctx.focus);
      if (!keep) tryDo(() => ps.sell(p.uid));
    }
  }
  yield;
  const plans = [];
  if (final && m.wave && m.botRehearsal > 0) {
    plans.push(yield* planLayoutSteps(m, ps, chosen));
    // Compare a different roster as well as geometry, using only pieces actually owned.
    let alternative = null;
    for (const incoming of lineup.bench) for (let i = 0; i < chosen.length; i++) {
      if (!ps.find(incoming.uid)) continue; // a full hand may have forced an outgoing unit to be sold above
      if (incoming.id === chosen[i].id) continue;
      const set = chosen.slice(); set[i] = incoming;
      const score = lineupScore(m, ps, set, ctx);
      if (!alternative || score > alternative.score) alternative = { set, score };
    }
    if (alternative) plans.push(yield* planLayoutSteps(m, ps, alternative.set));
    for (const v of REHEARSAL_VARIANTS.slice(1)) plans.push(yield* planLayoutSteps(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));
  } else {
    plans.push(yield* planLayoutSteps(m, ps, chosen));
  }
  if (defer && plans.length > 1) {
    const job = yield* createRehearsalSteps(m, ps, chosen, plans);
    yield* applyPlanSteps(m, ps, chosen, plans[0]);
    return job;
  }
  const target = plans.length > 1 ? rehearse(m, ps, chosen, plans) : plans[0];
  yield* applyPlanSteps(m, ps, ps.allChess().filter((p) => target.has(p.uid)), target);
  return null;
}

/**
 * Put the chosen pieces on their planned tiles, fill what is still off the board, then place summons. Placed summons go
 * back to their stacks first: they would sit on the plan's tiles (an operator moved onto one swaps it elsewhere), and a
 * 凯瑟琳 device left beside a tile its operator moved away from would face nothing (QA, playtest #6).
 */
function* applyPlanSteps(m, ps, chosen, target) {
  liftTokens(ps);
  const chosenUids = new Set(chosen.map((p) => p.uid));
  for (const p of [...ps.board.values()]) {
    if (p.kind !== 'chess' || chosenUids.has(p.uid)) continue;
    const idx = freeSlot(ps.hand);
    if (idx >= 0) tryDo(() => ps.move(p.uid, { area: 'hand', idx }));
  }
  // move pieces onto their targets (board → board moves swap; hand → board may swap an occupant back to the hand)
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const p of chosen) {
      const k = target.get(p.uid);
      if (!k) continue;
      const loc = ps.find(p.uid);
      const dir = planDir(target, p.uid);
      if (!loc || (loc.area === 'board' && loc.key === k && pieceDir(loc.piece) === dir)) continue;
      const [r, c] = parseKey(k);
      // onto its own tile: an in-place re-orientation (not a move)
      if (tryDo(() => ps.move(p.uid, { area: 'board', row: r, col: c }, dir)) && loc.key !== k) moved = true;
    }
    if (!moved) break;
  }
  // anything chosen still off the board: the best remaining free tile
  const off = chosen.filter((p) => { const loc = ps.find(p.uid); return loc && loc.area !== 'board'; });
  if (off.length && ps.deployCount < ps.deployCap) {
    yield;
    const again = yield* planLayoutSteps(m, ps, off, LAYOUT_PARAMS, { occupied: new Set(ps.board.keys()) });
    for (const p of off) {
      const k = again.get(p.uid);
      if (!k || ps.deployCount >= ps.deployCap) continue;
      const [r, c] = parseKey(k);
      tryDo(() => ps.move(p.uid, { area: 'board', row: r, col: c }, planDir(again, p.uid)));
    }
  }
  yield* placeTokensSteps(m, ps);
}

/** Board summons back to their hand stacks (or a free hand slot). */
function liftTokens(ps) {
  for (const p of [...ps.board.values()]) {
    if (p.kind !== 'token') continue;
    const stack = ps.hand.findIndex((x) => x && x.kind === 'token' && x.ownerUid === p.ownerUid && x.id === p.id);
    const idx = stack >= 0 ? stack : freeSlot(ps.hand);
    if (idx >= 0) tryDo(() => ps.move(p.uid, { area: 'hand', idx }));
  }
}

/**
 * Summons that help the operator on the tile they face (range 1-1: their own tile + the one in front) instead of
 * covering the enemy path: 凯瑟琳's 爬行号·防护单元 (a hand piece since user playtest #6).
 */
const FRONT_SUPPORT_TOKENS = new Set(['token_10041_cathy_catsld']);
/** Device tile offsets around an operator (behind it — enemies come from the gates on the right —, above, below, in front) and the facing that points back at it. */
const SUPPORT_SPOTS = Object.freeze([[0, -1, 'RIGHT'], [1, 0, 'DOWN'], [-1, 0, 'UP'], [0, 1, 'LEFT']]);

/**
 * A tile + direction for a front-support device: next to the most valuable operator no device faces yet (blockers
 * first — they take the hits —, then DPS), pointing at it; null when none is free.
 */
function supportSpot(m, ps, p) {
  const rec = m.gd.token(p.id);
  if (!rec) return null;
  const map = ps.deployMap();
  const pos = positionClass(rec);
  const faced = new Set();
  for (const [k, q] of ps.board) {
    if (q.kind !== 'token' || !FRONT_SUPPORT_TOKENS.has(q.id)) continue;
    const [r, c] = parseKey(k);
    const [dr, dc] = rotateOffset(0, 1, pieceDir(q));
    faced.add(tileKey(r + dr, c + dc));
  }
  const ops = [...ps.board.entries()].filter(([k, q]) => q.kind === 'chess' && !faced.has(k)).map(([k, q]) => [k, m.gd.chess(q.id)]).filter(([, c]) => c)
    .sort((a, b) => Number(isBlocker(b[1])) - Number(isBlocker(a[1])) || dpsOf(b[1]) - dpsOf(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k] of ops) {
    const [r, c] = parseKey(k);
    for (const [dr, dc, dir] of SUPPORT_SPOTS) {
      const t = tileKey(r + dr, c + dc);
      if (!ps.board.has(t) && canPlace(map, pos, r + dr, c + dc)) return [r + dr, c + dc, dir];
    }
  }
  return null;
}

/** Placeable summons from the hand / temp onto the best free tiles (one per stack count). */
function* placeTokensSteps(m, ps) {
  for (const p of [...ps.hand, ...ps.temp]) {
    if (!p || p.kind !== 'token') continue;
    for (let n = p.count || 1; n > 0; n--) {
      yield;
      if (FRONT_SUPPORT_TOKENS.has(p.id)) {
        const spot = supportSpot(m, ps, p);
        if (!spot || !tryDo(() => ps.move(p.uid, { area: 'board', row: spot[0], col: spot[1] }, spot[2]))) break;
        continue;
      }
      const plan = yield* planLayoutSteps(m, ps, [p], LAYOUT_PARAMS, { occupied: new Set(ps.board.keys()) });
      const k = plan.get(p.uid);
      if (!k) break;
      const [r, c] = parseKey(k);
      if (!tryDo(() => ps.move(p.uid, { area: 'board', row: r, col: c }, planDir(plan, p.uid)))) break;
    }
  }
}

function equipItems(m, ps) {
  const gd = m.gd;
  const ctx = context(m, ps);
  const tried = new Set();
  for (let guard = 0; guard < 12; guard++) {
    const item = [...ps.hand, ...ps.temp].filter((p) => p && p.kind === 'item' && canUseItem(m, ps, p) && !tried.has(p.uid))
      .sort((a, b) => (bestEquipmentTarget(m, ps, b.id)?.score || 0) - (bestEquipmentTarget(m, ps, a.id)?.score || 0) || a.uid - b.uid)[0];
    if (!item) break;
    tried.add(item.uid);
    const rec = gd.item(item.id);
    if (rec && rec.itemType === 'MAGIC') {
      const copy = rec.buffs?.some((b) => b.key === 'trap_copy_front_char');
      if (!copy && ps.lp < m.gd.startLp(ps.bandId) * 0.7) continue;
      const board = [...ps.board.entries()].filter(([, p]) => p.kind === 'chess').sort(([, a], [, b]) => pieceValue(m, ps, b, ctx) - pieceValue(m, ps, a, ctx));
      let used = false;
      for (const [key] of board) {
        const [r, c] = parseKey(key);
        for (const [dr, dc] of rec.rangeGrid || [[0, 0]]) {
          if (!inRect(r - dr, c - dc)) continue;
          if (tryDo(() => ps.useArt(item.uid, r - dr, c - dc, 'RIGHT'))) { used = true; break; }
        }
        if (used) break;
      }
      continue;
    }
    const sacrifice = rec?.buffs?.some((b) => b.key === 'use_equip_recruit_new_char_and_give_char_to_player_most_bond');
    const candidates = sacrifice ? ps.allChess().filter((p) => ps.find(p.uid)?.area !== 'board' && benchValue(m, ps, p) < 1) : undefined;
    const target = bestEquipmentTarget(m, ps, item.id, candidates);
    if (!target) continue;
    tryDo(() => ps.equip(item.uid, target.piece.uid, target.replaceUid));
  }
}

function resolveTemp(m, ps) {
  for (let i = 0; i < ps.temp.length; i++) {
    const p = ps.temp[i];
    if (!p) continue;
    const idx = freeSlot(ps.hand);
    if (idx >= 0 && tryDo(() => ps.move(p.uid, { area: 'hand', idx }))) continue;
    if (p.kind === 'chess') {
      if (!sellWeakestHand(m, ps)) tryDo(() => ps.sell(p.uid));
      else {
        const j = freeSlot(ps.hand);
        if (j >= 0) tryDo(() => ps.move(p.uid, { area: 'hand', idx: j }));
      }
    } else if (p.kind === 'item') {
      tryDo(() => ps.destroy(p.uid));
    }
  }
  // anything left (e.g. sells failed): final sweep — tokens cannot be sold, they are dropped with the temp slot (and
  // come back at the next round start, PlayerState.startRound)
  for (let i = 0; i < ps.temp.length; i++) {
    const p = ps.temp[i];
    if (!p) continue;
    if (p.kind === 'chess') tryDo(() => ps.sell(p.uid));
    else if (p.kind === 'item') tryDo(() => ps.destroy(p.uid));
  }
  if (!ps.tempEmpty) ps.resolveTemp();
}
