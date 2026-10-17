// Pure, bounded estimates for the bot's economy. Scores are heuristics, not simulated rewards:
// never dispatch effects, take pool copies, or inspect another player's private hand/shop.
import { BOT_POLICY } from './botPolicy.js';
import { BATTLE_LAYER_YIELD } from './botLayerYield.js';
import { relayBandValue, relayCoreValue } from './botTeam.js';
import { BOND_LAYER_CAP } from '../../shared/constants.js';
import { computeBonds, pieceBonds } from './bondsMeta.js';
import { itemKey } from './gamedata.js';
import { positionClass } from './board.js';
import { requireActiveOf } from '../sim/content/garrisons/meta.js';

const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const params = (b) => ({ ...b.bb, ...b.bbStr });
const future = (m) => Math.max(0, m.gd.bossRound - m.round);
const healer = (c) => c?.dmgType === 'heal' || c?.attackKind === 'heal';
const blocker = (c) => c && positionClass(c) === 'melee' && (c.stats?.blockCnt ?? 1) > 0;

export function bandBonds(m, bandId) {
  return [...new Set((m.gd.band(bandId)?.buffs || []).flatMap((b) => {
    const p = params(b);
    return list(p.bond || p.bond_id || m.gd.raw.choices?.pools?.[p.pool]?.bond);
  }).concat(m.gd.bondIds.filter((id) => m.gd.bond(id)?.buffs?.some((b) => b.bbStr?.valid_in_band === bandId))))].filter((id) => m.gd.bond(id));
}


/** Opening defense first, then the core's scaling becomes the main investment. */
export function phaseLayerWeights(m) {
  if (!(m.botPolicy || BOT_POLICY).phaseAware) return {core:1,addon:1};
  const configured=(m.botPolicy || BOT_POLICY).phaseLayerWeights;
  if (configured) return configured[m.round<=4 ? 'early' : m.round<=8 ? 'middle' : 'late'];
  if (m.round <= 4) return {core:0.7,addon:1.6};
  if (m.round <= 8) return {core:1,addon:1.2};
  return {core:1.6,addon:0.9};
}

/** Four-AI resource competition: only visible boards, never teammates' private hands or shops. */
export function publicCoreCompetition(m, ps, id) {
  const weight = (m.botPolicy || BOT_POLICY).publicCoreCompetitionWeight || 0;
  if (!(weight > 0)) return 0;
  const first = (ps?.gd || m.gd).bond(id)?.thresholds?.[0] || 3;
  let pressure = 0;
  for (const mate of m.order) {
    if (mate === ps || mate.alive === false || mate.left || !(mate.board instanceof Map)) continue;
    const members = new Set([...mate.board.values()].filter(p => p.kind === 'chess' && pieceBonds(m.gd,p).includes(id)).map(p => (ps?.gd || m.gd).baseIdOf(p.id)));
    if (members.size >= 2) pressure += Math.min(1.5, members.size / first);
  }
  return pressure * 18 * Math.min(2, weight);
}

/** Plan a reachable core, keeping the opening strategy and committed layers together.
 * Count distinct operators, not remaining copies. Equipment membership follows the real bond rules.
 */
/**
 * botPolicy.teammateCoreExclusive (weight, default 0 = off): a core an AI teammate already pursues with more distinct
 * members (ties: the lower seat keeps it) costs that weight, at any stage — two AIs no longer split one core's pool
 * (human log VDTG: two AIs both on 精准). Humans' cores are not claimed.
 */
function teammateCoreClaim(m, ps, id, count) {
  const w = (m.botPolicy || BOT_POLICY).teammateCoreExclusive || 0;
  if (!w) return 0;
  for (const q of m.order) {
    if (q === ps || !q.isBot || q.alive === false || q.left) continue;
    const c = q._botCore;
    if (!c || c.id !== id) continue;
    if (c.count > count || (c.count === count && q.seat < ps.seat)) return w;
  }
  return 0;
}

export function corePlan(m, ps) {
  const owned = new Map(), all = ps.allChess();
  for (const p of all) for (const id of pieceBonds(m.gd, p)) {
    if (!owned.has(id)) owned.set(id, new Set());
    owned.get(id).add((ps?.gd || m.gd).baseIdOf(p.id));
  }
  const available = new Map([...owned].map(([id, members]) => [id, new Set(members)]));
  for (const [base, entry] of m.pool.entries) if (entry.left > 0) {
    for (const id of (ps?.gd || m.gd).chess(base)?.bonds || []) {
      if (!available.has(id)) available.set(id, new Set());
      available.get(id).add(base);
    }
  }
  // botPolicy.extraCoreTargets (band playbooks, e.g. 变形者集群 → 维多利亚): cores pursued from zero like the band's own
  const extra = (m.botPolicy || BOT_POLICY).extraCoreTargets;
  const targets = extra?.length ? [...bandBonds(m, ps.bandId), ...extra] : bandBonds(m, ps.bandId), previous = ps._botCore?.id;
  let best = null;
  for (const id of (ps?.gd || m.gd).bondIds) {
    const b = (ps?.gd || m.gd).bond(id);
    if (!b?.isCore || (ps?.gd || m.gd).modeInactiveBonds.has(id)) continue;
    const count = owned.get(id)?.size || 0, reachable = available.get(id)?.size || 0;
    const thresholds = b.thresholds?.length ? b.thresholds : [b.activeCount || 3];
    const first = thresholds[0], upper = thresholds[1] || first;
    if (reachable < first || (!count && !targets.includes(id))) continue;
    const target = reachable >= upper && upper <= ps.deployCap ? upper : first;
    const missing = [...(available.get(id) || [])].filter((base) => !owned.get(id)?.has(base)).map((base) => (ps?.gd || m.gd).tierOf(base)).sort((a, b) => a - b);
    const firstLevel = count >= first ? 0 : missing[first - count - 1] || (ps?.gd || m.gd).maxShopLevel;
    const finishLevel = count >= target ? 0 : missing[target - count - 1] || (ps?.gd || m.gd).maxShopLevel;
    const availableNow = missing.filter((tier) => tier <= ps.shop.level).length;
    const access = Math.min(Math.max(0, target - count), availableNow) * 8 - Math.max(0, firstLevel - ps.shop.level) * 12;
    const score = Math.min(count, target) * 22 + Math.min((m.botPolicy || BOT_POLICY).coreLayerCap, (ps.layers[id] || 0) * (m.botPolicy || BOT_POLICY).coreLayerWeight * phaseLayerWeights(m).core)
      + (targets.includes(id) ? 80 : 0) + (id === previous && count >= first ? 16 : 0)
      + (target === upper ? 8 : 0) + access + relayCoreValue(m, ps, id, count, first, bandBonds)
      + ((m.botPolicy || BOT_POLICY).corePreference?.[id] ?? 0)
      - (count < first ? publicCoreCompetition(m, ps, id) : 0)
      - teammateCoreClaim(m, ps, id, count);
    if (!best || score > best.score) best = { id, count, target, reachable, first, finishLevel, score };
  }
  ps._botCore = best;
  return best;
}


/** Spend on access rather than rerolling below the tier needed for an established core.
 * At most one level ahead of the normal curve, with at least four coins left for recruitment.
 */
export function coreUpgradeWanted(m, ps, normalTarget, price) {
  const plan = ps._botCore;
  return !!(plan && plan.count >= plan.first && plan.count < plan.target
    && plan.finishLevel > ps.shop.level && ps.shop.level < normalTarget + 1
    && ps.allChess().length >= Math.min(6, ps.deployCap) && ps.funds >= price + 4);
}

/** A fourth/fifth distinct core member can be a bridge to the upper threshold, even from the bench. */
export function coreReserveValue(m, ps, id, plan = ps._botCore) {
  if (!plan || m.round >= (ps?.gd || m.gd).bossRound || plan.count >= plan.target) return 0;
  if (!(ps?.gd || m.gd).chess(id)?.bonds?.includes(plan.id) || ps.allChess().some((p) => (ps?.gd || m.gd).baseIdOf(p.id) === (ps?.gd || m.gd).baseIdOf(id))) return 0;
  return 12 + (plan.count + 1 >= plan.target ? 8 : 0);
}

/** Discount future gifts; penalize strategies whose faction was removed by this match's bans. */
export function bandScore(m, ps, id) {
  const b = (ps?.gd || m.gd).band(id);
  if (!b) return -Infinity;
  const P_ = m.botPolicy || BOT_POLICY;
  // botPolicy.humanTeamBandLpWeight / humanTeamBandBias: with a human teammate (3 AI + 1, e.g. an idle 白板 seat) the
  // AIs carry the team — a band that only keeps its own LP (歌利亚 45) is worth less there
  const humanTeam = m.order.some((p) => !p.isBot) && m.order.some((p) => p.isBot);
  let score = (ps?.gd || m.gd).startLp(id) * (humanTeam && P_.humanTeamBandLpWeight != null ? P_.humanTeamBandLpWeight : P_.bandLpWeight);
  const mates = m.order.filter((p) => p !== ps && p.alive !== false && !p.left).length;
  for (const buff of b.buffs || []) {
    const p = params(buff);
    switch (buff.key) {
      case 'prep_finish_char_bond_add_layer': score += 12 * (p.layer || 0); break;
      case 'band_shop_refresh_copy_max_lv_char': score += 17; break;
      case 'band_coin_cost_gain_random_char_by_shop_level': score += 12; break;
      case 'up_shop_add_special_goods': score += 16; break;
      case 'preparation_start_add_special_goods_every_n_round': score += 17; break;
      case 'round_start_gain_char_chess_in_shop_every_n_round': score += 13; break;
      case 'gain_bond_char_per_round': score += 13; break;
      case 'first_buy_in_round_char_price_change': score += 12; break;
      case 'round_start_gain_coin_by_bond_char_chess_buy': score += 12; break;
      case 'band_first_self_refresh_present_char': score += 11; break;
      case 'up_shop_next_refresh_must_present_bond_char': score += 10; break;
      case 'refresh_shop_count_gain_coin_bond_char_chess': score += 10; break;
      case 'round_start_bond_check_gain_layer': score += 11; break;
      case 'preparation_start_gain_chess_from_round': {
        const c = (ps?.gd || m.gd).chess(p.chess), it = (ps?.gd || m.gd).item(p.chess);
        const value = c ? 11 + c.tier * 2 : it ? 3 + it.tier * 1.4 : 0;
        score += value / (1 + Math.max(0, (p.round || 1) - 1) * 0.2);
        break;
      }
      case 'give_coin_in_round':
        // (alone: solo only — upstream keeps it drawable in a one-seat co-op room, test/match/bot.test.js)
        if (p.round <= 2 && p.coin === 0) score -= mates || !m.isSolo ? 9 : 30;
        else score += (p.coin || 0) * 0.35;
        break;
      case 'coin_carry_over': score += 5; break;
      case 'auto_chess_change_map': score += 5 + mates * 3; break;
      case 'env_gbuff_new_with_verify': score += 9; break;
      default: score += 3;
    }
  }
  for (const bond of bandBonds(m, id)) {
    if (!m.bondLive(bond)) score -= 35;
    else if ((ps?.gd || m.gd).bond(bond)?.isCore) {
      const tiers = [...m.pool.entries].filter(([id, e]) => e.left > 0 && (ps?.gd || m.gd).chess(id)?.bonds?.includes(bond)).map(([, e]) => e.tier).sort((a, b) => a - b);
      const th = (ps?.gd || m.gd).bond(bond).thresholds || [3];
      score += 6 - (tiers.length < th[0] ? 45 : Math.max(0, tiers[th[0] - 1] - 3) * 16);
      if (tiers.length < (th[1] || th[0])) score -= 12;
      if (tiers.length >= th[0]) score += (m.botPolicy || BOT_POLICY).coreBandBonus || 0;
    }
    // Public strategy picks indicate competition; no teammate inventory is inspected.
    if (m.order.some((p) => p !== ps && bandBonds(m, p.bandId).includes(bond))) score -= 5;
  }
  const bias = humanTeam && P_.humanTeamBandBias?.[id] != null ? P_.humanTeamBandBias[id] : (P_.bandDefenseBias?.[m.difficulty]?.[id] || 0);
  return score + bias + relayBandValue(m, ps, id, bandBonds(m, id), bandBonds);
}

/**
 * botPolicy.hiddenLayerDrive { from, mul, addonAsCore, finalBonus } (default off): the 隐秘核心 needs Σ activated layers
 * > hiddenCore.single (solo: the own) / hiddenCore.multi (co-op: every alive player's, prep.js hiddenLayerSum) at the
 * R14 prep end. While that Σ (driveLayers) is not above it, from round `from` every layer on an active bond is worth
 * `mul` × (add-ons valued like a core when addonAsCore: each one counts the same toward the threshold); at the R14 prep a
 * lineup that puts the Σ over the threshold scores `finalBonus` more (lineupScore, bot.js). Co-op (`team`): the
 * teammates' current activated layers are added to the own.
 */
export function hiddenDrive(m, ps) {
  const D = (m.botPolicy || BOT_POLICY).hiddenLayerDrive;
  const gd = ps?.gd || m.gd;
  if (!D || !gd.hiddenRound || !gd.hiddenCore?.difficulties?.includes(m.difficulty)) return null;
  if (m.isSolo) return { ...D, threshold: gd.hiddenCore.single, team: false };
  return { ...D, threshold: gd.hiddenCore.multi, team: true };
}

/**
 * Σ activated layers the 隐秘核心 check would count now: the player's own (solo) or every alive player's (co-op drive),
 * with `ownL` standing in for the player's own when given (a projected lineup).
 */
export function driveLayers(m, ps, drive, ownL = null) {
  const own = Number.isFinite(ownL) ? ownL : typeof ps?.activatedLayers === 'function' ? ps.activatedLayers() : 0;
  if (!drive || !drive.team || typeof m.alivePlayers !== 'function') return own;
  let s = own;
  for (const q of m.alivePlayers()) if (q && q.playerId !== ps?.playerId && typeof q.activatedLayers === 'function') s += q.activatedLayers();
  return s;
}

/**
 * How much one layer of a bond is worth in a leader fight (最终攻势 / 隐秘核心), relative to the best: measured on 74
 * captured 隐秘核心 fights of co-op ABYSS (2026-10-16, tools: hcsim counterfactuals, +100 layers on one active bond):
 * 灵巧 / 叙拉古 / 精准 / 奥术 ≈ +5.5 % of the leader bar, 谢拉格 5.2, 不屈 / 坚守 4.4, 维多利亚 3.3, 卡西米尔 2.4, 迅捷 /
 * 阿戈尔 / 炎 / 突袭 ≈ 2, 萨尔贡 1.1, 拉特兰 0.6, 助力 0.3; economy bonds (奇迹 远见 投资人 绝技 独行 调和) 0.
 */
export const COMBAT_LAYER_VALUE = Object.freeze({
  skillfulShip: 1, siracusaShip: 1, preciShip: 1, arcaneShip: 1, kjeragShip: 0.95, indomShip: 0.8, steadShip: 0.8,
  victoriaShip: 0.6, kazimierzShip: 0.45, swiftShip: 0.4, egirShip: 0.4, yanShip: 0.35, raidShip: 0.35,
  sargonShip: 0.2, lateranoShip: 0.1, deputShip: 0.05,
});

/**
 * botPolicy.combatLayerDrive { from, mul, table? } (default off): from round `from` a layer of bond `id` is worth
 * 1 + (mul − 1) × COMBAT_LAYER_VALUE[id] times as much — layers that make the leader fights shorter (the 最终攻势 and the
 * 隐秘核心 are lost to the overtime drain: the team LP runs out with half the bar left). Economy bonds keep 1×.
 */
export function combatLayerFactor(m, id) {
  const C = (m.botPolicy || BOT_POLICY).combatLayerDrive;
  if (!C || !(m.round >= (C.from ?? 9))) return 1;
  const v = (C.table && Number.isFinite(C.table[id]) ? C.table[id] : COMBAT_LAYER_VALUE[id]) || 0;
  return 1 + Math.max(0, (C.mul ?? 1) - 1) * v;
}

/** Value only layers that can matter to this lineup; unactivated layers persist, but are speculative. */
export function layerValue(m, ps, id, amount, bonds = ps.bonds) {
  if (!(ps?.gd || m.gd).bond(id) || (ps?.gd || m.gd).modeInactiveBonds.has(id)) return 0;
  const room = Math.max(0, BOND_LAYER_CAP - (ps.layers[id] || 0));
  let n = Math.min(room, Math.max(0, amount));
  if ((m.botPolicy || BOT_POLICY).layerMilestones) n = usefulLayerAmount(m, ps, id, n);
  const state = bonds[id];
  const weight = state?.active ? 1 : state?.count > 0 ? 0.25 : 0;
  const drive = hiddenDrive(m, ps);
  const driving = !!drive && m.round >= (drive.from ?? 9) && m.round <= (ps?.gd || m.gd).bossRound && typeof ps.activatedLayers === 'function' && driveLayers(m, ps, drive) <= drive.threshold;
  const asCore = (ps?.gd || m.gd).bond(id).isCore || (driving && drive.addonAsCore);
  const priority = asCore ? (ps._botCore?.id === id ? 1.3 : 1) * (m.botPolicy || BOT_POLICY).coreLayerValueMul : 0.8;
  return n * weight * priority * (driving ? drive.mul ?? 1 : 1) * combatLayerFactor(m, id) * (asCore ? phaseLayerWeights(m).core : phaseLayerWeights(m).addon) * (0.35 + Math.min(8, future(m)) * 0.035);
}

/** Probability layers stop helping at 100%; threshold credit is bounded and never invents grants. */
export function usefulLayerAmount(m, ps, id, amount) {
  const L = ps.layers[id] || 0;
  const rec = (ps?.gd || m.gd).bond(id);
  if (!rec || rec.noStack || !(amount > 0)) return 0;
  const b = rec.buffs?.find(x => x.key === 'env_gbuff_new')?.bb || {};
  let n = amount;
  if (id === 'swiftShip' || id === 'indomShip') {
    const cap = b.prob_per_stack > 0 ? (1 - (b.base_prob || 0)) / b.prob_per_stack : Infinity;
    n = Math.min(n, Math.max(0, cap - L));
  }
  // Range expansion / all-unit SP / all-unit ASPD are discrete, real milestones.
  if (['skillfulShip','swiftShip','raidShip'].includes(id) && b.power_bond_stack_cnt > L && L + n >= b.power_bond_stack_cnt) n *= 1.5;
  if (id === 'visiShip' && future(m)) {
    const bb = rec.buffs.find(x => x.key === 'bond_multi_layer_char_goods_price_bond_discount')?.bb || {};
    if ([bb.layer1,bb.layer2].some(t => t > L && L + n >= t)) n *= 1.5;
  }
  return n;
}

export function garrisons(m, id) {
  const cache = m._botGarrisonRecords ||= new Map();
  if (!cache.has(id)) cache.set(id, (m.gd.chess(id)?.garrisonIds || []).map((g) => m.gd.garrison(g)).filter(Boolean));
  return cache.get(id);
}

/** A projected lineup must move outgoing board members to the hand for BOARD_AND_DECK counting. */
export function lineupState(m, ps, set) {
  const inSet = new Set(set.map((p) => p.uid));
  const hand = ps.hand.filter((p) => p && !inSet.has(p.uid));
  for (const p of [...ps.board.values(), ...ps.temp]) {
    if (p?.kind === 'chess' && !inSet.has(p.uid) && !hand.some((h) => h.uid === p.uid) && hand.length < (ps?.gd || m.gd).benchSize) hand.push(p);
  }
  const board = new Map(set.map((p, i) => [`x${i}`, p]));
  return { board, hand, bonds: computeBonds(m.gd, { board, hand, layers: ps.layers, bondCountBonus: ps.bondCountBonus }) };
}

/** Bounded potential for one owned teammate, not a free grant or an assumed full-board aura.
 * The layout planner and real rehearsal still determine whether the neighbour is actually reached.
 */
export function positionalEngineValue(m, ps, piece, count, {board=ps.board,bonds=ps.bonds,bench=false}={}) {
  const policy=m.botPolicy || BOT_POLICY;
  if (bench || !(policy.positionEngineWeight>0) || m.round < (policy.positionEngineMinRound || 1)) return 0;
  const targets=[...board.values()].filter(p=>p.kind==='chess' && p.uid!==piece.uid);
  let best=0;
  for(const p of targets) {
    const value=pieceBonds(m.gd,p).filter(id=>bonds[id]?.active && (!policy.positionEngineCoreOnly || (ps?.gd || m.gd).bond(id)?.isCore)).reduce((n,id)=>n+layerValue(m,ps,id,count,bonds),0);
    best=Math.max(best,value);
  }
  return best*Math.min(0.75,policy.positionTargetCredit || 0.5)*policy.positionEngineWeight;
}

/** Estimate supported trait families from the same blackboards/activation rules as their handlers.
 * Positional traits receive only their self contribution here; no imaginary neighbour credit.
 */
export function traitValue(m, ps, piece, events, { board = ps.board, hand = ps.hand, bonds = ps.bonds, bench = false, refreshes = ps.round.refreshes || 0 } = {}) {
  let value = 0;
  // (port, cost only) nothing to value without a garrison of these events: skip the bond / board scans below
  if (!garrisons(m, piece.id).some((g) => events.includes(g.eventType))) return 0;
  const members = pieceBonds(m.gd, piece);
  const active = Object.keys(bonds).filter((id) => bonds[id].active);
  const top = active.reduce((best, id) => !best || (ps.layers[id] || 0) > (ps.layers[best] || 0) ? id : best, null);
  const deployed = [...board.values()].filter((p) => p.kind === 'chess');
  const tierCount = (id) => new Set(deployed.filter((p) => pieceBonds(m.gd, p).includes(id)).map((p) => (ps?.gd || m.gd).tierOf(p.id))).size;
  for (const g of garrisons(m, piece.id)) {
    if (!events.includes(g.eventType)) continue;
    const b = g.bb || {}, s = g.bbStr || {};
    const before = value;
    const repeat = g.eventType === 'SERVER_GAIN' ? m.dispatcher.investRepeat({ bonds }) : 1;
    if (bench && (s.conditionkey === 'character_target_inboard' || s.conditionkey === 'character_same_row')) continue;
    const add = (id, n) => {
      if (!requireActiveOf(g) || bonds[id]?.active) value += layerValue(m, ps, id, n * repeat, bonds);
    };
    const ids = list(s.bond);
    switch (g.effectKey) {
      case 'SERVER_ADD_BOND': ids.forEach((id) => add(id, b.count)); break;
      case 'SERVER_ADD_BOND_CHESS_ALL': members.forEach((id) => add(id, b.count)); break;
      case 'SERVER_ADD_MULTIPLE_BOND': {
        const counts = list(s.count).map(Number);
        ids.forEach((id, i) => add(id, counts[i] ?? counts.at(-1) ?? 0)); break;
      }
      case 'SERVER_ADD_BOND_ACTIVATED_MOST_LAYER': if (top) add(top, b.count); break;
      case 'SERVER_ADD_ACT_BOND_DIFF_LV_MOST_LAYER': if (top) add(top, tierCount(top) * (b.multi || 1)); break;
      case 'SERVER_ADD_BOND_METHOD':
        for (const id of ids) {
          const amount = { shoplv: ps.shop.level, round_gain_char: ps.round.gainedChess || 0,
            hand_count: hand.filter((p) => p?.kind === 'chess').length,
            same_bond_diff_lv: tierCount(id) }[s.add_method] || 0;
          add(id, amount * (b.multi || 1));
        }
        break;
      case 'SERVER_ADD_BOND_POSITION': if (!bench) { members.forEach((id) => add(id, b.count)); value += positionalEngineValue(m,ps,piece,b.count,{board,bonds,bench}); } break;
      case 'SERVER_ADD_BOND_IN_HAND':
        for (const p of hand) if (p?.kind === 'chess') for (const id of pieceBonds(m.gd, p)) add(id, b.count);
        break;
      case 'SERVER_ADD_BOND_ROUND_COIN_COST': ids.forEach((id) => add(id, Math.floor((ps.round.spent || 0) / Math.max(1, b.count)) * b.layer)); break;
      case 'SERVER_ADD_REFRESH_CNT_MULTIPLIER_BOND_LAYER':
        ids.forEach((id) => add(id, Math.min(b.max_layer || Infinity, refreshes * b.multiplier))); break;
      case 'SERVER_GAIN_BOND_LAYER_BY_REFRESH_CNT':
        // per copy (garrisons/meta.js): a copy fires on its own first refresh of the round — counted unless that copy
        // already did this round (a shop probe or a copy bought after the round's first refresh still fires)
        if (!(Number.isInteger(piece.uid) && ps.counters?.[`refreshLayer:${g.garrisonId}:${piece.uid}:round`] === m.round
          && (ps.counters[`refreshLayer:${g.garrisonId}:${piece.uid}:count`] || 0) >= (b.refresh_cnt || 1))) ids.forEach((id) => add(id, b.layer));
        break;
      case 'SERVER_GAIN_FREE_REFRESH_COUNT': value += (b.count || 1) * 2; break;
      case 'SERVER_ONCE_GOLD_WITH_BOND_CONDITION':
        if (bench && !ids.some((id) => bonds[id]?.active)) break;
        if (future(m)) value += (b.count || 1) * 2; break;
      case 'SERVER_ONCE_GOLD': if (future(m)) value += (b.count || 1) * 2; break;
      case 'SERVER_GAIN_EQUIP': case 'SERVER_POOL_EQUIP': value += (b.count || 1) * 4; break;
      case 'SERVER_GAIN_RANDOM_EQUIP_CHESS_IN_POOL':
        if (!s.round_list || list(s.round_list).map(Number).includes(m.round + 1)) value += (b.count || 1) * 4; break;
      case 'SERVER_POOL_CHAR': if (!s.conditionkey) value += (b.count || 1) * 5; break;
      default: break;
    }
    // Non-layer gain traits (money, free refreshes, items) repeat as well.
    if (!/BOND|LAYER/.test(g.effectKey) && repeat > 1) value = before + (value - before) * repeat;
  }
  return value;
}


/** Conservative battle growth: one deploy, one usable skill, or a small share of the visible wave.
 * Never credit bench units, unactivated bonds, deaths, or uncertain positional/status chains.
 */
export function battleLayerValue(m, ps, piece, { bonds = ps.bonds, bench = false } = {}) {
  if (bench || !m.wave) return 0;
  // botPolicy.battleLayerYield { scale, cap, recurringCap, buyCap } (default off): the measured per-battle yield
  // (botLayerYield.js) replaces the conservative estimate for the operators it lists; layerValue weighs each bond
  // (active 1, members only 0.25, none 0) and the drive / phase multipliers as for any other layer.
  const Y = (m.botPolicy || BOT_POLICY).battleLayerYield;
  const t = Y ? BATTLE_LAYER_YIELD[piece.id] : null;
  if (t) {
    if (m.round >= ((ps?.gd || m.gd).bossRound || 14)) return 0;
    let v = 0;
    for (const [id, a] of Object.entries(t)) v += layerValue(m, ps, id, a * (Y.scale ?? 1), bonds);
    return Math.min(Y.cap ?? 8, v);
  }
  const c = (ps?.gd || m.gd).chess(piece.id), enemies = (m.wave.spawns || []).reduce((n, s) => n + (s.count || 1), 0);
  let value = 0;
  for (const g of garrisons(m, piece.id)) {
    if (g.eventType !== 'IN_BATTLE') continue;
    const b = g.bb || {}, s = g.bbStr || {};
    if (s.conditionkey || s.bond_add_type !== 'by_count') continue;
    let events = 0;
    if (g.effectKey === 'act2autochess_gar_event_onstart') events = 1;
    if (g.effectKey === 'act1autochess_gar_event_useskill' && c?.skill && c.skill.spType === 'INCREASE_WITH_TIME') {
      events = Math.max(0, 1 - Math.max(0, c.skill.spCost - c.skill.initSp) / 90);
    }
    if (g.effectKey === 'act1autochess_gar_event_selfkillenemy' && !healer(c) && c?.attackKind !== 'none') events = Math.min(3, enemies / 12) / Math.max(1, b.check_cnt || 1);
    const amount = Math.min(b.max_add_count_per_battle ?? Infinity, events * (b.bond_add_count || 0));
    const ids = s.bond_type === 'bond_self' ? pieceBonds(m.gd, piece) : list(s.bond_id);
    for (const id of ids) if (bonds[id]?.active && ((ps?.gd || m.gd).bond(id)?.isCore || id === 'visiShip' || id === 'miraShip' || ((m.botPolicy || BOT_POLICY).battleAddonLayers && !(ps?.gd || m.gd).bond(id)?.noStack))) value += layerValue(m, ps, id, amount, bonds);
  }
  return Math.min(8, value);
}

/**
 * botPolicy.gainChurn: layers one more 获得 (a bought chess, even one sold again at once) adds this prep through the
 * owned "本回合每获得过1名干员" prep-end traits (小满, 夕, …: SERVER_ADD_BOND_METHOD round_gain_char), by layerValue.
 * A trait whose text needs its bond active counts only while it is. Hand pieces count unless the trait needs the board.
 */
export function gainCountValue(m, ps, bonds = ps.bonds) {
  let v = 0;
  const pieces = [...ps.board.values(), ...ps.hand].filter((p) => p && p.kind === 'chess');
  const onBoard = new Set([...ps.board.values()].filter(Boolean).map((p) => p.uid));
  for (const p of pieces) {
    for (const g of garrisons(m, p.id)) {
      if (g.eventType !== 'SERVER_PREP_FIN' || g.effectKey !== 'SERVER_ADD_BOND_METHOD' || g.bbStr?.add_method !== 'round_gain_char') continue;
      if (!onBoard.has(p.uid) && (g.bbStr?.conditionkey === 'character_target_inboard' || g.bbStr?.conditionkey === 'character_same_row')) continue;
      const multi = Number(g.bb?.multi) || 1;
      for (const id of list(g.bbStr.bond)) if (!requireActiveOf(g) || bonds[id]?.active) v += layerValue(m, ps, id, multi, bonds);
    }
  }
  return v;
}

export function recurringValue(m, ps, p, state = {}) {
  const now = traitValue(m, ps, p, ['SERVER_PREP_FIN'], state);
  const next = future(m) ? traitValue(m, ps, p, ['SERVER_PREP_START'], state) : 0;
  return (now + next + battleLayerValue(m, ps, p, state)) * (1 + Math.min(5, future(m)) * 0.16);
}

/** Combat estimates use the actual bond parameters and affected roster. A high-layer bond is useful only
 * when its damage dealers are deployed; an economy bond in the hand needs no extra board slots.
 * Uptime, survival and target counts are deliberately conservative estimates; rehearsal decides close cases.
 */
/** Expected engaged battle length in game seconds for the current round (2× field clock; waves grow longer). */
export function battleWindow(m) {
  const r = m.round || 1;
  return r <= 3 ? 55 : r <= 6 ? 75 : r <= 9 ? 120 : 150;
}

export function combatBondValue(m, set, bonds, ps = null) {
  const units = set.map((p) => ({ p, c: (ps?.gd || m.gd).chess(p.id), ids: pieceBonds(m.gd, p) })).filter((u) => u.c);
  const strength = (u) => (8 + u.c.tier * 2) * (u.c.isGolden ? 1.9 : 1);
  const sum = (arr) => arr.reduce((n, u) => n + strength(u), 0);
  const all = sum(units), ground = sum(units.filter((u) => blocker(u.c)));
  let v = 0;
  for (const [id, state] of Object.entries(bonds)) {
    if (!state.active) continue;
    const before = v;
    const rec = (ps?.gd || m.gd).bond(id), b = rec.buffs?.find((x) => x.bbStr?.key)?.bb || {};
    const members = units.filter((u) => u.ids.includes(id) || (rec.isCore && bonds.maniShip?.active && u.ids.includes('maniShip')));
    const own = sum(members), L = state.layers || 0;
    const upper = state.count >= (b.power_bond_char_cnt || Infinity);
    switch (id) {
      case 'yanShip': v += own * (b.base_atk + b.atk_per_stack * L) * 0.7 + (upper ? 28 : 0); break;
      case 'sargonShip': {
        const stacks = Math.min(b.max_buff_stack_cnt, members.length * (b.base_time + b.time_per_stack * L) / 30);
        v += own * stacks * (b.base_attack_speed / 100 + (upper && !(ps?.bandId && rec.buffs.some((x) => x.bbStr?.valid_in_band === ps.bandId)) ? b.base_atk || 0 : 0)) * 0.7; break;
      }
      case 'victoriaShip':
        for (const u of members) if (u.p.items?.length) v += strength(u) * (b.base_damage_scale - 1 + b.damage_scale_per_stack * L + (upper ? u.p.items.length * b.atk_normal_equip : 0)) * 0.7;
        break;
      case 'kjeragShip': {
        const cold = upper || members.some((u) => garrisons(m, u.p.id).some((g) => g.effectKey.includes('abflag')));
        v += own * (cold ? b.base_ex_damage_scale - 1 + b.ex_damage_scale_per_stack * L : b.base_damage_scale - 1) * 0.8; break;
      }
      case 'lateranoShip': v += own * Math.min(0.7, (b.base_ammo_percent + b.ammo_percent_per_stack * L) * 0.3) + (upper ? own * 0.8 : 0); break;
      case 'egirShip': v += own * (b.base_max_hp + b.max_hp_per_stack * L) * 0.25 + (upper ? 16 : 4); break;
      case 'siracusaShip': {
        // The ASPD buff starts at each deployment and lasts (base + per·L) game s; later waves fight much longer,
        // so a fixed 65 s window overrates it there (policy flag: battleWindowByRound).
        const win = (m.botPolicy || BOT_POLICY).battleWindowByRound ? battleWindow(m) : 65;
        v += own * (b.base_attack_speed + b.attack_speed_per_stack * L) / 100 * Math.min(1, (b.base_duration + b.duration_per_stack * L) / win) * 0.8 + (upper ? own * 0.5 : 0); break;
      }
      case 'kazimierzShip': v += own * Math.min(units.length * b.atk_when_born, b.base_max_atk_when_born + b.max_atk_when_born_per_stack * L) * 0.7 + (upper ? own * 0.6 : 0); break;
      case 'preciShip': {
        const affected = upper ? units.filter((u) => u.ids.includes(id) || positionClass(u.c) === 'ranged') : members;
        v += sum(affected) * (b.base_atk + b.atk_per_stack * L + (upper ? 0.2 : 0)) * 0.7; break;
      }
      case 'swiftShip': v += own * (Math.min(1, b.base_prob + b.prob_per_stack * L) * 0.2 + (L >= b.power_bond_stack_cnt ? 0.35 : 0)); break;
      case 'skillfulShip': v += ((ps && (m.botPolicy || BOT_POLICY).supportBondWeight?.skillfulShip) || 1) * Math.min(sum(units.filter(u=>u.c.attackKind!=='none')), own * 2) * (b.base_attack_speed + b.attack_speed_per_stack * L) / 100 * 0.6; break;
      case 'arcaneShip': v += ((ps && (m.botPolicy || BOT_POLICY).supportBondWeight?.arcaneShip) || 1) * (members.some(u=>u.c.dmgType==='arts'&&u.c.attackKind!=='none') ? sum(units.filter((u) => u.c.dmgType === 'arts')) : 0) * (b.base_damage_scale - 1 + b.damage_scale_per_stack * L) * (upper ? 1.2 : 0.85); break;
      case 'steadShip': v += ground * (b.base_max_hp + b.max_hp_per_stack * L) * 0.2 + (upper ? 20 + Math.min(20, L * 0.15) : 0); break;
      case 'deputShip': v += ground * (b.base_def + b.def_per_stack * L) * 0.25 + Object.values(bonds).filter((s) => s.active).length * (state.tier >= 2 ? 4 : 2); break;
      case 'raidShip': v += own * (b.base_atk + b.atk_per_stack * L) * 0.8 + (L >= b.power_bond_stack_cnt ? all * b.power_attack_speed / 100 * 0.6 : 0); break;
      case 'indomShip': v += ground * Math.min(1, b.base_prob + b.prob_per_stack * L) * 0.35 + (upper ? 6 : 0); break;
      case 'emptyShip': v += ground * b.damage_resistance * 0.5 + own * 0.15; break;
      case 'soloShip': v += own * (b.atk * 0.7 + b.max_hp * 0.2); break;
      case 'suntShip': v += sum(units.filter((u) => u.c.isGolden)) * (b.power_atk * 0.7 + (state.count >= b.ex_char_cnt ? 0.2 : 0)); break;
      default: break;
    }
    const importance = (m.botPolicy || BOT_POLICY).combatBondWeights?.[id];
    if (importance !== undefined) v = before + (v - before) * Math.max(0, Math.min(4, importance));
  }
  return v;
}

/** Static stats visible to the player, projected onto a lineup for route coverage. Percentage attributes add
 * before multiplication (the combat engine's directMods rule). Skill cycles/conditional procs stay in rehearsal.
 * This returns a new record and never changes the shared game data or a player's equipment.
 */
export function combatRecord(m, ps, piece, bonds = ps.bonds, rosterSize = ps.deployCount) {
  const c = (ps?.gd || m.gd).chess(piece.id);
  if (!c) return c;
  const ids = pieceBonds(m.gd, piece), st = c.stats || {};
  let atk = 0, hp = 0, def = 0, speed = 0, scale = 1, atkMul = 1, hpMul = 1;
  for (const [id, state] of Object.entries(bonds)) {
    if (!state.active) continue;
    const rec = (ps?.gd || m.gd).bond(id), b = rec?.buffs?.find((x) => x.bbStr?.key)?.bb || {};
    const own = ids.includes(id) || (rec?.isCore && bonds.maniShip?.active && ids.includes('maniShip'));
    const L = state.layers || 0, upper = state.count >= (b.power_bond_char_cnt || Infinity);
    if (own && id === 'yanShip') atk += b.base_atk + b.atk_per_stack * L;
    if (own && id === 'kazimierzShip') atk += Math.min(rosterSize * b.atk_when_born, b.base_max_atk_when_born + b.max_atk_when_born_per_stack * L);
    if (own && id === 'siracusaShip') speed += (b.base_attack_speed + b.attack_speed_per_stack * L) * Math.min(1, (b.base_duration + b.duration_per_stack * L) / 65);
    if (own && id === 'egirShip') hp += b.base_max_hp + b.max_hp_per_stack * L;
    if (id === 'preciShip' && (own || (upper && positionClass(c) === 'ranged'))) atk += b.base_atk + b.atk_per_stack * L;
    if (id === 'steadShip') hp += b.base_max_hp + b.max_hp_per_stack * L;
    if (id === 'deputShip') def += b.base_def + b.def_per_stack * L;
    if (own && id === 'soloShip') { atk += b.atk; hp += b.max_hp; }
    if (id === 'suntShip' && c.isGolden) atk += b.power_atk;
    if (own && id === 'raidShip') { atk += b.base_atk + b.atk_per_stack * L; hp += b.base_max_hp + b.max_hp_per_stack * L; }
    if (id === 'raidShip' && L >= b.power_bond_stack_cnt) speed += b.power_attack_speed;
    if (own && id === 'kjeragShip') scale *= upper ? b.base_ex_damage_scale + b.ex_damage_scale_per_stack * L : b.base_damage_scale;
    if (own && id === 'victoriaShip' && piece.items?.length) {
      scale *= b.base_damage_scale + b.damage_scale_per_stack * L;
      if (upper) atk += piece.items.reduce((n, it) => n + b.atk_normal_equip + ((ps?.gd || m.gd).item(it.id)?.isGolden ? b.atk_golden_equip : 0), 0);
    }
  }
  for (const g of garrisons(m, piece.id)) {
    const b = g.bb || {}, s = g.bbStr || {};
    if (g.effectKey === 'GAIN_BUFF') { atkMul *= b.atk || 1; hpMul *= b.max_hp || 1; }
    if (g.effectKey === 'act1autochess_gar_eff_attrByBond') {
      const stacks = Math.floor(list(s.bond_id).reduce((n, id) => n + (bonds[id]?.active ? bonds[id].layers || 0 : 0), 0) / Math.max(1, b.divide_num || 1));
      atk += (b.atk || 0) * stacks; hp += (b.max_hp || 0) * stacks; def += (b.def || 0) * stacks;
    }
  }
  for (const it of piece.items || []) for (const buff of (ps?.gd || m.gd).item(it.id)?.buffs || []) {
    const b = params(buff);
    if (b.key !== 'attr_common_global_buff') continue;
    atk += b.atk || 0; hp += b.max_hp || 0; def += b.def || 0; speed += b.attack_speed || 0;
  }
  return { ...c, botBonds: ids, botDamageScale: scale, stats: { ...st, atk: (st.atk || 0) * atkMul * (1 + atk),
    maxHp: (st.maxHp || 1) * hpMul * (1 + hp), def: (st.def || 0) * (1 + def), aspd: (st.aspd || 100) + speed } };
}

/** Near-term economy from an active bench-counted bond. Only unpaid money and unlatched
 * discounts are credited; an already permanent discount does not require keeping its members.
 * The score is bounded, and no hook, RNG draw or resource grant occurs during evaluation.
 */
export function economyBondValue(m, ps, id, bonds = ps.bonds) {
  const state = bonds[id], rec = (ps?.gd || m.gd).bond(id);
  if (!state?.active || !rec || (ps?.gd || m.gd).modeInactiveBonds.has(id)) return 0;
  const L = Math.min(BOND_LAYER_CAP, ps.layers[id] || 0), horizon = Math.min(4, future(m));
  const payout = rec.buffs?.find(b => b.key === 'bond_layer_gain_coin')?.bb;
  const paidKey = id === 'visiShip' ? 'bondaddon:visi:paid' : 'bondaddon:mira:paid';
  const owed = payout?.layer > 0 ? Math.max(0, Math.floor(L / payout.layer) - (ps.counters[paidKey] || 0)) * payout.count : 0;
  let value = owed * 2;
  if (id === 'visiShip') {
    // Growth is useful before the cap; the near-term option value is deliberately modest.
    if (L < BOND_LAYER_CAP) value += horizon * (0.8 + Math.min(1, L / 40));
    const b = rec.buffs.find(b => b.key === 'bond_multi_layer_char_goods_price_bond_discount')?.bb || {};
    const discount = L >= b.layer2 ? 2 : L >= b.layer1 ? 1 : 0;
    const latched = ps.counters['bondaddon:visi:disc'] || 0;
    if (discount > latched) value += (discount === 2 ? 5 : 2) * (1 + horizon);
  } else if (id === 'miraShip') {
    const b = rec.buffs.find(b => b.key === 'bond_refresh_shop_next_free')?.bb || {};
    const chance = Math.min(1, Math.max(0, (b.baseprob || 0) + (b.prob || 0) * L));
    const rolls = Math.min(4, ps.funds / Math.max(1, (ps?.gd || m.gd).refreshPrice)) + horizon * 2;
    value += Math.min(12, rolls * chance / Math.max(0.3, 1 - chance)) * (ps?.gd || m.gd).refreshPrice * 2;
  }
  return Math.min(40, value);
}

/** Marginal value of completing economy support in the hand; a duplicate never supplies a new member. */
export function economyRecruitValue(m, ps, id) {
  const probe = { uid: -2, id, kind: 'chess', items: [] };
  const own = pieceBonds(m.gd, probe);
  const ids = own.filter(id => id === 'visiShip' || id === 'miraShip');
  // botPolicy.investActivationValue: a recruit that activates 投资人 ("获得时" traits trigger twice; board + bench count)
  const inv = (m.botPolicy || BOT_POLICY).investActivationValue || 0;
  const wantInvest = inv > 0 && own.includes('investShip') && future(m) > 0;
  if ((!ids.length && !wantInvest) || !ps.hand.some(p => !p)) return 0;
  const bonds = computeBonds(m.gd, { board: ps.board, hand: ps.hand.concat(probe), layers: ps.layers, bondCountBonus: ps.bondCountBonus });
  let v = ids.reduce((n, id) => n + Math.max(0, economyBondValue(m, ps, id, bonds) - economyBondValue(m, ps, id)), 0);
  if (wantInvest) {
    const was = ps.bonds.investShip || {}, now = bonds.investShip || {};
    if (now.active && !was.active) v += inv;
    else if (!now.active && (now.count || 0) > (was.count || 0)) v += inv * 0.3;
  }
  return v;
}

/** Selling a bench engine or the last member of an active deck-counted bond is a real loss. */
export function benchValue(m, ps, p) {
  let v = recurringValue(m, ps, p, { bench: true });
  const without = computeBonds(m.gd, { board: new Map([...ps.board].filter(([, x]) => x.uid !== p.uid)), hand: ps.hand.filter((x) => x?.uid !== p.uid), layers: ps.layers, bondCountBonus: ps.bondCountBonus });
  for (const id of pieceBonds(m.gd, p)) {
    if ((ps?.gd || m.gd).bond(id)?.countMode !== 'BOARD_AND_DECK') continue;
    // Do not sell the first partner immediately before buying its visible, affordable complement.
    if ((id === 'visiShip' || id === 'miraShip') && !ps.bonds[id]?.active && (without[id]?.count || 0) < (ps.bonds[id]?.count || 0)) {
      const partners = ps.shop.slots.filter(s => s && !s.sold && s.kind === 'chess' && ps.priceOf(s) <= ps.funds
        && (ps?.gd || m.gd).chess(s.id)?.bonds?.includes(id)).map(s => economyRecruitValue(m, ps, s.id));
      v += Math.min(12, Math.max(0, ...partners));
    }
    v += id === 'visiShip' || id === 'miraShip'
      ? Math.max(0, economyBondValue(m, ps, id) - economyBondValue(m, ps, id, without))
      : Math.max(0, (ps.bonds[id]?.tier || 0) - (without[id]?.tier || 0)) * 16;
  }
  return v;
}

/** Only the NEXT refresh's marginal layers count, including caps and first-refresh triggers. */
export function refreshValue(m, ps) {
  let v = 0;
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) {
    if (p.kind !== 'chess') continue;
    const state = { bench: ps.hand.includes(p), refreshes: ps.round.refreshes || 0 };
    v += traitValue(m, ps, p, ['SERVER_PREP_FIN'], { ...state, refreshes: state.refreshes + 1 }) - traitValue(m, ps, p, ['SERVER_PREP_FIN'], state);
    v += traitValue(m, ps, p, ['SERVER_REFRESH_SHOP'], { ...state, refreshes: state.refreshes + 1 });
  }
  return v;
}

/** Role-aware equipment value. Signature bonuses and combo partners must actually be present. */
export function equipmentScore(m, ps, itemId, piece) {
  const rec = (ps?.gd || m.gd).item(itemId), c = (ps?.gd || m.gd).chess(piece.id);
  if (!rec || !c) return -Infinity;
  const bonds = pieceBonds(m.gd, piece);
  const hasBond = (id) => bonds.includes(id) || (bonds.includes('maniShip') && (ps?.gd || m.gd).bond(id)?.isCore && ps.bonds.maniShip?.active && ps.bonds[id]?.active);
  const keys = new Set((piece.items || []).map((it) => itemKey(it.id)));
  const attacking = !healer(c) && c.attackKind !== 'none';
  const tank = blocker(c) ? 1.5 : 0.35;
  const output = c.attackKind === 'none' ? 0.1 : Math.min(2.2, (c.stats?.atk || 300) / 450) * (c.isGolden ? 1.25 : 1);
  const speed = Math.min(2, 1.5 / Math.max(0.4, c.stats?.bat || 1.5));
  let score = 0;
  if (rec.kind === 'post_battle_transform') {
    // Transformation discards the operator and its elite status. Use expendable singles only.
    if (c.isGolden || (piece.items || []).length || ps.countCopies((ps?.gd || m.gd).baseIdOf(piece.id)) > 1) return -Infinity;
    return future(m) > 0 ? Math.max(0, 18 - c.tier * 3 - bonds.reduce((n, id) => n + (ps.bonds[id]?.active ? 2 : 0), 0)) : -Infinity;
  }
  if (rec.canGiveBond) {
    // botPolicy.morphPairing: 变形同构体 waits for its partner — with a partner (giveBondId item) in hand/temp it goes on
    // an empty-handed chess that lacks the partner's bond (the partner follows through the reciprocal +12 below)
    if ((m.botPolicy || BOT_POLICY).morphPairing && !(piece.items || []).length) {
      let bestGrant = 0;
      for (const h of [...ps.hand, ...ps.temp]) {
        const gid = h && h.kind === 'item' ? (ps?.gd || m.gd).item(h.id)?.giveBondId : null;
        if (gid && !bonds.includes(gid) && !(ps?.gd || m.gd).modeInactiveBonds.has(gid)) bestGrant = Math.max(bestGrant, morphGrantValue(m, ps, gid) + output * 4);
      }
      if (bestGrant > 0) return bestGrant;
    }
    for (const it of piece.items || []) {
      const id = (ps?.gd || m.gd).item(it.id)?.giveBondId;
      if (id && !bonds.includes(id) && !(ps?.gd || m.gd).modeInactiveBonds.has(id)) score += 8 + Math.min(12, (ps.layers[id] || 0) * 0.1);
    }
    return score;
  }
  if (hasBond('victoriaShip') && ps.bonds.victoriaShip?.active && !piece.items?.length && !rec.kind?.startsWith('consume') && rec.itemType === 'EQUIP') {
    const b = (ps?.gd || m.gd).bond('victoriaShip').buffs.find((x) => x.bbStr?.key)?.bb || {};
    if (attacking) score += (8 + c.tier * 2) * (b.base_damage_scale - 1 + b.damage_scale_per_stack * (ps.layers.victoriaShip || 0)) * 0.7;
  }
  if (rec.requiresBondId && hasBond(rec.requiresBondId)) score += 14;
  if (rec.giveBondId && !bonds.includes(rec.giveBondId) && (piece.items || []).some((it) => (ps?.gd || m.gd).item(it.id)?.canGiveBond) && !(ps?.gd || m.gd).modeInactiveBonds.has(rec.giveBondId)) score += (m.botPolicy || BOT_POLICY).morphPairing ? 12 + morphGrantValue(m, ps, rec.giveBondId) : 12;
  // morphPairing: a partner is worth buying while an unpaired 变形同构体 waits in hand (it then pairs on this chess)
  else if ((m.botPolicy || BOT_POLICY).morphPairing && rec.giveBondId && !bonds.includes(rec.giveBondId) && !(piece.items || []).length && !(ps?.gd || m.gd).modeInactiveBonds.has(rec.giveBondId)
    && [...ps.hand, ...ps.temp].some((h) => h && h.kind === 'item' && (ps?.gd || m.gd).item(h.id)?.canGiveBond)) score += morphGrantValue(m, ps, rec.giveBondId) * 0.8;
  if (rec.kind === 'passive_player') score += bonds.filter((id) => ps.bonds[id]?.active).length * 3;
  for (const buff of rec.buffs || []) {
    const p = params(buff), k = p.key || buff.key;
    if (buff.key === 'equip_round_start_upgrade_char' || buff.key === 'use_equip_upgrade_char') return c.isGolden ? -Infinity : 14 + c.tier * 3;
    if (buff.key === 'use_equip_reward_char_chess') return c.isGolden ? 5 + c.tier : 8 + c.tier + (ps.completesChessMerge(piece.id) ? 22 : 0);
    if (buff.key === 'use_equip_recruit_new_char_and_give_char_to_player_most_bond') return c.isGolden ? -Infinity : 18 - c.tier * 2 - (piece.items || []).length * 6;
    if (buff.key === 'use_equip_reward_char_chess_bond_layer') { score += bonds.reduce((n, id) => n + layerValue(m, ps, id, p.layer), 0) * 3; continue; }
    if (buff.key === 'equip_destory_gain_random_coin') { score += ((p.min || 0) + (p.max || 0)) * 1.5; continue; }
    if (buff.key === 'gain_coin_when_round_start') { score += (p.count || 1) * Math.min(6, future(m)) * 2; continue; }
    if (buff.key === 'use_equip_gain_coin_when_next_round_start') { score += future(m) ? (p.count || 0) * 2 : 0; continue; }
    if (buff.key === 'equip_destory_deployment_cnt_change') { score += ps.deployCap < p.count ? 30 : 0; continue; }
    if (rec.kind?.startsWith('consume_on_equip')) {
      score += 6 + bonds.filter((id) => ps.bonds[id]?.active).length * 2; continue;
    }
    if (k === 'attr_common_global_buff' || k === 'act1autochess_equip_acarm050_global_buff' || k === 'act1autochess_equip_acarm056_global_buff' || k === 'magic_penetrate_global_buff') {
      score += (p.atk || 0) * output * 25 + (p.attack_speed || 0) * output * 0.2;
      score += ((p.def || 0) * 16 + (p.max_hp || 0) * 14 + (p.magic_resistance || 0) * 0.16) * tank;
      score += (p.magic_resist_penetrate || 0) * (c.dmgType === 'arts' ? 30 : 0);
      score += (p.sp_recovery_per_sec || 0) * 20 - (p.respawn_time || 0) * 5;
    } else if (k === 'periodic_damage') score -= (p.damage || 0) / Math.max(1, c.stats?.maxHp || 1000) * 70;
    else if (rec.category === 'SURVIVAL') score += 7 * tank;
    else if (rec.category === 'ON_HIT') score += attacking ? 6 * speed : 0;
    else if (rec.category === 'SP') score += c.attackKind !== 'none' ? 6 : 1;
    else if (rec.category === 'STAT') score += 3 * (p.init_max_hp ? tank : output);
    const partners = list(p.equip_chess_id || p.other_equip);
    if (partners.some((id) => keys.has(itemKey(id))) && (!rec.requiresBondId || hasBond(rec.requiresBondId))) score += 12;
  }
  // Score the reciprocal pairing too (the signature may already be equipped).
  for (const it of piece.items || []) {
    const other = (ps?.gd || m.gd).item(it.id);
    if (!other || (other.requiresBondId && !hasBond(other.requiresBondId))) continue;
    if ((other.buffs || []).some((b) => list(b.bbStr?.equip_chess_id || b.bbStr?.other_equip).some((id) => itemKey(id) === itemKey(itemId)))) score += 12;
  }
  return score;
}

/** Value of one extra member for `bondId` (变形同构体 pairing): next threshold reached, layers already banked, core bonds. */
export function morphGrantValue(m, ps, bondId) {
  const b = (ps?.gd || m.gd).bond(bondId);
  if (!b) return 0;
  const cur = ps.bonds[bondId]?.count || 0;
  const th = b.thresholds || [3];
  let v = 6 + Math.min(12, (ps.layers?.[bondId] || 0) * 0.1);
  if (th.some((n) => cur < n && cur + 1 >= n)) v += 18;
  else if (th.some((n) => cur + 2 >= n && cur < n)) v += 6;
  if (ps.bonds[bondId]?.active) v += 6;
  if (b.isCore) v += 4;
  return v;
}

/** Greedy marginal allocation, including worthwhile replacement instead of destroying a random old item. */
export function bestEquipmentTarget(m, ps, id, candidates = [...ps.board.values()].filter((p) => p.kind === 'chess')) {
  const rec = (ps?.gd || m.gd).item(id);
  if (!rec || rec.itemType !== 'EQUIP') return null;
  const consume = rec.kind?.startsWith('consume_on_equip');
  let best = null;
  for (const p of candidates) {
    const items = p.items || [];
    // (upstream rule kept: a bot never destroys a 突变细胞 — it returns after every transformation — so it is never replaced)
    const options = consume || items.length < (ps?.gd || m.gd).equipPerChess ? [null]
      : items.filter((it) => (ps?.gd || m.gd).item(it.id)?.buffs?.[0]?.key !== 'char_chess_transformation_equip');
    for (const old of options) {
      const trial = old ? { ...p, items: items.filter((it) => it.uid !== old.uid) } : p;
      const gain = equipmentScore(m, ps, id, trial) - (old ? equipmentScore(m, ps, old.id, trial) + 3 : 0);
      if (gain > 0 && (!best || gain > best.score)) best = { piece: p, score: gain, replaceUid: old?.uid ?? null };
    }
  }
  return best;
}
