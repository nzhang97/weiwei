// server/match/bot.js — AI player (DESIGN §6.6). Used for AI teammates and "AI 托管" (g.autoplay; a departed human
// is eliminated, Match._quit). Every action goes through the same validated
// PlayerState handlers a human uses; randomness only from the match's bot rng (deterministic per seed).
//
// It reads only what a player can see: its own state, the shop, the shared pool's copies left, the teammates' bond
// strips, and the round's enemy preview (composition and routes, research 06 §4.3 "查看当前回合即将迎击的敌方单位").
//
// Prep routine (botPrep):
//   1. take a pending reward offer (merge progress, bond synergy, tier)
//   2. economy. The bond plan (bondPlan): a focus core bond — owned members, members the shop can still bring at this
//      level, banked layers, last round's focus (commit instead of flip-flopping), minus a teammate's main core bond
//      (its bond strip; the shop pool is shared) — and a second bond (most owned members, next threshold within
//      reach). Keepers: the deployed operators, focus / second members, chess of tier ≥ shop level − 1. Sell bench
//      chess that neither make the lineup nor build toward something (a pair whose third copy can still come, a
//      keeper, an elite; ≤ BENCH_BUDGET spare units, pairs first), buy toward a full board (the deploy cap is 8 from
//      round 1), complete every merge it can afford — before a level-up can spend the funds —, level the 调度中心 on a
//      curve (free levels always; the −1/round discount is waited for early), then spend the rest (leftover funds are
//      lost at prep end; a band that keeps them, 坎诺特, holds its interest capital back — fundsReserve): with a full
//      board a purchase must be merge progress or a lineup upgrade AND worth more than the refreshes its price would
//      pay for — refreshValue: Σ over the held pairs of P(a refresh shows the third copy, the shop's copy-weighted odds
//      over the shared pool) × MERGE_HIT (an elite plus the merge's free pick of the next tier) — else it refreshes. A
//      third copy it cannot afford freezes the shop for the next round (maybeFreeze). Purchase scores: merge progress >
//      bond thresholds (focus, second) > role needs (blockers, anti-air when the wave flies, one or two healers) >
//      tier and armour fit (the share of a dealer's damage the round's DEF / RES lets through, effDps; an attack on every
//      enemy in range — 阵法术师 / 轰击术师 — counts double, splash and chain a little, CROWD). A merge that
//      consumes a deployed copy leaves the elite on that copy's tile (PRTS 卫戍协议/帮助, PlayerState._mergeChess):
//      nothing here assumes it in the hand — steps 3–4 plan it like any owned unit (kept, moved or benched).
//   3. lineup: the deployed set maximizes unit value (tier, elite, items, armour fit) + activated bond tiers (exact
//      counting via computeBonds; every deployed focus member counts toward the next threshold) + composition
//      (chooseLineup: greedy seed + swap hill-climbing).
//   4. placement (planLayout): the round's routes are traced over the own board from the enemy preview (ground
//      routes on the stage's device-aware ground paths, flying routes through their checkpoints; 近地悬浮 enemies walk
//      the ground path but count as flyers) and weighted by their enemies; an exposure model (tile time × DPS of the
//      covering units against the round's DEF / RES, blocker hold time, flyers only for anti-air) is maximized
//      greedily — blockers first, then damage dealers by DPS, then healers — over every
//      (legal tile, direction) pair of the server's deploy map (no 深水区). A MELEE operator is planned on the ground
//      tiles, where it blocks — except one whose trait reads 「可以放置于远程位」 (歌蕾蒂娅, 崖心, 见行者, any module:
//      placeClass 'all', shared/highGround.js), which takes a 高台 whose range covers the enemy road, else the ground
//      (owner 2026-10-04 for the 高台 preference, 2026-10-05 for who may use one). It stays a blocker in the lineup
//      (basePositionClass). A blocker whose range grid is its own tile only (range 0-1: 角峰, 古米, 泡泡, 折桠, 菲莱, 蛇屠箱,
//      塞雷娅, 余) is planned on a free tile of the enemy road first: off it nothing is blocked or hit. Each unit's range grid — the one it is
//      deployed with, rangeRec (loadoutRecord attackRangeGrid) — is rotated per direction (DESIGN §3; RIGHT is tried first
//      and kept on ties, so symmetric ranges and melee units whose front adds nothing stay facing the gates), so
//      ranged units turn toward the enemy path tiles they cover best and blockers toward the road; on 气流 tiles
//      (act2 m01 blowers) the DPS is scaled by the blower ATK bonus of that direction (with / against / across). The last
//      arrangement of a prep REHEARSES up to m.botRehearsal distinct layout variants with the real Battle (rehearsal
//      seed, no meta dispatch, board restored exactly) and keeps the one with the fewest leaks. The default plan is
//      placed first; Match steps the rehearsal in wall-clock-bounded slices (botPrepBegin → job.run → botPrepEnd) so
//      whole simulated battles never block the server's event loop. The prep routine itself is sliced the same way:
//      botPrepBeginSteps / botPrepEndSteps (and planLayoutSteps, arrangeSteps, createRehearsalSteps) are step
//      generators that yield between whole actions (never with a transient board) — the same actions in the same
//      order as the one-shot functions (runSteps), hence the same rng draws and decisions.
//      The summon cards of the placed operators (赫默's 医疗探机, 伺夜's 狼群 …; user playtest #6) are placed after
//      them on the best remaining tiles — a tactician's 援军 (狼群 / 流形) only on a tile of its owner's attack range
//      (its tactical point: PlayerState.summonRange, the server's legality; player report #9 after 0.1.0) —, 凯瑟琳's
//      支援装置 next to the best operator no device faces yet, facing it. Legality is the server's: the bot plans on the deploy map (board.js legalTiles) and
//      a tile g.move refuses is skipped for the next best one.
//   5. items by what they do (itemTarget): equipment on the strongest deployed damage dealers (survival items on
//      blockers, bond signature items on a member), 信标 on a bench single, 拟态物质 on a pair, 博士投影 (both
//      qualities) on the strongest normal operator, 突变细胞 on the least valuable normal single below 6阶 (cellTarget:
//      never an elite or a pair member; the operator its transformation gains joins the bench — the buy loop's bench
//      shed leaves a piece gained since the last prep alone, rememberOwned — and steps 3–4 of the next prep deploy it
//      like any owned unit), bond items on a focus member; Arts (useArt): 画卷 copies the most valuable
//      deployed operator, 教鞭 / “神秘顾客” are used after a perfect battle and kept otherwise (consume-on-equip items /
//      Arts only with a handler)
//   6. resolve the temp slots (a 突变细胞 left there — it comes back after every transformation — gets a hand slot made
//      for it, makeHandRoom, instead of being destroyed), keep one hand slot free (freeHandSlot: a kept bounty Art goes
//      before a chess on a bot's own seat, never on a human's seat under AI 托管), then Ready.
// Strategy (botPickBand): weighted by starting LP among the offered bands; never one whose mechanic rides on a bond the
// mode switches off (gd.bandBondIds = bands.json bondIds: the bond its text names in <…> or its blackboards name — 标准's
// 潘格尼尼, 克莱门莎, 玛恩纳; DESIGN §21.26); alone, 老鲤's withheld first-round funds only rarely (× 0.02).
// 机变 (botPickCard): a bounty by its expected payout minus the expected LP lost — bountyKillChance runs the exposure
// model for that one enemy against the own board; a card the board is unlikely to beat wins only when nothing better
// is offered or it pays much more —; tactic cards by what they act on (a 盟誓 / 驰援 card on the own bonds, 升华 …);
// items by tier and use.
// V3 cooperative strategy layer (ported from the fork onto 0.2.5; docs/AI-AUDIT.md, docs/PORT_NOTES_AI.md): the decisions
// above keep upstream's mechanisms and add the fork's policy layer — botPolicy.js (Match.botPolicy = BOT_POLICY ⊕
// byDifficulty[difficulty] in co-op ⊕ opts.botPolicy; per-band playbooks botPolicy.bandPolicy applied as an overlay for
// the whole prep, withOverlay), botStrategy.js (band score, core plan, layer / trait / economy / equipment values,
// projected combat records), botTeam.js (relay duty for an idle teammate, blankProtect) and botBoss.js (final-assault
// rehearsal). The last arrangement rehearses roster/layout variants with the real Battle (read-only team context,
// combat layers isolated inside Battle, board restored exactly). Measured strength: docs/AI-AUDIT.md.
// Placement quality (tools/matchrun sweeps, research-faithful waves): the planner beats random layouts by ≈ 8 points
// of kill rate and rehearsal adds ≈ 5 more; see docs/META.md §1.5. Old vs new decisions on the same seeds:
// tools/botbench.mjs.

import { GEO } from '../../shared/constants.js';
import { deriveSeed } from '../sim/rng.js';
import { ASPD_MIN, ASPD_MAX } from '../sim/constants.js';
import { freeSlot, countFree, legalTiles, canPlace, positionClass, placeClass, basePositionClass, parseKey, tileKey, FIELD, pieceDir, boardTileOf, BOSS_MIRROR_COL } from './board.js';
import { rotateOffset, normDir, mirrorDir, oppositeDir } from '../sim/dir.js';
import { itemKey } from './gamedata.js';
import { pieceBonds } from './bondsMeta.js';
import { resolveProfile } from '../sim/professions.js';
import { makeCtx } from './effectsMeta.js';
import { withBounties, isFlyKey } from './waves.js';
import { mitigate } from '../sim/damage.js';
import { HOVER_KEYS } from '../sim/content/enemies.js';
import { attackRangeGrid, loadoutRecord, resolveRecordLoadout } from '../../shared/loadoutRecord.js';
import { BOT_POLICY } from './botPolicy.js';
import { createBossRehearsalSteps } from './botBoss.js';
import { relayCarryValue, relayUpgradeWanted, createRelayRehearsal, relayDefenseValue } from './botTeam.js';
import { bandScore, hiddenDrive, corePlan, coreReserveValue, coreUpgradeWanted, economyRecruitValue, garrisons, lineupState, layerValue, traitValue, recurringValue, combatBondValue, combatRecord, benchValue, refreshValue as strategyRefreshValue, bestEquipmentTarget } from './botStrategy.js';

/** The match's AI policy (Match.botPolicy); a stub match without one uses the defaults. */
const pol = (m) => m.botPolicy || BOT_POLICY;

/**
 * Drive a step generator (planLayoutSteps, createRehearsalSteps, arrangeSteps, botPrepBeginSteps …) to its end in one
 * go and return its value — the synchronous form every step generator also has (tools, tests, botPrep).
 */
export function runSteps(gen) {
  let r;
  do r = gen.next(); while (!r.done);
  return r.value;
}

// (upstream FOCUS_MEMBER — the lineup value per deployed focus member — is replaced by V3's focus term in lineupScore)


/** Value per unit of armour fit (the share of a dealer's damage the round's DEF / RES lets through, armorFit). */
const ARMOR_WEIGHT = 10;

/** Least buy score of a purchase once the board is full (below it the bot refreshes instead). */
const BUY_FULL_MIN = 8;

/**
 * Value of completing an elite (+25 % stats, skill level 7, and the merge's free pick of three tier min(level + 1, 6)
 * chess — worth having for any pair, a cheap one included) and of making a keeper's pair; refreshValue weighs them by
 * the shop odds.
 */
const MERGE_HIT = 36;

const PAIR_HIT = 8;

/** Pairs the bench holds at once while refreshes hunt their third copies (each takes a hand slot or two). */
const MAX_PAIRS = 4;

/** Refreshes per prep at most (funds bound them first). */
const MAX_REFRESHES = 16;

/** Spare bench units kept beyond the lineup at the prep start (pairs first). */
const BENCH_BUDGET = 6;

/** Shop level the bot aims for at the start of round r (index = round). */
const LEVEL_TARGET = [1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 6];

/**
 * AI 托管 of a human with 自选 picks (0.2.0; bots field none): the buy score of one of the player's own slotted pieces —
 * the operator the player chose to field (follow-up #13: under AI 托管 they were rarely bought) — and the 调度中心 is
 * levelled one round earlier for the step that opens a slotted tier (levelUp).
 */
export const DIY_PIECE_BONUS = 12;

const TIER_POWER = [0, 10, 12.5, 15, 18, 21.5, 25];

const DEFAULT_MELEE_RANGE = [[0, 0], [0, 1]];

/**
 * Band pick among the strategies the mode offers (gd.bandIds): weighted by starting LP (sturdier strategies are
 * preferred). Alone, a band that withholds the first rounds' funds (老鲤 "资金暂存": no operator in R1–R2, every enemy
 * leaks) is avoided — only 联防 teammates cover that. A band whose mechanic rides on a bond the mode switches off
 * (gd.bandBondIds ∩ gd.modeInactiveBonds — 标准: 潘格尼尼 <拉特兰>, 克莱门莎 <阿戈尔>, 玛恩纳 <卡西米尔>) weighs 0, never taken
 * (DESIGN §21.26). [ASSUMED] A living teammate's opening strategy soft-reserves those bonds before anyone is deployed:
 * the weight stays positive, at a quarter of the unreserved weight, so the strategy can still be drawn, and the
 * reservation ends when that teammate is eliminated (alivePlayers). With every band excluded, the default band. One
 * rng draw per call (deterministic per seed); a solo match has no teammate to reserve against.
 */
const SOFT_BAND_RESERVE = 0.25;

export function botPickBand(m, ps) {
  const gd = ps?.gd || m.gd;
  const P = pol(m);
  const all = gd.bandIds();
  // (V3) a strategy a teammate already took is never scored (the caller re-draws on 队友已选 anyway)
  const ids = ps && typeof m.bandTaken === 'function' ? all.filter((id) => !m.bandTaken(id, ps.playerId)) : all;
  // botPolicy.forceBands: { [seat]: bandId } (experiments: randomised strategy assignment)
  const forced = ps ? (P.forceBands?.[ps.seat] ?? P.forceBands?.[String(ps.seat)]) : null;
  if (forced && ids.includes(forced)) return forced;
  if (!ids.length) return gd.defaultBandId;
  const lateFunds = (id) => /暂存/.test(String(gd.band(id)?.desc || ''));
  const reserved = new Set(ps && typeof m.alivePlayers === 'function'
    ? m.alivePlayers().filter((p) => p !== ps).flatMap((p) => gd.bandBondIds(p.bandId))
    : []);
  const inactive = (id) => gd.bandBondIds(id).some((b) => gd.modeInactiveBonds.has(b));
  // V3 decision layer: softmax over bandScore (botStrategy.js); upstream's exclusions below still apply
  // (botPolicy.bandScoring: on in the tuned co-op table byDifficulty.ABYSS; elsewhere upstream's starting-LP draw)
  const v3 = !!ps && P.bandScoring === true && Array.isArray(m.order);
  const scores = v3 ? new Map(ids.map((id) => [id, bandScore(m, ps, id)])) : null;
  const top = v3 ? Math.max(...scores.values()) : 0;
  const temp = P.bandTemperature?.[m.difficulty] || (m.difficulty === 'ABYSS' ? 2 : 7);
  const pairs = ids.map((id) => {
    if (inactive(id)) return [id, 0];
    const w = v3 && Number.isFinite(top)
      ? Math.exp((scores.get(id) - top) / temp)
      : Math.max(1, (gd.startLp(id) - 18) ** 2) * (m.isSolo && lateFunds(id) ? 0.02 : 1);
    return [id, gd.bandBondIds(id).some((b) => reserved.has(b)) ? w * SOFT_BAND_RESERVE : w];
  });
  let total = 0;
  for (const [, w] of pairs) total += w;
  let r = m.rngBots() * total;
  if (!(total > 0)) return gd.defaultBandId;
  let last = null;
  for (const [id, w] of pairs) {
    if (!(w > 0)) continue;
    last = id;
    r -= w;
    if (r < 0) return id;
  }
  return last;
}

/**
 * 机变 card pick among the untaken indexes (a draft is one family: generateDraft). Bounties (extra enemies in the own
 * next battles) score their expected payout minus the expected LP lost (bountyScore: the enemy against the own board —
 * an expected-value comparison, so a card the board is unlikely to beat is taken only when no better one is offered or
 * its pay outweighs the expected leaks); items by tier and use (an item the bot cannot use is worth little); tactic
 * cards by what they act on (tacticScore: a 盟誓 / 驰援 card on the own bonds, 升华 …). Across families items and team
 * buffs come before bounties.
 */
export function botPickCard(m, ps, cards, available) {
  let best = available[0];
  let bestScore = -Infinity;
  for (const i of available) {
    const c = cards[i];
    if (!c) continue;
    let s = 0;
    // V3: an item by its best equipment target among the owned chess (botStrategy bestEquipmentTarget)
    if (c.kind === 'item') s = (m.gd.item(c.id) ? (bestEquipmentTarget(m, ps, c.id, ps.allChess())?.score || 0) : 8 + (c.tier || 1) * 4) + (canUseItem(m, ps, { id: c.id }) ? 0 : -8);
    else if (c.kind === 'bounty') {
      s = bountyScore(m, ps, c);
      // V3: no extra enemies while the own LP is low
      if (ps.lp < m.gd.startLp(ps.bandId) * 0.4) s -= 10 + (c.count || 1) * 2;
    }
    else if (c.kind === 'tactic') s = v3TacticScore(m, ps, c) ?? tacticScore(m, ps, c);
    s += m.rngBots() * 0.5;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

/**
 * V3 valuation of a 盟誓-type tactic card (global_special_choice_bond_addlayer): the layers by layerValue (botStrategy:
 * the core plan, phase weights and layer milestones) — for a team card also the living teammates' — plus coins / free
 * refreshes. null for every other card: upstream's tacticScore decides.
 */
function v3TacticScore(m, ps, c) {
  const buffs = m.gd.effect(c.effectId ?? c.id)?.buffs || [];
  if (!buffs.some((b) => b && b.key === 'global_special_choice_bond_addlayer')) return null;
  let s = (c.team ? 12 : 8) + (c.tacticKind === 'ally' ? 4 : 0);
  for (const buff of buffs) {
    const p = { ...buff.bb, ...buff.bbStr };
    if (buff.key === 'global_special_choice_bond_addlayer') {
      const ids = String(p.bond_list || '').split(',').map((x) => x.trim()).filter(Boolean);
      s = ids.reduce((n, id) => n + layerValue(m, ps, id, p.count), 0) * 2;
      if (c.team) for (const mate of m.order || []) if (mate !== ps && mate.alive) s += ids.reduce((n, id) => n + layerValue(m, mate, id, p.count), 0);
    } else if (buff.key === 'global_special_choice_gain_coin') s += (p.count || 0) * 2;
    else if (buff.key === 'global_special_choice_refresh_free') s += (p.count || 0) * 2;
  }
  return s;
}

/**
 * Chance that the own board as it stands (the 机变 draft comes before the prep) kills one enemy of a bounty card: the
 * planner's exposure model (Layout) for that single enemy — its HP × the round's multiplier against Σ over the tiles of
 * its route (the busiest route of its kind: flyers the flying routes, else the ground ones) of the time it spends there
 * × the DPS of every deployed unit covering the tile against its DEF / RES (dpsVs; flyers anti-air only), plus the
 * first blocker's hold on the ground. 0.5 without data.
 */
export function bountyKillChance(m, ps, card) {
  const gd = ps?.gd || m.gd;
  const e = card && gd.enemy(card.enemyKey);
  if (!e || !e.stats) return 0.5;
  const model = fieldModel(m, ps);
  const sc = gd.enemyScale(m.round);
  const hp = Math.max(1, (e.stats.maxHp || 1000) * sc.hpMul);
  const def = e.stats.def || 0;
  const res = e.stats.res || 0;
  const fly = isFlyKey(gd, card.enemyKey) || HOVER.has(card.enemyKey);
  const same = model.routes.filter((r) => !!r.fly === fly);
  const pool = same.length ? same : model.routes;
  if (!pool.length) return 0.5;
  const route = pool.reduce((a, b) => (b.n > a.n ? b : a));
  const speed = Math.max(0.05, (e.stats.moveSpeed || 1) * sc.speedMul);
  const tileTime = Math.max(0.4, Math.min(6, 1 / (speed * 0.5)));
  const units = [];
  for (const [k, p] of ps.board) {
    const rec = p.kind === 'token' ? gd.token(p.id) : rangeRec(ps, gd.chess(p.id));
    if (!rec) continue;
    const [r, c] = parseKey(k);
    const u = unitOf(rec, k, r, c, pieceDir(p), model);
    u.vs = dpsVs(rec, def, res) * u.atkMul;
    units.push(u);
  }
  let exp = 0;
  let held = false;
  for (const k of route.tiles) {
    let t = tileTime;
    if (!fly && !held && units.some((u) => u.block > 0 && u.key === k)) { t += LAYOUT_PARAMS.hold; held = true; }
    let dps = 0;
    for (const u of units) if (u.cover.has(k) && (fly ? u.air : u.ground)) dps += u.vs;
    exp += t * dps;
  }
  return 1 - Math.exp(-exp / (BOUNTY_KILL * hp));
}

/** Exposure (× HP) a bounty enemy needs for a 63 % kill chance (conservative: it fights beside the wave). */
const BOUNTY_KILL = 2;

/**
 * Expected value of a bounty card: per battle it lasts, P(kill) × coin (kill payout) or P(kill)^n × coin (perfect
 * payout) minus the expected leaks × the value of an LP (2 + 20 / LP: dearer when low).
 */
function bountyScore(m, ps, card) {
  const p = bountyKillChance(m, ps, card);
  const n = Math.max(1, card.count || 1);
  const battles = Math.max(1, Math.min(3, card.rounds || 1));
  const lpCost = 2 + 20 / Math.max(1, ps.lp);
  const coin = Math.max(0, card.coin || 0);
  const gain = card.payout === 'perfect' ? p ** n * coin : p * n * coin;
  return battles * (gain - (1 - p) * n * lpCost);
}

/** 机变 tactic card value by its effect (data/effects.json buffs), team cards a little more (teammates get it too). */
function tacticScore(m, ps, card) {
  const eff = m.gd.effect(card.id);
  const buffs = eff && Array.isArray(eff.buffs) ? eff.buffs.filter(Boolean) : [];
  const owned = ownedBonds(m, ps);
  const plan = bondPlan(m, ps, owned);
  const rel = (b) => (b === plan.focus ? 1 : b === plan.second ? 0.7 : (ps.bonds[b] && ps.bonds[b].active) ? 0.5 : owned.counts.get(b) ? 0.25 : 0.05);
  let s = 8;
  for (const b of buffs) {
    const bb = b.bb || {};
    const bs = b.bbStr || {};
    const count = Number.isFinite(bb.count) ? bb.count : 1;
    switch (b.key) {
      case 'global_special_choice_bond_addlayer': {
        let r = 0;
        for (const id of String(bs.bond_list || '').split(',').map((x) => x.trim()).filter(Boolean)) r = Math.max(r, rel(id));
        s = 4 + r * count * 1.2;
        break;
      }
      case 'single_special_choice_gain_bond_chess': s = 5 + rel(bs.bond) * 10; break;
      case 'single_special_choice_gloden_char_chess': s = 16; break;
      case 'single_special_choice_gloden_equip_chess': s = 9; break;
      case 'global_special_choice_gain_equip': s = 10; break;
      case 'global_special_choice_refresh_free': s = 7 + count * 0.5; break;
      case 'global_special_choice_gain_coin': s = 4 + count; break;
      // 锐利 needs an empty hand at the prep end — the bot keeps a bench
      case 'global_special_choice_prep_finish_bench_at_most': s = 3; break;
      default: break;
    }
  }
  return s + (card.team ? 3 : 0);
}

// ---------------------------------------------------------------------------------------------------
// evaluation helpers

// a player's record of a chess id (its data view: a human's slotted 自选 slots are its operators, 0.2.0 player/diy.js)
const chessRec = (m, id, ps = null) => (ps?.gd || m.gd).chess(id);

const isHealer = (c) => !!c && (c.dmgType === 'heal' || c.attackKind === 'heal');

// the record's own position: a 钩索师 / 推击手 is a MELEE blocker like any other (a 高台 does not block)
const isBlocker = (c) => !!c && basePositionClass(c) === 'melee' && (c.stats?.blockCnt ?? 1) > 0 && c.attackKind !== 'none';

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
    const c = chessRec(m, p.id, ps);
    for (const b of (c && c.bonds) || []) counts.set(b, (counts.get(b) || 0) + 1);
  }
  return { counts, bases: seen };
}

/**
 * Per bond, from one pass over the shared pool: `reach` = distinct unowned members of tier ≤ shop level + 1 with copies
 * left (what the shop can still bring soon — a teammate draining a bond, or a bond of high-tier members only, makes it
 * a poor target), `supply` = the copies left of all its members.
 */
function bondPoolStats(m, ps, owned) {
  const reach = new Map();
  const supply = new Map();
  const maxTier = Math.min(6, ps.shop.level + 1);
  for (const [id, e] of m.pool.entries) {
    if (!(e.left > 0)) continue;
    const c = m.gd.chess(id);
    if (!c || !Array.isArray(c.bonds)) continue;
    const reachable = c.tier <= maxTier && !owned.bases.has(m.gd.baseIdOf(id));
    for (const b of c.bonds) {
      supply.set(b, (supply.get(b) || 0) + e.left);
      if (reachable) reach.set(b, (reach.get(b) || 0) + 1);
    }
  }
  return { reach, supply };
}

/**
 * A teammate's main core bond as every player sees it (its public bond strip, ps.bonds): the core bond with the most
 * counted members, ≥ 2 (ties: data order); null when it builds none yet. Humans and bots alike.
 */
function mainCoreBond(m, p) {
  let top = null;
  let topN = 1;
  for (const id of m.gd.bondIds) {
    const b = p.bonds && p.bonds[id];
    const n = b ? b.count || 0 : 0;
    if (n > topN && m.gd.bond(id)?.isCore) { topN = n; top = id; }
  }
  return top;
}

/**
 * The bonds the bot builds around (cached per round and owned set): `focus` = the core bond with the best
 * owned members × 10 + reachable members (bondPoolStats, ≤ 4) + layers already banked (≤ 6) + 6 for last round's focus
 * (commit instead of flip-flopping between equal bonds) − 6 when a teammate already builds it (its main core bond on
 * its public bond strip, mainCoreBond — the shop pool is shared) or has selected that bond's opening strategy, even
 * before anyone is deployed. The strategy reservation ends when that teammate is eliminated. `second` = the other live
 * bond (core or add-on) with the most owned members whose next threshold is within reach (≥ 1 owned member).
 * `ps._botFocusId` keeps the focus across rounds.
 */
export function bondPlan(m, ps, owned = ownedBonds(m, ps)) {
  const livingBands = m.alivePlayers().filter((p) => p !== ps).flatMap((p) => m.gd.bandBondIds(p.bandId)).sort().join();
  const key = `${m.round}|${ps.shop.level}|${[...owned.counts.entries()].map(([k, v]) => k + v).join()}|${livingBands}`;
  if (ps._botFocus && ps._botFocus.key === key) return ps._botFocus;
  const prev = ps._botFocusId ?? null;
  const mates = new Set();
  for (const p of m.alivePlayers()) {
    if (p === ps) continue;
    const b = mainCoreBond(m, p);
    if (b) mates.add(b);
    for (const id of m.gd.bandBondIds(p.bandId)) mates.add(id);
  }
  let focus = null;
  let bestS = 0;
  const pool = bondPoolStats(m, ps, owned);
  for (const id of m.gd.bondIds) {
    const b = m.gd.bond(id);
    if (!b || !b.isCore || m.gd.modeInactiveBonds.has(id)) continue;
    const k = owned.counts.get(id) || 0;
    if (!k) continue;
    const s = k * 10 + Math.min(4, pool.reach.get(id) || 0) + Math.min(6, (ps.layers[id] || 0) / 10)
      + (id === prev ? 6 : 0) - (mates.has(id) ? 6 : 0) + Math.min(0.9, (pool.supply.get(id) || 0) / 100);
    if (s > bestS) { bestS = s; focus = id; }
  }
  let second = null;
  let bestK = 0;
  for (const id of m.gd.bondIds) {
    if (id === focus || m.gd.modeInactiveBonds.has(id)) continue;
    const b = m.gd.bond(id);
    if (!b || b.thresholdTemplate === 'count_threshold_downward' || !Array.isArray(b.thresholds) || !b.thresholds.length) continue;
    const k = owned.counts.get(id) || 0;
    if (!k) continue;
    const next = b.thresholds.find((t) => t > k);
    const s = k * 10 + (next != null && next - k <= 1 ? 5 : 0) + (b.isCore ? 0 : 2);
    if (s > bestK) { bestK = s; second = id; }
  }
  if (focus) ps._botFocusId = focus;
  ps._botFocus = { key, focus, second };
  return ps._botFocus;
}

/** Copies a merge takes (3; 风丸 2). */
const mergeNeed = (m, base) => m.gd.mergeCount(base) || 3;

/**
 * Bases worth merging ("keepers"): the deployed operators, the owned members of the focus / second bond, and owned
 * chess of a tier ≥ shop level − 1. A pair of anything else only clutters the bench and is sold later at a loss
 * (every sale returns 1).
 */
function keeperBases(m, ps, plan) {
  const out = new Set();
  for (const p of ps.board.values()) if (p.kind === 'chess') out.add(m.gd.baseIdOf(p.id));
  for (const p of ps.allChess()) {
    const c = chessRec(m, p.id, ps);
    if (!c) continue;
    const bonds = c.bonds || [];
    if ((plan.focus && bonds.includes(plan.focus)) || (plan.second && bonds.includes(plan.second)) || c.tier >= ps.shop.level - 1) out.add(m.gd.baseIdOf(p.id));
  }
  return out;
}

/** Role census of the owned chess. */
function roles(m, ps) {
  const r = { blockers: 0, antiAir: 0, healers: 0, total: 0 };
  for (const p of ps.allChess()) {
    const c = chessRec(m, p.id, ps);
    if (!c) continue;
    r.total++;
    if (isBlocker(c)) r.blockers++;
    if (hitsFly(c)) r.antiAir++;
    if (isHealer(c)) r.healers++;
  }
  return r;
}

/**
 * Bond value of adding chess `c` to what is owned (owned counts exclude it). `second`: the second bond (bondPlan);
 * once the focus has 3 owned members a member of another core bond is worth less unless it reaches a threshold (the
 * deploy cap holds about 6 members of one core bond + 2 others).
 */
function bondValue(m, c, owned, focus, second = null) {
  let v = 0;
  const committed = focus && (owned.counts.get(focus) || 0) >= 3;
  // V3: phase-dependent recruitment weights (botPolicy.coreRecruitWeights / addonRecruitWeight) and a stronger focus
  const P = pol(m);
  const phase = m.round <= 4 ? 'early' : m.round <= 8 ? 'middle' : 'late';
  for (const b of (c && c.bonds) || []) {
    const bond = m.gd.bond(b);
    if (!bond || m.gd.modeInactiveBonds.has(b)) continue;
    const n = owned.counts.get(b) || 0;
    const th = Array.isArray(bond.thresholds) && bond.thresholds.length ? bond.thresholds : [bond.activeCount || 2];
    const recruitment = bond.isCore ? (P.coreRecruitWeights?.[phase] ?? 1) : (P.addonRecruitWeight ?? 1);
    const w = (b === focus ? 2.2 : bond.isCore ? 1.1 : 0.7) * recruitment;
    v += (2 + n * 2) * w;
    const hits = th.includes(n + 1);
    if (hits) v += 10 * w;
    else if (th.some((t) => t > n + 1 && t - (n + 1) <= 1)) v += 3 * w;
    if (bond.thresholdTemplate === 'count_threshold_downward') v -= n > 0 ? 12 : 0; // 独行 breaks with a second member
    if (b === focus) v += 18 * recruitment;
    else if (b === second) v += 4;
    else if (committed && bond.isCore && !hits) v -= 4;
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

/** Bounded opening attack estimate from the selected skill blackboard; rehearsal handles conditional mechanics. */
export function operatorCombatPower(c, skillWeight = 1) {
  if (!c?.stats || isHealer(c)) return 0;
  const profile = resolveProfile({ ...c, subProf: c.subProfessionId });
  if (profile.noAttack || (c.attackKind === 'none' && !profile.noAttackUnlessSkill)) return 0;
  const st = c.stats, bat = Math.max(0.2, (st.bat || 1) * 100 / Math.max(ASPD_MIN, Math.min(ASPD_MAX, st.aspd || 100)));
  const base = Math.max(0, st.atk || 0) / bat * Math.max(0, c.botDamageScale ?? 1);
  const skill = c.skill, bb = skill?.bb || {};
  const normal = profile.noAttackUnlessSkill ? 0 : base;
  let estimate = normal;
  if (skill && skillWeight > 0) {
    const duration = Math.max(0, skill.duration || 0), cost = Math.max(1, skill.spCost || 1);
    const recovery = skill.spType === 'INCREASE_WHEN_ATTACK' ? 1 / bat : skill.spType === 'INCREASE_WITH_TIME' ? Math.max(0.1, st.spRecovery || 1) : 0.5;
    const cycle = cost / recovery;
    const wait = Math.max(0, cost - (skill.initSp || 0)) / recovery;
    const uptime = Math.min(1, Math.max(0, 1 - wait / 90)) * (duration > 0 ? duration / (duration + cycle) : Math.min(1, bat / cycle));
    const multi = Math.max(1, Math.min(6, bb['attack@times'] || 1));
    const targets = Math.max(1, Math.min(3, bb['attack@max_target'] || 1));
    const scale = Math.max(0.1, Math.min(4, bb['attack@atk_scale'] ?? bb.atk_scale ?? 1));
    const skillBat = Math.max(0.2, (st.bat || 1) + (bb.base_attack_time || 0));
    const rate = (st.bat || 1) / skillBat;
    const ramp = profile.noAttackUnlessSkill && profile.rampMax ? 1 + profile.rampMax * Math.min(1, wait / Math.max(1, profile.rampTime || 40)) * Math.max(1, bb.trait_up || 1) : 1;
    const burst = base * Math.max(0.1, 1 + (bb.atk || 0)) * scale * multi * targets * rate * ramp;
    estimate += Math.min(1.5, skillWeight) * uptime * (burst - normal);
  }
  return Math.max(0, Math.min(30, 10 * Math.log1p(Math.max(0, estimate) / 300)));
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

export function botWaveWeight(m) {
  return (pol(m).waveFitWeight ?? 1) * (m.round >= m.gd.bossRound ? (pol(m).bossWaveFitWeight ?? 1) : 1);
}

/** Estimate an actual projected lineup's static buffs; this never changes battle inputs or game records. */
export function botUnitRecord(m, ps, piece, bonds = ps.bonds, rosterSize = ps.deployCount) {
  return pol(m).projectedUnitPower ? combatRecord(m, ps, piece, bonds, rosterSize) : chessRec(m, piece.id);
}

/** Stand-alone value of an owned piece (no bond context): power, items, role fit, layer engines. */
function unitBase(m, ps, piece, ctx, projection = null) {
  const P = pol(m);
  const c = chessRec(m, piece.id, ps || ctx.ps);
  if (!c) return 0;
  // V3: the projected lineup's static bond buffs (botUnitRecord), combat power and wave fit
  let effective = c;
  if (P.projectedUnitPower) {
    const cache = ctx.powerRecords ||= new Map();
    const key = `${projection?.key ?? 'current'}:${piece.uid ?? 'probe'}:${piece.id}:${(piece.items || []).map(i => i.id).join(',')}`;
    if (!cache.has(key)) cache.set(key, botUnitRecord(m, ps, piece, projection?.bonds || ps.bonds, projection?.rosterSize ?? ps.deployCount));
    effective = cache.get(key);
  }
  let v = power(c) + (piece.items ? piece.items.length * 5 : 0);
  if (P.combatPowerWeight > 0) v += P.combatPowerWeight * operatorCombatPower(effective, P.skillPowerWeight ?? 1);
  if (ctx.model) v += waveFit(effective, ctx.model) * botWaveWeight(m);
  if (c.attackKind === 'none' && !isHealer(c)) v -= 6;
  if (ctx.fly > 0 && hitsFly(c)) v += 2;
  // upstream: armour fit of a damage dealer against the round's DEF / RES (kept alongside V3's waveFit)
  if (ctx.model && !isHealer(c)) v += ARMOR_WEIGHT * (armorFit(ctx.model, c) - 0.6);
  return v;
}

/** Value of an owned piece for bench / sell decisions (its bonds counted against the other owned chess). */
function pieceValue(m, ps, piece, ctx) {
  const c = chessRec(m, piece.id, ps);
  if (!c) return 0;
  return unitBase(m, ps, piece, ctx) + bondValue(m, c, ownedBonds(m, ps, piece.uid), ctx.focus, ctx.second) * 0.8 + recurringValue(m, ps, piece);
}

/**
 * Score of a deployed set: unit values + the bonds it activates (exact tiers via bondsMeta.computeBonds, hand
 * members still count for BOARD_AND_DECK bonds) + composition (blockers, anti-air when the wave flies, ≤ 2 healers).
 */
function lineupScore(m, ps, set, ctx, projected = null) {
  const gd = ps?.gd || m.gd;
  const { board, hand, bonds } = projected || lineupState(m, ps, set);
  let v = 0;
  const projection = pol(m).projectedUnitPower ? { bonds, rosterSize: set.length, key: `${set.length}|${Object.entries(bonds).filter(([,b]) => b.active).map(([id,b]) => `${id}:${b.count}:${b.tier}:${b.layers}`).join('|')}` } : null;
  const recCap = pol(m).battleLayerYield?.recurringCap ?? 10;
  for (const p of set) v += unitBase(m, ps, p, ctx, projection) + Math.min(recCap, recurringValue(m, ps, p, { board, hand, bonds }));
  for (const p of hand) if (p.kind === 'chess') v += recurringValue(m, ps, p, { board, hand, bonds, bench: true });
  for (const [id, b] of Object.entries(bonds)) {
    if (!b.tier) continue;
    const bond = gd.bond(id);
    // Per-tier weights (botPolicy.coreTierWeight / addonTierWeight; defaults 8 / 2): same-round swap replays measure an
    // add-on tier at about two operator tiers of leak reduction, a core tier at about three.
    const w = id === ctx.focus ? 20 * (pol(m).coreActivationWeight ?? 1) : bond?.isCore ? (pol(m).coreTierWeight ?? 8) : (pol(m).addonTierWeight ?? 2);
    v += b.tier * w;
  }
  // every deployed focus member counts on the way to the core target (upstream FOCUS_MEMBER's idea; V3 weights)
  if (ctx.focus) {
    const state = bonds[ctx.focus], target = ps._botCore?.target || 3;
    v += Math.min(target, state?.count || 0) * 3;
    if (state?.count >= target && target > 3) v += 35;
  }
  v += combatBondValue(m, set, bonds, ps);
  let blockers = 0;
  let air = 0;
  let healers = 0;
  for (const p of set) { const c = chessRec(m, p.id, ps); if (isBlocker(c)) blockers++; if (hitsFly(c)) air++; if (isHealer(c)) healers++; }
  const routes = ctx.model?.routes || [];
  const groundRoutes = routes.filter((r) => !r.fly);
  const lanes = new Set(groundRoutes.map((r) => r.tiles.at(-1))).size;
  v -= Math.max(0, Math.min(Math.max(1, lanes), 3, ctx.roles.blockers) - blockers) * 15 * (pol(m).rolePenaltyWeight ?? 1);
  const flyRatio = ctx.fly / Math.max(1, routes.reduce((n, r) => n + r.n, 0));
  if (ctx.fly > 0) v -= Math.max(0, Math.min(ctx.roles.antiAir, flyRatio > 0.45 ? 3 : 2) - air) * 13 * (pol(m).rolePenaltyWeight ?? 1);
  if (blockers >= 2 && ctx.roles.healers > 0 && healers === 0) v -= 10;
  v -= Math.max(0, healers - 2) * 10;
  // botPolicy.hiddenLayerDrive.finalBonus: at the R14 prep a lineup whose Σ active layers clears the 隐秘核心 threshold
  const drive = ctx.hiddenDrive;
  if (drive?.finalBonus && m.round === gd.bossRound) {
    let L = 0;
    for (const b of Object.values(bonds)) if (b.active) L += b.layers || 0;
    if (L > drive.threshold) v += drive.finalBonus;
  }
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
  for (const id of (ps?.gd || m.gd).bondIds) {
    const rec = (ps?.gd || m.gd).bond(id);
    if (rec.isCore || rec.countMode !== 'BOARD' || (ps?.gd || m.gd).modeInactiveBonds.has(id)
      || (current.bonds[id]?.tier || 0) >= (rec.thresholds?.length || 1)) continue;
    const members = ranked.filter(p => pieceBonds(m.gd, p).includes(id));
    const a = required == null ? members[0] : members.find(p => p.uid === required);
    const b = a && members.find(p => p.uid !== a.uid && (ps?.gd || m.gd).baseIdOf(p.id) !== (ps?.gd || m.gd).baseIdOf(a.id));
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
/**
 * (V3 cost) chooseLineup is pure in its inputs — the owned pieces and their items, the layers, the plan, the field model,
 * the policy — and V3's prep arranges up to four times: an unchanged input reuses the last result (copies of it).
 */
function lineupMemoKey(m, ps, ctx) {
  const piece = (p) => (p ? `${p.uid}:${p.id}:${(p.items || []).map((it) => it.id).join('+')}` : '-');
  return [m.round, ps.deployCap, ps.shop.level, ps.round?.refreshes ?? 0, ctx.focus, ctx.second, ps._botCore?.id, ps._botCore?.target,
    ctx.model?.key, ctx.fly, JSON.stringify(ctx.roles), JSON.stringify(ps.layers), JSON.stringify(ps.bondCountBonus ?? null),
    [...ps.board.entries()].map(([k, p]) => `${k}=${piece(p)}`).join(), ps.hand.map(piece).join(), ps.temp.map(piece).join()].join('|');
}
function chooseLineup(m, ps, ctx) {
  const key = lineupMemoKey(m, ps, ctx);
  const memo = ps._botLineupMemo;
  if (memo && memo.key === key && memo.policy === pol(m)) return { set: memo.set.slice(), bench: memo.bench.slice(), score: memo.score };
  const r = chooseLineupUncached(m, ps, ctx);
  ps._botLineupMemo = { key, policy: pol(m), set: r.set.slice(), bench: r.bench.slice(), score: r.score };
  return r;
}

function chooseLineupUncached(m, ps, ctx) {
  const all = ps.allChess();
  const cap = Math.min(ps.deployCap, all.length);
  const value = new Map(all.map((p) => [p.uid, pieceValue(m, ps, p, ctx)]));
  const seed = all.slice().sort((a, b) => value.get(b.uid) - value.get(a.uid) || a.uid - b.uid);
  let set = seed.slice(0, cap);
  let bench = seed.slice(cap);
  let score = lineupScore(m, ps, set, ctx);
  // identical pieces (same chess, same items — a bond can hang on an item pair) score alike: only the first is tried
  const sig = (p) => `${p.id}|${(p.items || []).map((it) => it.id).sort().join('+')}`;
  for (let iter = 0; iter < 12 && bench.length; iter++) {
    let best = null;
    const tried = new Set();
    for (let j = 0; j < bench.length; j++) {
      const sj = sig(bench[j]);
      if (tried.has(sj)) continue;
      tried.add(sj);
      for (let i = 0; i < set.length; i++) {
        if (sig(set[i]) === sj) continue;
        const trial = set.slice();
        trial[i] = bench[j];
        const s = lineupScore(m, ps, trial, ctx);
        if (s > score + 0.5 && (!best || s > best.s || (s === best.s && (i < best.i || (i === best.i && j < best.j))))) best = { i, j, s };
      }
    }
    if (!best) break;
    const out = set[best.i];
    set[best.i] = bench[best.j];
    bench[best.j] = out;
    score = best.s;
  }
  // V3: a complementary pair of supports may activate an add-on that no single swap reaches (bestSupportSwap)
  const support = bestSupportSwap(m, ps, set, bench, ctx, score);
  if (support) {
    set = support.set; score = support.score;
    const selected = new Set(set.map(p => p.uid));
    bench = all.filter(p => !selected.has(p.uid));
  }
  return { set, bench, score };
}

/** Merge feasibility uses the same remaining shared pool already used by recruitment legality. */
export function botMergeReachable(m, ps, id) {
  if ((ps?.gd || m.gd).isGolden(id)) return true;
  const base = (ps?.gd || m.gd).baseIdOf(id);
  if (!m.pool.has(base)) return true;
  const missing = Math.max(0, ((ps?.gd || m.gd).mergeCount(base) || 3) - ps.countCopies(base));
  return m.pool.left(base) >= missing;
}

/** buyScore with a fresh context (tests). */
export function buyScoreOf(m, ps, id) {
  return buyScore(m, ps, id, context(m, ps));
}

/** Shop / reward score of acquiring one copy of chess `id` (0 = not worth it). */
function buyScore(m, ps, id, ctx) {
  const gd = ps?.gd || m.gd;
  const c = chessRec(m, id, ps);
  if (!c) return 0;
  const P = pol(m);
  let s = power(c) * 0.6;
  // V3: projected combat power, wave fit, recurring / gain traits and economy recruits (botStrategy) replace traitsOf
  const probe = { id, kind: 'chess', items: [] };
  const effective = P.projectedUnitPower ? botUnitRecord(m, ps, probe, ps.bonds, Math.min(ps.deployCap, ps.deployCount + 1)) : c;
  if (P.combatPowerWeight > 0) s += P.combatPowerWeight * 0.6 * operatorCombatPower(effective, P.skillPowerWeight ?? 1);
  if (ctx.model) s += waveFit(effective, ctx.model) * botWaveWeight(m);
  s += Math.min(pol(m).battleLayerYield?.buyCap ?? 12, recurringValue(m, ps, probe)) + traitValue(m, ps, probe, ['SERVER_GAIN']) + Math.min(20, economyRecruitValue(m, ps, id));
  const base = gd.baseIdOf(id);
  if (!c.isGolden) {
    const copies = ctx.copies.get(base) || 0;
    if (copies > 0) {
      // merge progress: an elite plus the merge's free next-tier reward (MERGE_HIT) — for any pair; a new pair of a
      // non-keeper only while the bench has room for it (cheap tiers: the third copy is hunted with refreshes)
      const keep = ctx.keep.has(base);
      // V3 knobs scale upstream's merge values (mergeFinishWeight / mergeProgressWeight; poolAwareMerges: no progress
      // value for a pair whose third copy the shared pool can no longer supply)
      if (copies + 1 >= mergeNeed(m, base)) s += (keep ? 40 : 30) * (P.mergeFinishWeight ?? 1);
      else if (!P.poolAwareMerges || botMergeReachable(m, ps, id)) s += (keep ? 14 : ctx.pairs < MAX_PAIRS && c.tier <= 3 ? 6 : 1) * (P.mergeProgressWeight ?? 1);
    }
  }
  if (!ctx.owned.bases.has(base)) s += bondValue(m, c, ctx.owned, ctx.focus, ctx.second);
  // band playbooks (botPolicy.bandPolicy): chessBonus per base; stackRefreshValue — a chess that adds layers on the
  // round's first refresh (拉普兰德 叙拉古 +4/+8, works from the bench) is worth those layers for every remaining round
  s += P.chessBonus?.[base] || 0;
  if (P.stackRefreshValue) s += refreshStackValue(m, ps, id) * P.stackRefreshValue;
  // role needs
  if (isBlocker(c) && ctx.roles.blockers < 2) s += 10;
  if (hitsFly(c) && ctx.fly > 0 && ctx.roles.antiAir < 2) s += 8;
  if (isHealer(c)) s += ctx.roles.healers === 0 && m.round >= 3 ? 6 : ctx.roles.healers >= 2 ? -14 : -3;
  if (c.attackKind === 'none' && !isHealer(c)) s -= 4;
  if (ctx.model && !isHealer(c)) s += ARMOR_WEIGHT * 0.6 * (armorFit(ctx.model, c) - 0.6);
  // the player's own 自选 piece (a slotted slot: its composed record carries diyFor) — AI 托管 of a human with picks
  if (c.diyFor) s += DIY_PIECE_BONUS;
  // [ASSUMED] A soft 18-point cooperation weight (PR #407), not an official rule or a reserved card.
  // Leave high-tier shared chess to living teammates whose opening strategy needs its faction.
  // Humans and bots count equally; a single soft penalty still allows valuable own merges.
  if (c.tier >= 5 && !c.isGolden && !c.diyFor && m.pool.has(base) && m.alivePlayers().some((mate) =>
    mate !== ps && gd.bandBondIds(mate.bandId).some((b) => !gd.modeInactiveBonds.has(b) && c.bonds.includes(b)))) s -= P.teammateTierPenalty ?? 18;
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
  // (V3: a player's own bounty enemies join its spawns — withBounties — so a player with bounties gets its own entry)
  const cacheKey = `${m.round}|${m.stageId}|${wave ? wave.templateId : 'boss'}|${boss ? boss.side : ''}`
    + (ps?.bounties?.length ? `|${ps.playerId}|${JSON.stringify(ps.bounties)}` : '');
  if (m._botPath && m._botPath.key === cacheKey) return m._botPath;
  const gd = ps?.gd || m.gd;
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
  const foes = new Map(); // DEF|RES → HP share of the round's enemies (effDps)
  if (routes.length && spawns.length) {
    const per = new Map();
    for (const s of spawns) {
      const e = gd.enemy(s.enemyKey);
      const overrides = wave.overrides?.[e?.key] ?? wave.overrides?.[s.enemyKey];
      const stats = { ...e?.stats, ...overrides?.stats };
      const n = Math.max(1, s.count || 1);
      const isLeader = s.tag === 'boss';
      if (s.tag === 'part') continue;
      if (e && e.stats) {
        const k = `${e.stats.def || 0}|${e.stats.res || 0}`;
        foes.set(k, (foes.get(k) || 0) + (isLeader ? LEADER_HP * LEADER_WEIGHT : (e.stats.maxHp || 1000) * n));
      }
      // the leader counts like LEADER_WEIGHT tough enemies: its huge pool makes damage on it worth a lot everywhere
      const hp = isLeader ? LEADER_HP : (overrides?.stats?.maxHp ?? overrides?.stats?.hp ?? stats.maxHp ?? 1000) * (s.mods?.hpMul ?? 1);
      const spd = (stats.moveSpeed ?? 1) * (s.mods?.speedMul ?? 1);
      const air = HOVER.has(s.enemyKey) || e?.isFlyEnemy || e?.stats?.motion === 'FLY';
      const key = `${s.routeIndex}|${isLeader ? 'boss' : ''}|${s.enemyKey}`;
      const a = per.get(key) || { ri: s.routeIndex, boss: isLeader, air, n: 0, hp: 0, spd: 0,
        threat: { def: (stats.def || 0) * (s.mods?.defMul ?? 1), res: (stats.res || 0) * (s.mods?.resMul ?? 1), atk: (stats.atk || 0) * (s.mods?.atkMul ?? 1),
          interval: s.interval || 4, damageType: e?.stats?.dmgType || 'phys' } };
      a.n += isLeader ? LEADER_WEIGHT * (boss ? Math.max(0.5, Math.min(3, pol(m).bossLeaderWeight ?? 1)) : 1) : n; a.hp += hp * n; a.spd += spd * n;
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
  let wsum = 0;
  for (const w of foes.values()) wsum += w;
  const armor = [...foes.entries()].map(([k, w]) => { const [def, res] = k.split('|').map(Number); return { def, res, w: w / wsum }; });
  m._botPath = { key: cacheKey, routes: routesOut, index, ground, flyTotal, airflow: airflowOf(st, toBoard, boss && boss.side === 'R'), armor, dps: new Map() };
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

/**
 * Enemies an attack strikes at once, as a factor on a dealer's DPS (the exposure model gives every unit's DPS to each
 * enemy on a covered tile, so a single-target dealer is overrated in a crowd): 阵法术师 / 轰击术师 strike every enemy in
 * range (sim professions.js rangeAoe, community report E3 after 0.1.0 — the 阵法术师's skill-off pause is the 0.4 of a
 * non-attacker), splash and chain branches a few [ASSUMED values, botbench A/B in BALANCE.md].
 */
const CROWD = Object.freeze({ phalanx: 2, blastcaster: 2, splashcaster: 1.3, aoesniper: 1.3, bombarder: 1.3, chain: 1.4 });

const crowdOf = (rec) => CROWD[rec && rec.subProfessionId] ?? 1;

/** Damage per second of a record (attack / attack interval; healers and non-attackers 0). */
function dpsOf(rec) {
  const st = rec && rec.stats;
  if (!st || isHealer(rec)) return 0;
  const interval = Math.max(0.2, (st.bat || 1) * 100 / Math.max(ASPD_MIN, st.aspd || 100));
  const d = ((st.atk || 0) / interval) * crowdOf(rec);
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

/** Visible skillful aura, applied once; tokens and distant operators receive no estimate. */
export function skillfulAuraDpsScale(unit, units, aura) {
  if (!aura?.active || !unit.rec?.chessId) return 1;
  const member = u => !!u.rec?.chessId && (u.rec.botBonds || u.rec.bonds || []).includes('skillfulShip');
  const [r, c] = parseKey(unit.key);
  const affected = member(unit) || units.some(u => {
    if (!member(u)) return false;
    const [mr, mc] = parseKey(u.key), dr = Math.abs(r - mr), dc = Math.abs(c - mc);
    return aura.wide ? Math.max(dr, dc) === 1 : dr + dc === 1;
  });
  if (!affected) return 1;
  const st = unit.rec.stats || {}, base = st.aspd || 100;
  const boosted = Math.max(ASPD_MIN, Math.min(ASPD_MAX, base + aura.bonus));
  const interval = aspd => Math.max(0.2, (st.bat || 1) * 100 / Math.max(ASPD_MIN, aspd));
  return interval(base) / interval(boosted);
}

/** Damage per second of a record against one enemy's DEF / RES (one hit mitigated like the sim, damage.js mitigate). */
function dpsVs(rec, def, res) {
  const st = rec && rec.stats;
  if (!st || isHealer(rec)) return 0;
  const interval = Math.max(0.2, (st.bat || 1) * 100 / Math.max(ASPD_MIN, st.aspd || 100));
  const d = (mitigate(st.atk || 0, rec.dmgType === 'arts' ? 'arts' : 'phys', { def, res }) / interval) * crowdOf(rec);
  return rec.attackKind === 'none' ? d * 0.4 : d;
}

/**
 * The record a chess fights with for range purposes: its range grid replaced by the one it is deployed with under the
 * player's loadout — a passive 攻击范围扩大 skill, a module's range or 攻击距离 (shared/loadoutRecord.js attackRangeGrid:
 * what the server's summonRange, the deploy wheel and the card use since 0.1.1) — else the record itself. Cached per
 * player and loadout.
 */
export function rangeRec(ps, rec) {
  if (!rec || !rec.chessId || typeof ps.loadoutFor !== 'function') return rec;
  const lo = ps.loadoutFor(rec);
  const key = `${rec.chessId}|${lo ? `${lo.skill ?? ''}:${lo.module ?? ''}` : ''}`;
  const cache = ps._botRangeRecs || (ps._botRangeRecs = new Map());
  if (cache.has(key)) return cache.get(key);
  let out = rec;
  try {
    // 0.2.0 补位: a human's not-owned chess (AI 托管) is deployed as its stand-in — that body's range
    const body = typeof ps.fieldRecord === 'function' ? ps.fieldRecord(rec) || rec : rec;
    const g = attackRangeGrid(loadoutRecord(body, resolveRecordLoadout(body, lo)));
    if (Array.isArray(g) && g.length && JSON.stringify(g) !== JSON.stringify(rec.rangeGrid)) out = Object.freeze({ ...rec, rangeGrid: g });
  } catch { out = rec; }
  cache.set(key, out);
  return out;
}

/**
 * DPS of a record against the round's enemies: dpsVs averaged over their DEF / RES weighted by HP (the field model's
 * `armor`; cached per round) — physical dealers lose most of their damage on 重甲 waves, arts dealers on high-RES ones.
 * Without a model (or enemies) the raw dpsOf.
 */
export function effDps(model, rec) {
  if (!rec) return 0;
  if (!model || !Array.isArray(model.armor) || !model.armor.length) return dpsOf(rec);
  // (a 自选 record — one DIY slot id, each player's own operator — is cached per operator and skill)
  const id = rec.diyFor ? `${rec.chessId}@${rec.charId}#${rec.skill?.index ?? ''}` : rec.chessId || rec.tokenId || rec.id || rec.name;
  const cache = model.dps instanceof Map ? model.dps : null;
  if (cache && cache.has(id)) return cache.get(id);
  let v = 0;
  for (const a of model.armor) v += a.w * dpsVs(rec, a.def, a.res);
  if (cache) cache.set(id, v);
  return v;
}

/** Share of a dealer's raw DPS that gets through the round's armour (1 for healers / no enemies). */
function armorFit(model, rec) {
  const raw = dpsOf(rec);
  return raw > 0 ? effDps(model, rec) / raw : 1;
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
  constructor(model, params, skillful = null) {
    this.skillful = skillful;
    this.model = model;
    this.p = params;
    this.units = []; // { rec, key, dps, air, ground, block, heal, cover: Set }
  }

  value() {
    const { routes } = this.model;
    const p = this.p;
    const cover = new Map(); // key → units; damage is evaluated against each route's enemy defenses
    const healCover = new Map();
    const auraDps = this.skillful ? new Map(this.units.map(u => [u, u.dps * skillfulAuraDpsScale(u, this.units, this.skillful)])) : null;
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
        if (c) for (const u of c) if (rt.fly ? u.air : u.ground) exp += t * (auraDps?.get(u) ?? u.dps) * (0.4 + 0.6 * damageRatio(u.rec, rt)) * crowdMultiplier(u.rec, rt);
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
    rec, key, dir, dps: effDps(model, rec) * atkMul, atkMul, air: hitsFly(rec), ground: rec.attackKind !== 'heal' && !isHealer(rec),
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
export function formationGrowth(m, ps, entries, projected = null) {
  const state = pol(m).projectedFormation ? (projected || lineupState(m, ps, entries.map(e => e.piece).filter(p => p.kind === 'chess'))) : { board: ps.board, hand: ps.hand, bonds: ps.bonds };
  const bonds = state.bonds;
  let v = 0;
  for (const { piece, r, c, dir } of entries) {
    for (const g of garrisons(m, piece.id)) {
      if (!['SERVER_PREP_FIN', 'SERVER_PREP_START'].includes(g.eventType)) continue;
      if (pol(m).projectedFormation && g.eventType === 'SERVER_PREP_START' && m.round >= (ps?.gd || m.gd).bossRound) continue;
      const b = g.bb || {}, s = g.bbStr || {};
      const [dr, dc] = rotateOffset(0, s.dir === 'behind' ? -1 : 1, dir);
      const neighbour = entries.find((e) => e.r === r + dr && e.c === c + dc);
      // positional engines (空弦 / 断崖 / 引星棘刺 layers, 铃兰 trigger, 塞雷娅 copy): botPolicy.positionLayerWeight scales them
      const posW = pol(m).positionLayerWeight ?? 1;
      if (g.effectKey === 'SERVER_ADD_BOND_POSITION' && neighbour) {
        for (const id of pol(m).projectedFormation ? pieceBonds(m.gd, neighbour.piece) : ((ps?.gd || m.gd).chess(neighbour.piece.id)?.bonds || [])) if (bonds[id]?.active) v += posW * layerValue(m, ps, id, b.count, bonds);
      }
      if (g.effectKey === 'SERVER_TRIGGER_ANOTHER' && neighbour) v += posW * traitValue(m, ps, neighbour.piece, ['SERVER_GAIN'], state);
      if (g.effectKey === 'SERVER_FRONT_SAME_EFFECT_PREP_FIN' && neighbour) v += posW * traitValue(m, ps, neighbour.piece, ['SERVER_PREP_FIN'], state);
      if (g.effectKey === 'SERVER_FRONT_SAME_EFFECT_PREP_START' && neighbour) v += posW * traitValue(m, ps, neighbour.piece, ['SERVER_PREP_START'], state);
      const rowCount = entries.filter((e) => e.r === r).length;
      if (s.add_method === 'same_row') for (const id of String(s.bond || '').split(',')) if (bonds[id]?.active) v += layerValue(m, ps, id, rowCount * (b.multi || 1), bonds);
      if (s.conditionkey === 'character_same_row' && rowCount >= (b.check_count || 3)) v += 4;
    }
  }
  return v * (pol(m).formationGrowthWeight ?? 0.025);
}

/** planLayout as a step generator: yields after each placed piece (Match slices a bot's prep, see botPrepBeginSteps). */
export function* planLayoutSteps(m, ps, pieces, params = LAYOUT_PARAMS, { occupied = new Set(), recOf = null } = {}) {
  const model = fieldModel(m, ps);
  const map = ps.deployMap();
  const pgd = ps.gd || m.gd;
  // V3: chess records carry the projected lineup's static bond buffs (botStrategy combatRecord); the deployed range grid
  // stays upstream's (rangeRec: the loadout's attackRangeGrid). 驰骋 (skillfulShip) aura planning: planSkillfulAura.
  const P = pol(m);
  const state = recOf ? null : lineupState(m, ps, pieces.filter((p) => p.kind === 'chess'));
  const chessRecOf = (p) => {
    const ranged = rangeRec(ps, pgd.chess(p.id));
    const cr = combatRecord(m, ps, p, state.bonds, pieces.length);
    return cr && ranged && ranged.rangeGrid !== cr.rangeGrid ? { ...cr, rangeGrid: ranged.rangeGrid } : cr || ranged;
  };
  const records = recOf ? null : new Map(pieces.map((p) => [p.uid, p.kind === 'token' ? pgd.token(p.id) : chessRecOf(p)]));
  const rec = recOf || ((p) => records.get(p.uid));
  const auraState = state?.bonds.skillfulShip;
  const auraBb = pgd.bond('skillfulShip')?.buffs?.find(b => b.bbStr?.key)?.bb || {};
  const skillful = P.planSkillfulAura && auraState?.active ? { active: true, bonus: (auraBb.base_attack_speed || 0) + (auraBb.attack_speed_per_stack || 0) * (auraState.layers || 0), wide: (auraState.layers || 0) >= (auraBb.power_bond_stack_cnt ?? Infinity) } : null;
  const layout = new Layout(model, params, skillful);
  const rank = (p) => { const r = rec(p); return isBlocker(r) ? 0 : isHealer(r) ? 2 : 1; };
  const order = pieces.slice().sort((a, b) => rank(a) - rank(b) || dpsOf(rec(b)) - dpsOf(rec(a)) || a.uid - b.uid);
  const taken = new Set(occupied);
  const out = new LayoutPlan();
  const placed = [];
  // V3: a piece whose garrison effect depends on its facing / front tile keeps every direction as its own candidate
  const positionalOf = (p) => garrisons(m, p.id).some((g) => /POSITION|FRONT|TRIGGER/.test(g.effectKey));
  for (const p of order) {
    const r0 = rec(p);
    if (!r0) continue;
    let best = null;
    let bestV = -Infinity;
    // a "只能部署在召唤者攻击范围内" summon (伺夜's 狼群, 缪尔赛思's 流形): only the tiles of its owner's range
    const within = p.kind === 'token' && typeof ps.summonRange === 'function' ? ps.summonRange(p) : null;
    // and an outside-bound one (凯尔希·思衡托's 战术锚点): never a tile of its owner's range
    const without = p.kind === 'token' && typeof ps.summonExcluded === 'function' ? ps.summonExcluded(p) : null;
    // ground tiles for a MELEE blocker. placeClass 'all' on a MELEE record is a chess whose trait reads 「可以放置于远程位」
    // (歌蕾蒂娅, 崖心, 见行者, any module): it may stand on a 高台, and when one of those tiles covers the enemy road it is
    // planned there even with the ground free (owner 2026-10-04: the bot uses the 高台; 2026-10-05: every such chess).
    const cls = p.kind === 'token' ? positionClass(r0) : placeClass(ps, pgd.chess(p.id) || r0);
    const preferHigh = cls === 'all' && basePositionClass(r0) === 'melee';
    let bestHigh = null;
    let bestHighV = -Infinity;
    // a blocker whose range is its own tile only (range 0-1: 角峰, 古米, 泡泡, 折桠, 菲莱, 蛇屠箱, 塞雷娅, 余) neither blocks nor
    // hits anything off the enemy road — the official range "0-1" (excel range_table) is the one grid (0,0) — so a free road tile
    // comes first (the kill estimate saturates in a full layout and then cannot tell the tiles apart)
    const preferRoad = isBlocker(r0) && r0.rangeGrid?.length === 1 && r0.rangeGrid[0].every((v) => v === 0);
    let bestRoad = null;
    let bestRoadV = -Infinity;
    for (const [r, c] of legalTiles(map, cls)) {
      const k = tileKey(r, c);
      if (taken.has(k) || (within && !within.has(k)) || (without && without.has(k))) continue;
      const noise = m.rngBots() * 1e-6;
      const seen = new Set();
      const positional = positionalOf(p);
      for (const dir of PLAN_DIRS) {
        const u = unitOf(r0, k, r, c, dir, model);
        // (the same covered tiles under a different airflow ATK factor are a different candidate)
        const sig = `${positional ? dir : ''}|${u.atkMul}|${[...u.cover].sort().join(' ')}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        layout.units.push(u);
        // V3: + formation growth of the projected lineup (position-dependent bond / garrison gains)
        const v = layout.value() + formationGrowth(m, ps, [...placed, { piece: p, r, c, dir }], state) + noise;
        layout.units.pop();
        if (v > bestV) { bestV = v; best = [k, r, c, dir]; }
        // (the best road tile by the same value)
        if (preferRoad && model.ground.has(k) && v > bestRoadV) { bestRoadV = v; bestRoad = [k, r, c, dir]; }
        if (preferHigh && map.get(k) === 'ranged' && [...u.cover].some((ck) => model.ground.has(ck)) && v > bestHighV) {
          bestHighV = v;
          bestHigh = [k, r, c, dir];
        }
      }
    }
    const pick = bestHigh || bestRoad || best;
    if (!pick) continue;
    taken.add(pick[0]);
    layout.units.push(unitOf(r0, pick[0], pick[1], pick[2], pick[3], model));
    out.set(p.uid, pick[0]);
    out.dirs.set(p.uid, pick[3]);
    // (a 高台 / road preference or a summon-range constraint pins the piece: the refinement below leaves it alone)
    placed.push({ piece: p, r: pick[1], c: pick[2], dir: pick[3], fixed: pick !== best || !!within || !!without, cls });
    yield;
  }
  // V3 (botPolicy.layoutRefinementPasses, 0–2): bounded coordinate search — earlier greedy placements can move once the
  // whole roster is known. Only the hypothetical plan changes; the live board, inventory, directions and effects remain
  // untouched. Same legality as above (placeClass tiles, taken tiles); pinned pieces stay.
  const passes = Math.max(0, Math.min(2, Math.floor(P.layoutRefinementPasses ?? 0)));
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (let i = 0; i < placed.length; i++) {
      const original = placed[i];
      if (original.fixed) continue;
      const p = original.piece, r0 = rec(p), oldKey = out.get(p.uid);
      taken.delete(oldKey);
      let bestE = { entry: original, unit: layout.units[i], key: oldKey };
      let bestEV = layout.value() + formationGrowth(m, ps, placed, state);
      const positional = positionalOf(p);
      for (const [r, c] of legalTiles(map, original.cls)) {
        const key = tileKey(r, c); if (taken.has(key)) continue;
        const seen = new Set();
        for (const dir of PLAN_DIRS) {
          const unit = unitOf(r0, key, r, c, dir, model);
          const sig = `${positional ? dir : ''}|${unit.atkMul}|${[...unit.cover].sort().join(' ')}`;
          if (seen.has(sig)) continue; seen.add(sig);
          const entry = { ...original, r, c, dir }; layout.units[i] = unit; placed[i] = entry;
          const value = layout.value() + formationGrowth(m, ps, placed, state);
          if (value > bestEV + 1e-8) { bestEV = value; bestE = { entry, unit, key }; }
        }
      }
      placed[i] = bestE.entry; layout.units[i] = bestE.unit; taken.add(bestE.key);
      out.set(p.uid, bestE.key); out.dirs.set(p.uid, bestE.entry.dir);
      changed ||= bestE.key !== oldKey || bestE.entry.dir !== original.dir;
      yield;
    }
    if (!changed) break;
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
 * against the round's enemies with the real Battle (a rehearsal seed, never the real battle's; no onBattleStart meta
 * dispatch, so it has no side effect on the match) and the plan with the fewest counted leaks (then most kills) wins.
 * Every candidate's Battle is built right away (each layout is on the board only while its input is taken; the board
 * is restored exactly before this returns), so the job can be stepped later: `job.run(budgetMs)` simulates until the
 * wall-clock budget is used (checked every 4 ticks) and returns true once every candidate is done. A candidate whose
 * counted leaks already exceed the best finished one's stops early (it can no longer win).
 * A whole rehearsal is 0.2–1 s of CPU late in a 4-bot match: Match runs it in bounded slices between other callbacks.
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
  if (!m.wave && pol(m).bossRehearsalPlans > 0 && m.bossGroupOf?.(ps))
    return yield* createBossRehearsalSteps(m, ps, chosen, distinctPlans(plans));
  const wave = m.wave;
  const distinct = distinctPlans(plans);
  if (!wave || distinct.length < 2 || !(m.botRehearsal > 0)) return null;
  const extra = Math.max(0, Math.min(5, Math.floor(pol(m).extraRehearsalPlans ?? 0)));
  const cands = distinct.slice(0, Math.min(8, m.botRehearsal + extra));
  const byUid = new Map(ps.allChess().concat(chosen).map((p) => [p.uid, p]));
  const battles = [];
  const candidateBonds = [];
  const candidateInputs = [];
  // botPolicy.robustRehearsalSeeds N > 1: each candidate is judged on N rehearsal seeds (sum of counted leaks), so a
  // single seed's chaotic divergence (≈0.9 leaks SD in late rounds) does not pick the layout. 1 = the original path.
  const robustN = Math.max(1, Math.min(4, Math.floor(pol(m).robustRehearsalSeeds ?? 1)));
  const candidateOpts = [];
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
      const rOpts = {
        seed: deriveSeed(m.seed, `rehearse:${m.round}:${ps.seat}`), kind: 'normal', modeId: m.modeId, round: m.round,
        stageId: m.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: wave.timeLimit, players: [input],
        spawns: m._sanitizeSpawns(spawns, ps.playerId), routes: wave.routes, sharedBoss: null,
        // Battle clones its bonds; its results are never committed to the match. In-battle growth is safe here.
        flags: { layerGainsEnabled: true, ...(ps?.gd || m.gd).dp }, fieldId: `r:${ps.playerId}`, enemyOverrides: wave.overrides, waveId: wave.templateId,
      };
      if (robustN > 1) candidateOpts.push(structuredClone(rOpts));
      battles.push(m.newBattle(rOpts));
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
  if (robustN > 1 && candidateOpts.length === battles.length) return robustRehearsalJob(m, ps, chosen, cands, battles, candidateOpts, candidateBonds, byUid, robustN, wave);
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
              const score = relayPending.score + relayDefenseValue(r, relayPending.count, m);
              if (score > bestScore) { bestScore = score; bestLeaks = 0; job.best = cands[i]; job.chosen = [...cands[i].keys()].map((uid) => byUid.get(uid)).filter(Boolean); }
              relayPending = null;
            } else if (pp) {
              const leaks = (pp.leaked || []).filter((l) => l && l.counted !== false).length;
              const growth = m.round < (ps?.gd || m.gd).bossRound ? Object.entries(pp.layerGains || {}).reduce((n, [id, amount]) =>
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

/** Multi-seed rehearsal job (same interface as the single-seed job): candidates in order, each on N seeds. */
function robustRehearsalJob(m, ps, chosen, cands, firstBattles, opts, bonds, byUid, N, wave) {
  const cap = Math.ceil(((wave.timeLimit || 60) + 5) * 30);
  let ci = 0, k = 0, t = 0, battle = null;
  let sumL = 0, sumK = 0, growth = 0, bestSum = Infinity, bestScore = -Infinity;
  const job = {
    chosen,
    plans: cands,
    best: cands[0],
    done: false,
    run(budgetMs = Infinity) {
      const timed = Number.isFinite(budgetMs);
      const t0 = timed ? performance.now() : 0;
      let n = 0;
      while (ci < cands.length) {
        if (timed && n > 0 && performance.now() - t0 >= budgetMs) return false;
        let beaten = false;
        try {
          if (!battle) {
            if (k === 0) { battle = firstBattles[ci]; firstBattles[ci] = null; }
            else battle = m.newBattle({ ...structuredClone(opts[ci]), seed: deriveSeed(m.seed, `rehearse${k}:${m.round}:${ps.seat}`) });
          }
          while (t < cap && !battle.finished) {
            battle.step();
            t++;
            n++;
            if ((t & 63) === 0 && bestSum < Infinity && sumL + countedLeaks(battle, ps.playerId) > bestSum) { beaten = true; break; }
            if (timed && (n & 3) === 0 && performance.now() - t0 >= budgetMs) return false;
          }
          if (!beaten) {
            if (!battle.finished) battle.forceEnd('timeout');
            const r = battle.result();
            const pp = r && !r.synthetic && r.perPlayer && r.perPlayer[ps.playerId];
            if (pp) {
              sumL += (pp.leaked || []).filter((l) => l && l.counted !== false).length;
              sumK += pp.killed || 0;
              if (k === 0 && m.round < (ps?.gd || m.gd).bossRound) growth = Object.entries(pp.layerGains || {}).reduce((s, [id, a]) => s + layerValue(m, ps, id, a, bonds[ci]), 0);
            } else beaten = true;
          }
        } catch (e) {
          m.log.warn?.(`[match ${m.roomCode}] bot rehearsal failed: ${e && e.message}`);
          beaten = true;
        }
        battle = null;
        t = 0;
        if (!beaten && k + 1 < N) { k++; continue; }
        if (!beaten) {
          const score = -sumL * 10000 + sumK * 10 + Math.min(5, Math.log1p(growth)) - ci * 0.0001;
          if (score > bestScore) { bestScore = score; bestSum = sumL; job.best = cands[ci]; job.chosen = [...cands[ci].keys()].map((uid) => byUid.get(uid)).filter(Boolean); }
        }
        firstBattles[ci] = null;
        ci++; k = 0; sumL = 0; sumK = 0; growth = 0;
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
  // V3 decision layer: the focus is the core plan's (botStrategy corePlan: opening strategy, distinct recruits, layers,
  // shop access, teammate competition, botPolicy.corePreference / extraCoreTargets); upstream's bondPlan still supplies
  // the second bond (and the focus when the core plan has none). keeperBases uses the merged plan.
  const up = bondPlan(m, ps, owned);
  const core = pol(m).corePlanFocus === false ? null : corePlan(m, ps)?.id || null;
  const focus = core || up.focus;
  const second = up.second && up.second !== focus ? up.second : (up.focus && up.focus !== focus ? up.focus : null);
  const plan = { focus, second };
  const copies = copyCounts(m, ps);
  let pairs = 0;
  for (const [b, k] of copies) if (k + 1 >= mergeNeed(m, b)) pairs++;
  return { ps, owned, focus: plan.focus, second: plan.second, keep: keeperBases(m, ps, plan), copies, pairs, roles: roles(m, ps), fly: model.flyTotal, model, hiddenDrive: hiddenDrive(m, ps) };
}

/** Normal copies owned per base (board, hand, temp). */
function copyCounts(m, ps) {
  const out = new Map();
  for (const p of ps.allChess()) {
    if (m.gd.isGolden(p.id)) continue;
    const b = m.gd.baseIdOf(p.id);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return out;
}

/**
 * Expected value of one shop refresh: Σ over the owned bases one copy short of an elite of P(the refresh shows a copy)
 * × MERGE_HIT, plus the keeper singles × PAIR_HIT. P = 1 − (1 − left / eligible copies)^chess slots — the shop's
 * copy-weighted roll over the shared pool's tiers ≤ shop level (PlayerState._rollChessSlot, pool.js roll).
 */
function refreshValue(m, ps, ctx) {
  const L = ps.shop.level;
  let total = 0;
  for (const e of m.pool.entries.values()) if (e.left > 0 && e.tier <= L) total += e.left;
  if (!(total > 0)) return 0;
  const slots = m.gd.shopSlots(L).chess;
  let v = 0;
  for (const [b, k] of ctx.copies) {
    const e = m.pool.entries.get(b);
    if (!e || e.left <= 0 || e.tier > L) continue;
    const pShop = 1 - (1 - e.left / total) ** slots;
    if (k + 1 >= mergeNeed(m, b)) v += pShop * MERGE_HIT;
    else if (ctx.keep.has(b)) v += pShop * PAIR_HIT;
  }
  return v;
}

/**
 * Sell the weakest bench chess (temp and hand; the hand only with `handOnly`) that is not part of a merge pair (or
 * anything when keepPairs is false) and does not carry a 突变细胞 (its transformation after the battle is the point).
 * `keepFresh`: never a piece that came this prep (`boughtRound`: bought for the lineup, an elite just merged, a reward)
 * nor one gained since the bot's last prep ended (unseen, see rememberOwned: the operator a 突变细胞 transformation
 * gains joins the bench while its carrier's deployment is free — the placement step decides about it, not the shed's
 * piece value).
 */
function sellWeakestHand(m, ps, { keepPairs = true, below = Infinity, handOnly = false, keepFresh = false } = {}) {
  const ctx = context(m, ps);
  let worst = null;
  let worstV = Infinity;
  for (const p of handOnly ? ps.hand : [...ps.temp, ...ps.hand]) {
    if (!p || p.kind !== 'chess' || (p.items || []).some((it) => isMutationCell(m.gd, it.id))) continue;
    if (heldBase(m, p)) continue; // V3 band playbook: botPolicy.holdBases
    const base = m.gd.baseIdOf(p.id);
    if (keepPairs && !m.gd.isGolden(p.id) && (ctx.copies.get(base) || 0) >= 2) continue;
    if (keepFresh && (p.boughtRound === m.round || unseen(ps, p))) continue;
    const v = pieceValue(m, ps, p, ctx) + benchValue(m, ps, p) * 3; // V3: productive bench traits
    if (v < worstV) { worstV = v; worst = p; }
  }
  if (!worst || worstV >= below) return false;
  return tryDo(() => ps.sell(worst.uid));
}

/**
 * The chess the bot owned when its last prep ended (`ps._botSeenUids`, written by botPrepEndSteps before Ready). A
 * piece outside it was gained after that prep — at SETTLE (a 突变细胞 transformation's operator, battle-result grants),
 * at the round start or in 机变 — and has not been through a placement step yet. No memory yet (a bot's first prep, a
 * seat just put under AI 托管): nothing counts as unseen.
 */
function rememberOwned(ps) {
  ps._botSeenUids = new Set(ps.allChess().map((p) => p.uid));
}

const unseen = (ps, p) => !!ps._botSeenUids && !ps._botSeenUids.has(p.uid);

/** Lineup gain of one copy of chess `id` (full board): best single swap into the current best lineup `cur`. */
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
    const c = chessRec(m, p.id, ps);
    if (!c) continue;
    const base = m.gd.baseIdOf(p.id);
    const copies = c.isGolden ? 0 : ctx.copies.get(base) || 0;
    // a pair whose third copy can still come (the merge's reward is worth it for any pair)
    const pairLive = copies + 1 >= mergeNeed(m, base) && (m.pool.left(base) > 0 || !m.pool.has(base));
    // V3: a productive bench engine (benchValue: bench-counted bonds, refresh / prep-end traits) is useful too
    const engine = benchValue(m, ps, p);
    const useful = c.isGolden || pairLive || engine >= 1 || ctx.keep.has(base) || (copies >= 2 && m.round <= 6);
    (useful ? keep : junk).push({ p, v: pieceValue(m, ps, p, ctx) + engine * 3 + (pairLive ? 150 : useful ? 100 : 0) });
  }
  // bench budget: at most BENCH_BUDGET spare units beyond the lineup (pairs first)
  const all = keep.concat(junk).sort((a, b) => b.v - a.v);
  for (const { p } of all.slice(pol(m).benchBudget ?? BENCH_BUDGET)) if (!heldBase(m, p)) tryDo(() => ps.sell(p.uid));
  for (const { p } of junk.slice(0, 4)) if (m.round >= 5 && ps.find(p.uid) && !heldBase(m, p)) tryDo(() => ps.sell(p.uid));
}

/** Take the queued pick-one offers (merge rewards, special refreshes — free; they expire at prep end). */
function takeOffers(m, ps) {
  for (let guard = 0; guard < 4 && ps.offers.length; guard++) {
    const offer = ps.offers[0];
    if (offer.source === 'training') {
      const idx = offer.slots.findIndex(s => !s.sold);
      if (idx < 0 || !tryDo(() => ps.pickReward(idx))) break;
      continue;
    }
    const ctx = context(m, ps);
    let best = -1;
    let bestS = -Infinity;
    offer.slots.forEach((s, i) => {
      if (s.sold) return;
      // V3: an item slot by its best equipment target (upstream: usable ? 10 : 1 + tier × 3)
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
export function* botPrepBeginSteps(m, ps) { return yield* withOverlay(m, ps, botPrepBeginStepsInner(m, ps)); }

function* botPrepBeginStepsInner(m, ps) {
  if (!ps.alive || ps.ready) return null;
  m.autoPickPersonalChoice(ps, 'bot');
  // 1. reward offers (free)
  takeOffers(m, ps);
  if (pol(m).econSweep) cashBank(m, ps);
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
  yield* buyLoopSteps(m, ps, { fillOnly: false, maxRefreshes: pol(m).prepRefreshes ?? MAX_REFRESHES });
  takeOffers(m, ps);
  levelUp(m, ps, { spare: true });
  maybeFreeze(m, ps);
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
export function* botPrepEndSteps(m, ps, job = null) { return yield* withOverlay(m, ps, botPrepEndStepsInner(m, ps, job)); }

function* botPrepEndStepsInner(m, ps, job = null) {
  if (!ps.alive || ps.ready) return;
  if (job && job.done && job.best !== job.plans[0]) yield* applyPlanSteps(m, ps, job.chosen, job.best);
  // 5. temp → hand / sell / destroy; keep one hand slot free for next round's merges
  resolveTemp(m, ps);
  if (freeSlot(ps.hand) < 0) freeHandSlot(m, ps);
  takeOffers(m, ps);
  resolveTemp(m, ps);
  econSweep(m, ps);
  // Keep an unaffordable third copy; do not freeze a stale shop just because it was frozen before.
  // (upstream maybeFreeze freezes at the buy-loop end; V3 also unfreezes a stale frozen shop — ps.freeze toggles)
  const keepShop = ps.shop.slots.some((s) => s && !s.sold && s.kind === 'chess' && ps.completesChessMerge(s.id) && ps.priceOf(s) > ps.funds);
  if (ps.shop.frozen !== keepShop) tryDo(() => ps.freeze());
  // what the next prep's bench shed may judge by value: what is owned now (later gains wait for a placement step)
  rememberOwned(ps);
  m.autoPickPersonalChoice(ps, 'bot');
  tryDo(() => ps.setReady(true));
}

/**
 * Free one hand slot: on a bot's own seat a kept bounty Art goes first (“神秘顾客” pays its fund and passes to a
 * teammate when destroyed, 教鞭 gives nothing — its chance of a perfect-battle payout is worth less than a slot for a
 * merge), else the weakest bench single is sold. A human's seat under AI 托管 never loses an item this way.
 */
function freeHandSlot(m, ps) {
  if (ps.isBot && !ps.autoplay) {
    const art = ps.hand.find((p) => p && p.kind === 'item' && isBountyArt(m.gd, p.id));
    if (art && tryDo(() => ps.destroy(art.uid))) return true;
  }
  return sellWeakestHand(m, ps);
}

/** The whole prep routine in one go (the rehearsal, if any, runs synchronously). */
export function botPrep(m, ps) {
  const job = botPrepBegin(m, ps);
  if (job) job.run();
  botPrepEnd(m, ps, job);
}

// ---- economy knobs (botPolicy; all off by default) ------------------------------------------------------------------
// Leftover funds are lost at prep end (data economy.leftoverFundsLost; band_cannot keeps them). `econSweep`: the last
// coins of a prep buy a money item instead — 见钱眼开玩偶 (1 → +2 next round), 精打细算玩偶 (+1 per round), 盟约之币 /
// 骑士储蓄罐 (kept in the hand as savings: `bankCoins`, cashed at the next prep start) — and with `greyBank` a chess whose
// sale pays gold (格雷伊 \"售出时下个休整期额外获得1资金\": 2 in, 1 back on the sale + 1 the prep after). Before a paid reroll
// that would leave nothing to buy, a visible money item is bought instead. `cannotInterest`: a band that keeps its
// leftover funds (坎诺特 利滚利, +1 when ≥ 5 are left) does not reroll below that.
function econItemInfo(m, id) {
  const rec = m.gd.item(id);
  if (!rec || rec.itemType !== 'EQUIP' || !String(rec.kind || '').startsWith('consume_on_equip')) return null;
  for (const buff of rec.buffs || []) {
    const p = { ...(buff.bb || {}), ...(buff.bbStr || {}) };
    if (buff.key === 'use_equip_gain_coin_when_next_round_start') return { type: 'next', gain: Number(p.count) || 0 };
    if (buff.key === 'gain_coin_when_round_start') return { type: 'annuity', gain: Number(p.count) || 0 };
    if (buff.key === 'equip_destory_gain_random_coin') return { type: 'bank', gain: ((Number(p.min) || 0) + (Number(p.max) || 0)) / 2 };
  }
  return null;
}

function econRoundsLeft(m) { return Math.max(0, (m.gd.bossRound || 14) - m.round); }

/** Gold a money item returns when bought with coins that would otherwise be lost (0 = not worth it). */
function econItemValue(m, id) {
  const info = econItemInfo(m, id);
  if (!info) return 0;
  if (info.type === 'next') return econRoundsLeft(m) >= 1 ? info.gain : 0;
  if (info.type === 'annuity') return info.gain * econRoundsLeft(m);
  return info.gain;
}

/** The gold a chess pays when sold (格雷伊-type SERVER_CHESS_SOLD → SERVER_ONCE_GOLD), else 0. */
function soldGold(m, id) {
  let n = 0;
  for (const g of garrisons(m, id)) if (g.eventType === 'SERVER_CHESS_SOLD' && g.effectKey === 'SERVER_ONCE_GOLD') n += Number(g.bb?.count) || 1;
  return n;
}

function consumeOnBoard(m, ps, item) {
  const target = [...ps.board.values()].find((p) => p.kind === 'chess');
  return !!target && tryDo(() => ps.equip(item.uid, target.uid));
}

/** Buy shop slot `i` as a money move: money items are used at once unless `keep` (savings); chess are kept. */
function buyEconSlot(m, ps, i, keep) {
  const s = ps.shop.slots[i];
  if (!s || s.sold || ps.priceOf(s) > ps.funds || freeSlot(ps.hand) < 0) return false;
  const before = new Set([...ps.hand, ...ps.temp].filter(Boolean).map((p) => p.uid));
  if (!tryDo(() => ps.buy(i))) return false;
  const got = [...ps.hand, ...ps.temp].find((p) => p && !before.has(p.uid));
  if (!got) return true;
  if (got.kind === 'item' && !keep) consumeOnBoard(m, ps, got);
  else (ps._botBank ||= new Set()).add(got.uid);
  return true;
}

/** Best money move the current funds allow: { i, value, keep } or null. `profitOnly`: items that beat their price. */
function econPick(m, ps, { profitOnly = false } = {}) {
  const P = pol(m);
  let best = null;
  ps.shop.slots.forEach((s, i) => {
    if (!s || s.sold) return;
    const price = ps.priceOf(s);
    if (price > ps.funds) return;
    let value = 0, keep = false;
    if (s.kind === 'item') {
      const info = econItemInfo(m, s.id);
      if (!info || !m.registry.has('item:' + itemKey(s.id)) || freeSlot(ps.hand) < 0) return;
      value = econItemValue(m, s.id);
      keep = info.type === 'bank' && P.bankCoins !== false;
    } else if (s.kind === 'chess' && P.greyBank && !profitOnly) {
      const g = soldGold(m, s.id);
      const base = (ps?.gd || m.gd).baseIdOf(s.id);
      if (!g || (m.pool.has(base) && m.pool.left(base) < 1) || ps.hand.filter((p) => !p).length < 2) return;
      value = (ps?.gd || m.gd).sellPrice(s.id) + g;
      keep = true;
    } else return;
    if (profitOnly && value <= price) return;
    if (value > 0 && (!best || value - price * (profitOnly ? 1 : 0) > best.value)) best = { i, value, keep };
  });
  return best;
}

/** Prep end: spend the coins that would be lost on money moves. */
function econSweep(m, ps) {
  if (!pol(m).econSweep || (ps?.gd || m.gd).leftoverKeptBands.includes(ps.bandId)) return;
  for (let guard = 0; guard < 8 && ps.funds > 0; guard++) {
    const pick = econPick(m, ps);
    if (!pick || !buyEconSlot(m, ps, pick.i, pick.keep)) break;
  }
}

/** Prep start: savings back to funds (money items used, savings chess sold unless they became a merge pair). */
function cashBank(m, ps) {
  const bank = ps._botBank;
  if (!bank || !bank.size) return;
  for (const uid of [...bank]) {
    const loc = ps.find(uid);
    if (!loc || loc.area === 'board' || loc.area === 'equipped') { bank.delete(uid); continue; }
    const p = loc.piece;
    if (p.kind === 'item') { if (consumeOnBoard(m, ps, p)) bank.delete(uid); continue; }
    if (p.kind === 'chess') {
      if (ps.countCopies((ps?.gd || m.gd).baseIdOf(p.id)) >= 2) { bank.delete(uid); continue; }
      if (tryDo(() => ps.sell(uid))) bank.delete(uid);
    }
  }
}

// ---- strategy (band) playbooks: botPolicy.bandPolicy[bandId] = { ...policy keys } -----------------------------------
// The overlay applies while THAT bot runs its own prep (each generator step runs with it, the match policy is restored
// between steps), e.g. 伊奥莱塔·罗素 holding the shop at level 3 for elites, 杜遥夜 using its two special refreshes,
// 贾维 refreshing at level 2 for free 叙拉古 operators until it owns elite 拉普兰德. `humanTeamOnly`: only with a human
// teammate. Playbook keys: levelCap [per round], levelCapUnlock { golden: [baseIds], count }, forceRefreshes,
// prepRefreshes, chessBonus { baseId: score } (buys and 三合一 reward picks), plus any ordinary policy key.
function overlayFor(m, ps) {
  const map = pol(m).bandPolicy;
  const ov = map && ps.bandId ? map[ps.bandId] : null;
  if (!ov || (ov.humanTeamOnly && !(m.order || []).some((p) => !p.isBot))) return null;
  const cache = (m._botPolicyOverlay ||= new Map());
  let hit = cache.get(ps.bandId);
  if (!hit || hit.base !== m.botPolicy) { hit = { base: m.botPolicy, policy: { ...m.botPolicy, ...ov } }; cache.set(ps.bandId, hit); }
  return hit.policy;
}

function* withOverlay(m, ps, gen) {
  const ov = overlayFor(m, ps);
  if (!ov) return yield* gen;
  const base = m.botPolicy;
  let input;
  for (;;) {
    m.botPolicy = ov;
    let r;
    try { r = gen.next(input); } finally { m.botPolicy = base; }
    if (r.done) return r.value;
    input = yield r.value;
  }
}

function levelCapUnlocked(m, ps) {
  const u = pol(m).levelCapUnlock;
  if (!u || !Array.isArray(u.golden)) return false;
  const want = new Set(u.golden);
  return ps.allChess().filter((p) => (ps?.gd || m.gd).isGolden(p.id) && want.has((ps?.gd || m.gd).baseIdOf(p.id))).length >= (u.count || 1);
}

/** Free refreshes a chess pays: { sold, gain } counts (德克萨斯 售出时, 普罗旺斯 获得时 …). */
function refreshGarrisons(m, id) {
  const out = { sold: 0, gain: 0 };
  for (const g of garrisons(m, id)) {
    if (g.effectKey !== 'SERVER_GAIN_FREE_REFRESH_COUNT') continue;
    if (g.eventType === 'SERVER_CHESS_SOLD') out.sold += Number(g.bb?.count) || 1;
    else if (g.eventType === 'SERVER_GAIN') out.gain += Number(g.bb?.count) || 1;
  }
  return out;
}

/**
 * botPolicy.refreshFlip: before a reroll, a shop chess that pays free refreshes (德克萨斯 sold → +1, 普罗旺斯 gained →
 * +1) is bought — and sold at once when its refresh comes on the sale, unless it completes a merge. Each flip is a
 * refresh at no net gold that also counts as a player refresh (贾维 团伙行动).
 */
function refreshFlipStep(m, ps) {
  if (!pol(m).refreshFlip || freeSlot(ps.hand) < 0) return false;
  let best = -1, bestN = 0;
  ps.shop.slots.forEach((s, i) => {
    if (!s || s.sold || s.kind !== 'chess' || ps.priceOf(s) > ps.funds) return;
    const base = (ps?.gd || m.gd).baseIdOf(s.id);
    if (m.pool.has(base) && m.pool.left(base) < 1) return;
    const g = refreshGarrisons(m, s.id), n = g.sold + g.gain;
    if (n > bestN) { bestN = n; best = i; }
  });
  if (best < 0) return false;
  const id = ps.shop.slots[best].id;
  const before = new Set(ps.allChess().map((p) => p.uid));
  if (!tryDo(() => ps.buy(best))) return false;
  const got = ps.allChess().find((p) => !before.has(p.uid) && ps.find(p.uid)?.area !== 'board');
  if (got && refreshEngineSurplus(m, ps, got)) tryDo(() => ps.sell(got.uid));
  return true;
}

/**
 * A refresh engine on the bench is sold for its free refreshes only when it has no other use: its 三合一 (elite + a
 * higher-tier pick) can no longer be reached from the pool, or the hand is nearly full (≤ 1 free slot) — never from the
 * board, and an elite only late (round ≥ boss − 2).
 */
function refreshEngineSurplus(m, ps, p) {
  if (!p || p.kind !== 'chess' || refreshGarrisons(m, p.id).sold <= 0) return false;
  const loc = ps.find(p.uid);
  if (!loc || loc.area === 'board') return false;
  if ((ps?.gd || m.gd).isGolden(p.id)) return m.round >= ((ps?.gd || m.gd).bossRound || 14) - 2;
  const base = (ps?.gd || m.gd).baseIdOf(p.id);
  const need = (ps?.gd || m.gd).mergeCount(base) || 3;
  const have = ps.countCopies(base);
  const reachable = have >= need || (!m.pool.has(base) || m.pool.left(base) >= need - have);
  const crowded = ps.hand.filter((x) => !x).length <= 1;
  return !reachable || crowded;
}

/** Sell bench chess whose sale pays free refreshes (granted 德克萨斯 …), keeping merge pairs. */
function sellRefreshEngines(m, ps) {
  if (!pol(m).refreshFlip) return;
  for (const p of [...ps.hand]) if (refreshEngineSurplus(m, ps, p)) tryDo(() => ps.sell(p.uid));
}

/** Layers a chess adds per round through SERVER_GAIN_BOND_LAYER_BY_REFRESH_CNT (first refresh), valued over the rounds left. */
function refreshStackValue(m, ps, id) {
  let v = 0;
  const left = Math.max(0, Math.min(8, ((ps?.gd || m.gd).bossRound || 14) - m.round));
  for (const g of garrisons(m, id)) {
    if (g.effectKey !== 'SERVER_GAIN_BOND_LAYER_BY_REFRESH_CNT') continue;
    for (const bond of String(g.bbStr?.bond || '').split(',').filter(Boolean)) v += layerValue(m, ps, bond, (Number(g.bb?.layer) || 0) * left, ps.bonds);
  }
  return v;
}

/** playbook holdBases: bench chess that are never sold to make room (拉普兰德 for the 贾维 engine). */
function heldBase(m, p) { const h = pol(m).holdBases; return !!(h && p && p.kind === 'chess' && h.includes(m.gd.baseIdOf(p.id))); }

/**
 * Freeze the shop (free) when it shows a copy that would complete a held pair and the bot cannot afford it: the unsold
 * slots are kept at the next round start (PlayerState.startRound rollShop keepFrozen), the rest rerolled.
 */
function maybeFreeze(m, ps) {
  if (ps.shop.frozen) return;
  if (ps.shop.slots.some((s) => s && !s.sold && s.kind === 'chess' && ps.priceOf(s) > ps.funds && ps.completesChessMerge(s.id))) tryDo(() => ps.freeze());
}

/** Whether level `lv` of the 调度中心 opens one of the player's slotted 自选 pieces with copies left (player/diy.js). */
export function diyOpensAt(ps, lv) {
  const st = ps.diyStock;
  if (!st || !st.entries || !st.entries.size) return false;
  for (const e of st.entries.values()) if (e.shopLevel === lv && e.left > 0) return true;
  return false;
}

/** The 调度中心 level-ups of a bot's prep (exported for tests). */
export function levelUp(m, ps, { spare = false } = {}) {
  const gd = ps?.gd || m.gd;
  const P = pol(m);
  for (let guard = 0; guard < 6; guard++) {
    if (ps.shop.level >= gd.maxShopLevel) return;
    // V3 band playbook: botPolicy.levelCap per round (e.g. 贾维 holds level 2 to round 8) unless levelCapUnlock is met
    const capCurve = P.levelCap;
    if (Array.isArray(capCurve) && capCurve.length) {
      const cap = capCurve[Math.min(capCurve.length - 1, m.round)];
      if (cap != null && ps.shop.level >= cap && !levelCapUnlocked(m, ps)) return;
    }
    const price = Math.max(0, ps.shop.upgradePrice);
    if (ps.funds < price) return;
    const r = m.round;
    const curve = P.levelTargets || LEVEL_TARGET;
    const target = curve[Math.min(curve.length - 1, r)];
    const nextTarget = curve[Math.min(curve.length - 1, r + 1)];
    // early levels only once the board is full (units first); later a 6-unit core is enough (V3: ABYSS round 3 at 4)
    const boardReady = ps.allChess().length >= (m.difficulty === 'ABYSS' && r === 3 ? 4 : r <= 4 ? ps.deployCap : Math.min(ps.deployCap, 6));
    // V3: the core plan's tier access (coreUpgradeWanted) and the relay role (relayUpgradeWanted) may want a level
    let want = price === 0 || coreUpgradeWanted(m, ps, target, price) || relayUpgradeWanted(m, ps, price);
    if (!want && ps.shop.level < target && (boardReady || r >= 6)) want = true;
    // a human's 自选 slots of the next level (AI 托管): that step one round earlier (DIY_PIECE_BONUS)
    if (!want && boardReady && ps.shop.level < nextTarget && diyOpensAt(ps, ps.shop.level + 1)) want = true;
    if (!want && ps.shop.level < nextTarget && price <= 2 && boardReady) want = true;
    if (!want && spare && ps.funds >= price + 1 + fundsReserve(m, ps) && ps.shop.level < nextTarget + 1 && boardReady) want = true;
    if (!want && ps.funds >= price + (P.levelSpareMargin ?? 14)) want = true;
    // V3: preserve one recruit's budget during vulnerable development; free upgrades never wait.
    const reserve = r <= (P.upgradeReserveUntilRound ?? 8) ? (P.upgradeReserveCoins ?? 0) : 0;
    if (price > 0 && ps.funds < price + reserve) return;
    if (!want || !tryDo(() => ps.levelUp())) return;
  }
}

/**
 * Funds a band that keeps its leftover (gd.leftoverKeptBands: 坎诺特 利滚利 "每回合剩余的资金可以继承，剩余至少5资金时，
 * 每回合额外获得1资金") holds back from discretionary spending — refreshes, full-board purchases that complete nothing,
 * items, spare level-ups: the interest capital (coin_carry_over bb.capital, 5). 0 for every other band (their
 * leftover is lost at the prep end, so spending it all is free value).
 */
function fundsReserve(m, ps) {
  if (!m.gd.leftoverKeptBands.includes(ps.bandId)) return 0;
  const band = m.gd.band(ps.bandId);
  const buff = band && Array.isArray(band.buffs) ? band.buffs.find((b) => b && b.key === 'coin_carry_over') : null;
  const cap = Number(buff && buff.bb && buff.bb.capital);
  return Number.isFinite(cap) && cap > 0 ? cap : 5;
}

/** Buying / rerolling toward the lineup; a step generator (yields after each purchase or reroll). */
function* buyLoopSteps(m, ps, { fillOnly = false, maxRefreshes = 0 } = {}) {
  const gd = ps?.gd || m.gd;
  const P = pol(m);
  // V3: earned free rolls have their own bounded allowance, so they do not consume the paid-search budget
  let paidRefreshes = 0, freeRefreshes = 0;
  const minPrice = 2;
  const reserve = fundsReserve(m, ps);
  // the best lineup is reused while the owned chess stay the same (a refresh changes only the shop)
  let memo = null;
  for (let guard = 0; guard < 40; guard++) {
    if (guard > 0) yield;
    takeOffers(m, ps); // V3: merges completed by the previous purchase queue offers that expire at prep end
    const ctx = context(m, ps);
    const ownedN = ps.allChess().length;
    const ownKey = `${ps.allChess().map((p) => `${p.uid}:${p.id}:${(p.items || []).length}`).join()}|${ctx.focus}|${ctx.second}`;
    const boardFull = ownedN >= ps.deployCap;
    // the first pass fills the board, then completes the merges it can afford — before any level-up spends the funds
    const mergesOnly = fillOnly && boardFull;
    // keep room for merges: a crowded bench sheds its weakest single — never one that came this prep (the buy picks by
    // lineup gain, the shed by piece value: it used to sell the single just bought for 3–5 back for 1; QA of the 0.1.1
    // bots) nor one gained since the last prep (the operator a 突变细胞 transformation put on the bench, its deployment
    // freed: in 20 solo 绝境 昆图斯 matches the shed sold 44 of 222 before the placement step could deploy them). The
    // shed is pre-emptive (one slot is still free), so with only fresh singles it waits for the next prep.
    const used = ps.hand.filter(Boolean).length;
    if (used >= gd.benchSize - 1) sellWeakestHand(m, ps, { keepFresh: true });
    // a full hand refuses every purchase, the third copy of a held pair too (PlayerState.buy, PRTS 卫戍协议/帮助 §手牌区):
    // an affordable one sheds the weakest hand single first (like the shed above, never one of this prep)
    if (freeSlot(ps.hand) < 0 && ps.shop.slots.some((s) => s && !s.sold && s.kind === 'chess' && ps.priceOf(s) <= ps.funds && ps.completesChessMerge(s.id))) {
      sellWeakestHand(m, ps, { handOnly: true, keepFresh: true });
    }
    let best = -1;
    let bestS = 0;
    let bestMerges = false;
    let trade = false;
    let cur = null;
    const lineup = () => {
      if (!cur) {
        if (!memo || memo.key !== ownKey) memo = { key: ownKey, cur: chooseLineup(m, ps, ctx) };
        cur = memo.cur;
      }
      return cur;
    };
    ps.shop.slots.forEach((s, i) => {
      if (!s || s.sold) return;
      const price = ps.priceOf(s);
      if (price > ps.funds) return;
      let sc;
      let sellAfter = false;
      if (s.kind === 'chess') {
        const merges = ps.completesChessMerge(s.id);
        if (freeSlot(ps.hand) < 0 || (mergesOnly && !merges)) return;
        const base = gd.baseIdOf(s.id);
        // V3: never a copy the shared pool cannot supply
        if (m.pool.has(base) && m.pool.left(base) < (gd.isGolden(s.id) ? gd.goldenCopies : 1)) return;
        if (boardFull && !merges && ps.funds - price < reserve) return; // banked (坎诺特)
        // playbook bondOnlyBuy: from shop level bondOnlyFromLevel on, only members of that bond (merges excepted)
        const only = P.bondOnlyBuy;
        if (only && ps.shop.level >= (P.bondOnlyFromLevel ?? 2) && !merges && !(gd.chess(s.id)?.bonds || []).includes(only)) return;
        // playbook refresh budget: off-core singles may not eat the coins the forced refreshes still need
        const forceLeft = Math.max(0, (P.forceRefreshes || 0) - (ps.round?.refreshes || 0));
        if (forceLeft > 0 && !fillOnly && !merges && !ctx.copies.get(base) && !(ctx.focus && gd.chess(s.id)?.bonds?.includes(ctx.focus))
          && ps.funds - price < forceLeft * gd.refreshPrice) return;
        sc = buyScore(m, ps, s.id, ctx) - price;
        // upstream's bench budget also bounds V3's full-board purchases (engines, trades, pairs): a non-merge buy waits
        // while the bench already holds botPolicy.benchBudget (default BENCH_BUDGET) chess
        if (boardFull && !merges && ps.hand.filter((p) => p && p.kind === 'chess').length >= (P.benchBudget ?? BENCH_BUDGET)) return;
        if (boardFull && !merges) {
          if (!ctx.copies.get(base) || (P.poolAwareMerges && !botMergeReachable(m, ps, s.id))) {
            // with a full board a new operator must improve the lineup — V3: or be a bench engine (recurring traits,
            // core reserve, economy recruit), or pay for itself through an immediate gain / sale trait (bought, then sold)
            const gain = lineupGain(m, ps, s.id, ctx, lineup());
            const probe = { id: s.id, kind: 'chess', items: [] };
            const engine = recurringValue(m, ps, probe, { bench: true }) + coreReserveValue(m, ps, s.id) + economyRecruitValue(m, ps, s.id);
            const immediate = traitValue(m, ps, probe, ['SERVER_GAIN', 'SERVER_CHESS_SOLD']);
            const netCost = Math.max(0, price - gd.sellPrice(s.id));
            if (gain <= 2 && engine < 1 && immediate < 2 + netCost * 2.5) return;
            sellAfter = gain <= 2 && engine < 1;
            if (sellAfter) sc = immediate * 2 - netCost * 2.5;
            sc += Math.min(15, gain * 0.5);
          } else if (gd.isGolden(s.id) || (!ctx.keep.has(base) && !(ctx.pairs < MAX_PAIRS && (chessRec(m, s.id, ps)?.tier ?? 6) <= 3 && countFree(ps.hand) >= 3))) {
            // a second copy of a non-keeper with no bench room for another pair is clutter, sold later at a loss
            return;
          }
        }
        if (!boardFull) sc += 8;
      } else {
        if (fillOnly) return;
        if (!canUseItem(m, ps, { id: s.id })) return;
        if (freeSlot(ps.hand) < 0) return;
        if (ps.funds - price < reserve && !ps.completesItemMerge(s.id)) return;
        // V3: an item by its best equipment target (role, signatures, combinations, marginal replacement value)
        const target = bestEquipmentTarget(m, ps, s.id);
        if (!target) return;
        sc = target.score - price * 1.5 + (ps.completesItemMerge(s.id) ? 8 : 0);
      }
      if (sc > bestS) { bestS = sc; best = i; trade = sellAfter; bestMerges = s.kind === 'chess' && ps.completesChessMerge(s.id); }
    });
    // leftover funds are lost at prep end: reroll while a purchase stays affordable (a band that keeps them: down to its
    // reserve — a free refresh is always taken). V3: separate paid / free budgets, and a paid reroll with nothing left to
    // buy only when the refresh engines it feeds are worth it (botStrategy refreshValue: refresh / prep-end trait gains).
    const refreshCost = ps.shop.freeRefreshes > 0 ? 0 : gd.refreshPrice;
    const refreshRoom = maxRefreshes > 0 && (refreshCost === 0 ? freeRefreshes < Math.max(4, maxRefreshes * 2) : paidRefreshes < maxRefreshes);
    const funded = ps.funds >= refreshCost + (refreshCost > 0 ? Math.max(ps.shop.level >= 3 ? 1 : minPrice, reserve) : 0);
    const growth = strategyRefreshValue(m, ps);
    const canRefresh = refreshRoom && (refreshCost === 0 || funded || (growth >= refreshCost * 1.5 && ps.funds - refreshCost >= reserve && ps.funds >= refreshCost));
    // a full board buys only what improves it (merge progress, a lineup upgrade), and only when it is worth more than
    // the refreshes its price would pay for (each may show the third copy of a held pair, refreshValue)
    let buy = best >= 0 && bestS >= (boardFull ? (P.fullBoardBuyMin ?? BUY_FULL_MIN) : 3);
    if (buy && boardFull && canRefresh && !bestMerges && !trade) {
      const price = Math.max(1, ps.priceOf(ps.shop.slots[best]));
      if (bestS < refreshValue(m, ps, ctx) * price / Math.max(1, refreshCost)) buy = false;
    }
    if (buy) {
      const id = ps.shop.slots[best].id;
      const before = trade ? new Set(ps.allChess().map((p) => p.uid)) : null;
      const beforeCore = ps._botCore;
      if (!tryDo(() => ps.buy(best))) return;
      // V3: a purchase that completes a core threshold re-arranges at once (the activated bond's hooks see it)
      if (!trade && beforeCore && gd.chess(id)?.bonds?.includes(beforeCore.id)) {
        const next = corePlan(m, ps);
        const thresholds = gd.bond(beforeCore.id)?.thresholds || [3];
        if (next?.id === beforeCore.id && thresholds.some((n) => beforeCore.count < n && next.count >= n
          && (ps.bonds[next.id]?.count || 0) < n)) yield* arrangeSteps(m, ps);
      }
      if (trade) {
        const bought = ps.allChess().find((p) => p.id === id && !before.has(p.uid) && ps.find(p.uid)?.area !== 'board');
        if (bought && !gd.isGolden(bought.id)) tryDo(() => ps.sell(bought.uid));
      }
      continue;
    }
    if (P.econSweep && !fillOnly) {
      // a money item that beats its price is bought before any reroll; when this reroll would leave nothing to buy,
      // any money move beats losing the coins
      const lastCoins = refreshCost > 0 && ps.funds - refreshCost < (ps.shop.level >= 3 ? 1 : minPrice);
      const pick = econPick(m, ps, { profitOnly: !lastCoins });
      if (pick && !gd.leftoverKeptBands.includes(ps.bandId) && buyEconSlot(m, ps, pick.i, pick.keep)) continue;
    }
    // 坎诺特-type bands keep their leftover funds (+1 interest at ≥ 5): no paid reroll below that
    const keepsFunds = P.cannotInterest && gd.leftoverKeptBands.includes(ps.bandId);
    if (keepsFunds && refreshCost > 0 && ps.funds - refreshCost < 5) return;
    if (!fillOnly && P.refreshFlip) {
      sellRefreshEngines(m, ps);
      if (refreshCost > 0 && refreshFlipStep(m, ps)) continue;
    }
    // playbook: refresh this many times per round even with nothing left to buy (special / counted refreshes)
    const forced = !fillOnly && (P.forceRefreshes || 0) > (ps.round?.refreshes || 0) && ps.funds >= refreshCost;
    if (forced || canRefresh) {
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
      const keep = ps.countCopies((ps?.gd || m.gd).baseIdOf(p.id)) >= 2 || (ps?.gd || m.gd).isGolden(p.id)
        || (p.items || []).length > 0 || benchValue(m, ps, p) >= 1 || (ps?.gd || m.gd).chess(p.id)?.bonds?.includes(ctx.focus);
      if (!keep) tryDo(() => ps.sell(p.uid));
    }
  }
  yield;
  const plans = [];
  if (final && (m.wave || (pol(m).bossRehearsalPlans > 0 && m.bossGroupOf?.(ps))) && m.botRehearsal > 0) {
    plans.push(yield* planLayoutSteps(m, ps, chosen));
    // Compare a different roster as well as geometry, using only pieces actually owned.
    const alternatives = [];
    for (const incoming of lineup.bench) for (let i = 0; i < chosen.length; i++) {
      if (!ps.find(incoming.uid)) continue; // a full hand may have forced an outgoing unit to be sold above
      if (incoming.id === chosen[i].id) continue;
      const set = chosen.slice(); set[i] = incoming;
      const score = lineupScore(m, ps, set, ctx);
      alternatives.push({ set, score, incoming: incoming.uid });
    }
    alternatives.sort((a, b) => b.score - a.score);
    const rosterLimit = Math.max(1, Math.min(4, Math.floor(pol(m).rehearsalRosterCandidates ?? 1)));
    const tried = new Set();
    for (const candidate of alternatives) {
      if (tried.has(candidate.incoming)) continue;
      plans.push(yield* planLayoutSteps(m, ps, candidate.set));
      tried.add(candidate.incoming);
      if (tried.size >= rosterLimit) break;
    }
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
  // (the server's g.move decides legality: a refused tile is excluded on the second pass)
  const refused = new Set();
  for (let pass = 0; pass < 2; pass++) {
    const off = chosen.filter((p) => { const loc = ps.find(p.uid); return loc && loc.area !== 'board'; });
    if (!off.length || ps.deployCount >= ps.deployCap) break;
    yield;
    const again = yield* planLayoutSteps(m, ps, off, LAYOUT_PARAMS, { occupied: new Set([...ps.board.keys(), ...refused]) });
    for (const p of off) {
      const k = again.get(p.uid);
      if (!k || ps.deployCount >= ps.deployCap) continue;
      const [r, c] = parseKey(k);
      if (!tryDo(() => ps.move(p.uid, { area: 'board', row: r, col: c }, planDir(again, p.uid)))) refused.add(k);
    }
    if (!refused.size) break;
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
  const rec = (ps.gd || m.gd).token(p.id);
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
  const ops = [...ps.board.entries()].filter(([k, q]) => q.kind === 'chess' && !faced.has(k)).map(([k, q]) => [k, (ps.gd || m.gd).chess(q.id)]).filter(([, c]) => c)
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

/** Tiles a summon placement tries before giving up (a refused tile is skipped and the next best one taken). */
const SUMMON_TRIES = 4;

/**
 * Placeable summons from the hand / temp onto the best free tiles (one per stack count). The server's g.move decides
 * legality: a refused tile is excluded and the next best one tried (SUMMON_TRIES).
 */
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
      const refused = new Set();
      let placed = false;
      for (let t = 0; t < SUMMON_TRIES && !placed; t++) {
        const plan = yield* planLayoutSteps(m, ps, [p], LAYOUT_PARAMS, { occupied: new Set([...ps.board.keys(), ...refused]) });
        const k = plan.get(p.uid);
        if (!k) break;
        const [r, c] = parseKey(k);
        if (tryDo(() => ps.move(p.uid, { area: 'board', row: r, col: c }, planDir(plan, p.uid)))) placed = true;
        else refused.add(k);
      }
      if (!placed) break;
    }
  }
}

/** What an item does: the key of its first buff (data/items.json `buffs`, e.g. use_equip_reward_char_chess). */
const itemEffect = (rec) => (rec && Array.isArray(rec.buffs) && rec.buffs[0] && typeof rec.buffs[0].key === 'string' ? rec.buffs[0].key : '');

/** 突变细胞 (buff char_chess_transformation_equip). */
const isMutationCell = (gd, itemId) => itemEffect(gd.item(itemId)) === 'char_chess_transformation_equip';

/**
 * Whom the bot injects with 突变细胞 (after the battle its carrier — deployed or on the bench: every owned carrier's item
 * hooks run — is destroyed and a random operator one tier higher joins the bench, PlayerState.transformChess; the next
 * prep's lineup step deploys it like any owned unit, so a deployed carrier only costs a re-placement): the least
 * valuable normal operator below 6阶 with a free equip slot — never an elite, never one of a merge pair (the merge
 * progress would be lost), nobody already carrying a cell. null: the cell waits in the hand.
 */
export function cellTarget(m, ps, ctx = context(m, ps)) {
  const gd = ps?.gd || m.gd;
  let best = null;
  let bestV = Infinity;
  for (const p of ps.allChess()) {
    if (gd.isGolden(p.id) || gd.tierOf(p.id) >= 6 || (p.items || []).length >= gd.equipPerChess) continue;
    if ((p.items || []).some((it) => isMutationCell(gd, it.id)) || (ctx.copies.get(gd.baseIdOf(p.id)) || 0) >= 2) continue;
    const v = pieceValue(m, ps, p, ctx);
    if (v < bestV || (v === bestV && p.uid < best.uid)) { bestV = v; best = p; }
  }
  return best;
}

/** Whether the bot's own last battle was perfect (no counted leak). */
function lastPerfect(m, ps) {
  const r = m.lastResults && m.lastResults.get(ps.playerId);
  return !!r && r.perfect !== false && !(r.leaked || []).some((l) => l && l.counted !== false);
}

/**
 * The carrier of an item (null = keep it), by what the item does (itemEffect):
 *   信标 (destroys its carrier for a pick of two chess of the same tier): the highest-tier bench single, else the
 *     weakest normal deployed operator;
 *   拟态物质 (a third copy of a pair, else a member of a bond): a pair (highest tier), else a focus member — never one
 *     of 2 copies whose pool is out (the item gives nothing then);
 *   博士投影 (promotes to elite; the normal one at the next round start, the golden one at once): the strongest normal
 *     deployed operator;
 *   突变细胞 (the carrier becomes a random tier + 1 operator after the battle): cellTarget;
 *   随身身份牌 / 简易通讯机 / 寻呼模块 (act on the carrier's bonds): the operator whose bonds matter most (focus first);
 *   funds, 紧急调度券, 人事部文档 …: anyone, one with a free slot first (on a full carrier the item replaces one of its
 *     items, GitHub #263); a bond signature item (requiresBondId): a member of that bond;
 *   other equipment: the strongest deployed damage dealers with a free slot (SURVIVAL items blockers first).
 */
export function itemTarget(m, ps, item, ctx = context(m, ps)) {
  const gd = ps?.gd || m.gd;
  const rec = gd.item(item.id);
  if (!rec) return null;
  const key = itemEffect(rec);
  const value = new Map();
  const val = (p) => { if (!value.has(p.uid)) value.set(p.uid, pieceValue(m, ps, p, ctx)); return value.get(p.uid); };
  const deployed = [...ps.board.values()].filter((p) => p.kind === 'chess');
  const owned = ps.allChess();
  const normal = (p) => !gd.isGolden(p.id);
  const byVal = (list, dir = -1) => list.slice().sort((a, b) => dir * (val(a) - val(b)) || a.uid - b.uid);
  const rel = (p) => { let r = 0; for (const b of chessRec(m, p.id, ps)?.bonds || []) r += b === ctx.focus ? 3 : b === ctx.second ? 2 : ps.bonds[b] && ps.bonds[b].active ? 1 : 0; return r; };
  switch (key) {
    case 'use_equip_recruit_new_char_and_give_char_to_player_most_bond': {
      // a bench single of the highest tier (a pick of two of its tier), else the weakest deployed normal operator
      const counts = copyCounts(m, ps);
      const bench = owned.filter((p) => normal(p) && ps.find(p.uid)?.area !== 'board' && (counts.get(gd.baseIdOf(p.id)) || 0) < 2)
        .sort((a, b) => (chessRec(m, b.id, ps)?.tier || 0) - (chessRec(m, a.id, ps)?.tier || 0) || val(a) - val(b) || a.uid - b.uid);
      return bench[0] || byVal(deployed.filter(normal), 1)[0] || null;
    }
    case 'use_equip_reward_char_chess': {
      // with 2 copies owned and none left in the pool the item gives nothing (GitHub #207): such a pair is no carrier
      const counts = copyCounts(m, ps);
      const live = (base) => { const pool = typeof ps.poolOf === 'function' ? ps.poolOf(base) : m.pool; return pool.left(base) > 0 || !pool.has(base); };
      const dead = (p) => (counts.get(gd.baseIdOf(p.id)) || 0) >= 2 && !live(gd.baseIdOf(p.id));
      const pair = owned.filter((p) => normal(p) && !dead(p) && (counts.get(gd.baseIdOf(p.id)) || 0) + 1 >= mergeNeed(m, gd.baseIdOf(p.id)))
        .sort((a, b) => (chessRec(m, b.id, ps)?.tier || 0) - (chessRec(m, a.id, ps)?.tier || 0) || a.uid - b.uid);
      return pair[0] || owned.filter((p) => !dead(p)).sort((a, b) => rel(b) - rel(a) || val(b) - val(a) || a.uid - b.uid)[0] || null;
    }
    // 博士投影: the normal one promotes at the next round start, the golden one (缪尔赛思's R1 item, item merges) at once;
    // both refuse an elite (builtinMeta: BAD_TARGET 'already elite')
    case 'equip_round_start_upgrade_char':
    case 'use_equip_upgrade_char':
      return byVal(deployed.filter(normal))[0] || byVal(owned.filter(normal))[0] || null;
    case 'char_chess_transformation_equip':
      return cellTarget(m, ps, ctx);
    case 'use_equip_reward_char_chess_bond_layer':
    case 'use_equip_reward_char_chess_with_same_bond':
    case 'use_equip_reward_special_goods_char_chess':
      return owned.slice().sort((a, b) => rel(b) - rel(a) || val(b) - val(a) || a.uid - b.uid)[0] || null;
    default:
      break;
  }
  const consume = typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip');
  const list = byVal(deployed);
  const free = (p) => (p.items || []).length < gd.equipPerChess;
  // a consumable on a full carrier destroys one of its items (the replace rule, GitHub #263): a carrier with a free slot
  // first — the effect is the same on anyone
  if (consume) return list.find(free) || owned.find(free) || list[0] || owned[0] || null;
  if (rec.requiresBondId) {
    const member = list.find((p) => free(p) && (chessRec(m, p.id, ps)?.bonds || []).includes(rec.requiresBondId));
    if (member) return member;
  }
  // damage dealers carry equipment first (healers / non-attackers last); survival items on blockers first
  const dealer = (p) => { const c = chessRec(m, p.id, ps); return c && !isHealer(c) && c.attackKind !== 'none'; };
  const blocker = (p) => isBlocker(chessRec(m, p.id, ps));
  const order = rec.category === 'SURVIVAL'
    ? [...list.filter(blocker), ...list.filter((p) => !blocker(p) && dealer(p)), ...list.filter((p) => !blocker(p) && !dealer(p))]
    : [...list.filter(dealer), ...list.filter((p) => !dealer(p))];
  return order.find(free) || null;
}

/**
 * 画卷 timing (botPolicy.scrollTiming): the [tileKey, piece] worth copying now, or null to keep the scroll. Worth it: a
 * copy that completes a three-copy promotion (tier ≥ scrollMergeTier, default 2), or an elite of tier ≥ max(2, shop
 * level − 1) (夕's 墨色真颜: the same-name pair gets +30 % ATK); from round scrollDeadline (default 9) the best of the
 * deployed operators by tier, elite status and promotion.
 */
function scrollTarget(m, ps, ctx, P) {
  const gd = ps?.gd || m.gd;
  const mergeTier = P.scrollMergeTier ?? 2, deadline = P.scrollDeadline ?? 9;
  const eliteTier = Math.max(2, (ps.shop?.level || 1) - 1);
  const normals = new Map();
  for (const p of ps.allChess()) if (!chessRec(m, p.id, ps)?.isGolden) normals.set(gd.baseIdOf(p.id), (normals.get(gd.baseIdOf(p.id)) || 0) + 1);
  const cands = [...ps.board.entries()].filter(([, p]) => p.kind === 'chess').map(([k, p]) => {
    const rec = chessRec(m, p.id, ps) || {};
    const tier = rec.tier || gd.tierOf(gd.baseIdOf(p.id)) || 1;
    const promotes = !rec.isGolden && (normals.get(gd.baseIdOf(p.id)) || 0) === 2;
    const ok = (promotes && tier >= mergeTier) || (rec.isGolden && tier >= eliteTier);
    return { k, p, ok, v: tier * 10 + (rec.isGolden ? 12 : 0) + (promotes ? 15 : 0) + pieceValue(m, ps, p, ctx) * 0.01 };
  }).sort((a, b) => b.v - a.v || a.p.uid - b.p.uid);
  // never die holding it: at low LP (scrollPanicLp, default 8) the best copy now
  const pick = cands.find((c) => c.ok) || (m.round >= deadline || ps.lp <= (P.scrollPanicLp ?? 8) ? cands[0] : null);
  return pick ? [pick.k, pick.p] : null;
}

/** 教鞭 / “神秘顾客”: an Art that adds a bounty to the own next battle (trap_create_self_choice). */
const isBountyArt = (gd, itemId) => { const rec = gd.item(itemId); return !!rec && Array.isArray(rec.buffs) && rec.buffs.some((b) => b && b.key === 'trap_create_self_choice'); };

/**
 * Use an Art: 画卷 copies the operator on its tile (its range is the tile + the one in front) — the most valuable
 * deployed operator, with a free hand slot for the copy; 教鞭 offers a scored personal bounty choice, “神秘顾客” adds a
 * random bounty — only after a perfect battle with LP to spare, else the Art stays in the hand for a later round
 * (destroying 教鞭 gives nothing; a full hand at the prep end: freeHandSlot).
 */
function useArt(m, ps, item, ctx) {
  const rec = m.gd.item(item.id);
  const keys = (rec && Array.isArray(rec.buffs) ? rec.buffs : []).map((b) => b && b.key);
  if (keys.includes('trap_copy_front_char')) {
    if (freeSlot(ps.hand) < 0) return;
    const P = pol(m);
    let best;
    if (P.scrollTiming) {
      // botPolicy.scrollTiming (夕 画卷): hold the scroll until the copy is worth it — an elite of tier ≥ scrollEliteTier
      // (夕's 墨色真颜: the same-name pair gets +30 % ATK), a third copy that promotes a pair of tier ≥ scrollMergeTier,
      // or the deadline round (scrollDeadline, default 10) on the most valuable operator.
      best = scrollTarget(m, ps, ctx, P);
      if (!best) return; // kept
    } else {
      best = [...ps.board.entries()].filter(([, p]) => p.kind === 'chess').sort((a, b) => pieceValue(m, ps, b[1], ctx) - pieceValue(m, ps, a[1], ctx) || a[1].uid - b[1].uid)[0];
    }
    if (!best) return;
    const [r, c] = parseKey(best[0]);
    tryDo(() => ps.useArt(item.uid, r, c));
    return;
  }
  if (keys.includes('trap_create_self_choice')) {
    if (!lastPerfect(m, ps) || ps.lp < 10) return; // kept
    const [key] = [...ps.board.keys()];
    if (key) {
      const [r, c] = parseKey(key);
      if (tryDo(() => ps.useArt(item.uid, r, c))) m.autoPickPersonalChoice(ps, 'bot');
    }
    return;
  }
  const [key] = [...ps.board.keys()];
  if (key) { const [r, c] = parseKey(key); tryDo(() => ps.useArt(item.uid, r, c)); }
}

/**
 * Item uses that upstream's itemTarget decides by what the item does (突变细胞, 信标, 拟态物质, 博士投影, bond items,
 * the most-bond recruit); every other equipment goes through V3's bestEquipmentTarget (role, signatures, combinations,
 * marginal replacement value — it may replace a carried item, and returns null to keep an item waiting, morphPairing).
 */
const ITEM_TARGET_KEYS = new Set([
  'use_equip_recruit_new_char_and_give_char_to_player_most_bond', 'use_equip_reward_char_chess',
  'equip_round_start_upgrade_char', 'use_equip_upgrade_char', 'char_chess_transformation_equip',
  'use_equip_reward_char_chess_bond_layer', 'use_equip_reward_char_chess_with_same_bond', 'use_equip_reward_special_goods_char_chess',
]);

function equipItems(m, ps) {
  const gd = ps?.gd || m.gd;
  const tried = new Set();
  for (let guard = 0; guard < 12; guard++) {
    // V3: the most valuable placement first
    const item = [...ps.hand, ...ps.temp].filter((p) => p && p.kind === 'item' && canUseItem(m, ps, p) && !tried.has(p.uid))
      .sort((a, b) => (bestEquipmentTarget(m, ps, b.id)?.score || 0) - (bestEquipmentTarget(m, ps, a.id)?.score || 0) || a.uid - b.uid)[0];
    if (!item) break;
    tried.add(item.uid);
    const ctx = context(m, ps);
    const rec = gd.item(item.id);
    if (rec && rec.itemType === 'MAGIC') { useArt(m, ps, item, ctx); continue; }
    if (ITEM_TARGET_KEYS.has(itemEffect(rec)) || rec?.itemType !== 'EQUIP') {
      const target = itemTarget(m, ps, item, ctx);
      if (target) tryDo(() => ps.equip(item.uid, target.uid));
      continue;
    }
    const target = bestEquipmentTarget(m, ps, item.id);
    if (!target) continue;
    tryDo(() => ps.equip(item.uid, target.piece.uid, target.replaceUid));
  }
}

/**
 * Free a hand slot for an item worth keeping (突变细胞): sell the weakest single hand chess, else (on a bot's own seat
 * only — a human's items under AI 托管 are never destroyed to make room, like freeHandSlot) destroy the cheapest other
 * hand item, else sell the weakest hand chess even of a pair. `piece` (in temp): done once the freed slot pulled it in
 * (PlayerState._fillHandFromTemp — resolveTemp asks for the rightmost temp piece, the next one a slot pulls in). false:
 * the hand stays full (summon cards only).
 */
function makeHandRoom(m, ps, piece = null) {
  const room = () => freeSlot(ps.hand) >= 0 || (piece != null && !ps.temp.includes(piece));
  if (room()) return true;
  if (sellWeakestHand(m, ps, { handOnly: true }) && room()) return true;
  const gd = ps?.gd || m.gd;
  const junk = ps.isBot && !ps.autoplay ? ps.hand.filter((p) => p && p.kind === 'item' && !isMutationCell(gd, p.id))
    .sort((a, b) => ((gd.item(a.id) || {}).price || 0) - ((gd.item(b.id) || {}).price || 0) || a.uid - b.uid)[0] : null;
  if (junk && tryDo(() => ps.destroy(junk.uid)) && room()) return true;
  return sellWeakestHand(m, ps, { handOnly: true, keepPairs: false }) && room();
}

/**
 * Empty the temp row before Ready. A freed hand slot pulls the temp pieces in by itself, rightmost first
 * (PlayerState._fillHandFromTemp), so the pieces are decided right → left: the one at hand is always the next a freed
 * slot takes. A chess: the weakest bench single is sold to make room (it may be the temp chess itself), else the temp
 * chess is sold; an item: see below, else destroyed.
 */
function resolveTemp(m, ps) {
  for (let i = ps.temp.length - 1; i >= 0; i--) {
    const p = ps.temp[i];
    if (!p) continue;
    const idx = freeSlot(ps.hand); // (a recompute pulls it in; a state set up without one)
    if (idx >= 0 && tryDo(() => ps.move(p.uid, { area: 'hand', idx }))) continue;
    if (p.kind === 'chess') {
      if (!sellWeakestHand(m, ps)) tryDo(() => ps.sell(p.uid));
    } else if (p.kind === 'item') {
      // 突变细胞 comes back after every transformation (昆图斯's strategy item), and a human's item under AI 托管 is theirs:
      // make room in the hand (sell a bench operator) rather than lose it — only a hand of nothing but items still drops it
      if ((isMutationCell(m.gd, p.id) || ps.autoplay) && makeHandRoom(m, ps, p)) {
        if (!ps.temp.includes(p)) continue;
        const j = freeSlot(ps.hand);
        if (j >= 0 && tryDo(() => ps.move(p.uid, { area: 'hand', idx: j }))) continue;
      }
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
