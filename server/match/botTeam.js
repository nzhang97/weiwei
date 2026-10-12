import { BOT_POLICY } from './botPolicy.js';
// Cooperative phase coverage for three real AI teammates and a human seat.
// Uses public strategy picks, shared AI intents and completed battles, never human hands/shops or future RNG.
import { GEO } from '../../shared/constants.js';
import { deriveSeed } from '../sim/rng.js';
import { buildUniteWave } from './waves.js';
const ROLES = ['opening', 'bridge', 'anchor'];
const BAND_FIT = {
  opening: { band_amedic: 20, band_mlyss: 12, band_pith: 10, band_ermengard: 6, band_mlynar: 6 },
  bridge: { band_orchid: 20, band_sciurus: 12, band_duyaoy: 10, band_pepe: 10, band_lmlee: 12 },
  anchor: { band_bldsk: 20, band_narant: 14, band_harold: 12, band_ioleta: 12, band_paganini: 10 },
};
const CORE_FIT = {
  opening: { kazimierzShip: 12, siracusaShip: 10, kjeragShip: 8, sargonShip: 4 },
  bridge: { yanShip: 12, kjeragShip: 10, sargonShip: 8, kazimierzShip: 6 },
  anchor: { victoriaShip: 12, sargonShip: 12, yanShip: 8, lateranoShip: 6 },
};

/**
 * Teammates who do not play (白板 / AFK): a human seat, alive, with no operator on its board from round 2 on. Their
 * boards are public (prep scouting). botPolicy.blankProtect turns every AI into a relay helper while one exists.
 */
export function idleTeammates(m) {
  if (m.round < 2) return [];
  return m.order.filter((p) => !p.isBot && p.alive && !p.left && ![...p.board.values()].some((x) => x.kind === 'chess'));
}
function blankMode(m) { return !!(m.botPolicy || BOT_POLICY).blankProtect && idleTeammates(m).length > 0; }

export function relayRole(m, ps) {
  if (!ps.isBot || m.isSolo || !['HARD', 'ABYSS'].includes(m.difficulty)) return null;
  const bots = m.order.filter(p => p.isBot).sort((a, b) => a.seat - b.seat);
  const fourAi = bots.length === 4 && m.order.every(p => p.isBot) && (m.botPolicy || BOT_POLICY).fourAiRelay === true;
  if (!fourAi && (bots.length !== 3 || !m.order.some(p => !p.isBot))) return null;
  const roles = fourAi ? ['opening', 'bridge', 'anchor', 'anchor'] : ROLES;
  // Wait until the draft is complete. Assign each role once to the strategy that can actually
  // support it; preserving the plan after deaths avoids making several bots change course together.
  if (!m._botRelayRoles && bots.every(p => p.bandId)) {
    const permutations = fourAi
      ? [0,1,2,3].flatMap(a => [0,1,2,3].filter(b => b !== a).flatMap(b => [0,1,2,3].filter(c => c !== a && c !== b).map(c => [a,b,c,[0,1,2,3].find(d => d !== a && d !== b && d !== c)])))
      : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let best = permutations[0], score = -Infinity;
    for (const order of permutations) {
      const fit = order.reduce((n, index, role) => n + (BAND_FIT[roles[role]][bots[index].bandId] || 0), 0);
      if (fit > score) { score = fit; best = order; }
    }
    m._botRelayRoles = new Map(best.map((index, role) => [bots[index].playerId, roles[role]]));
  }
  const role = m._botRelayRoles?.get(ps.playerId) || roles[bots.indexOf(ps)];
  ps._botRelayRole = role;
  return role || null;
}

export function relayDuty(m, ps) {
  const role = relayRole(m, ps);
  if (!role || m.round >= (ps?.gd || m.gd).bossRound) return false;
  if (blankMode(m)) return true;
  const phase = m.round <= 4 ? 'opening' : m.round <= 8 ? 'bridge' : 'anchor';
  if (role === phase) return true;
  if (m.round < 2) return false;
  // A past perfect is evidence, not a promise. Never assume that the human will cover an AI.
  return !m.order.some(p => p !== ps && p.isBot && p.alive && !p.left && (() => {
    const r = m.lastResults.get(p.playerId);
    const units = r?.unitsEnd || [];
    const standing = units.filter(u => u.alive);
    return r && r.perfect !== false && !(r.leaked || []).some(l => l.counted !== false)
      && standing.length >= Math.max(1, Math.ceil(units.length / 2))
      && standing.reduce((n, u) => n + Math.max(0, Math.min(1, u.hpPct || 0)), 0) / units.length >= 0.35;
  })());
}

export function relayBandValue(m, ps, id, targets, bondTargets) {
  const role = relayRole(m, ps);
  if (!role) return 0;
  // Preserve the existing opening strategy quality; complementary core commitments break ties.
  let value = 0;
  for (const core of targets.filter(b => (ps?.gd || m.gd).bond(b)?.isCore)) {
    if (m.order.some(p => p !== ps && bondTargets(m, p.bandId).includes(core))) value -= 5;
  }
  return value;
}

export function relayCoreValue(m, ps, id, count, first, bondTargets) {
  const role = relayRole(m, ps);
  if (!role) return 0;
  let value = CORE_FIT[role][id] || 0;
  // Do not tear down an established core merely to diversify.
  if (count < first && (ps.layers[id] || 0) < 20 && m.order.some(p => p !== ps &&
    (bondTargets(m, p.bandId).includes(id) || (p.isBot && p._botCore?.id === id)))) value -= 16;
  return value * 0.25;
}

export function relayCarryValue(m, ps, result) {
  if (!relayDuty(m, ps) || result.perfect === false || (result.leaked || []).some(l => l.counted !== false)) return 0;
  const units = result.unitsEnd || [];
  if (!units.length) return 0;
  return units.reduce((n, u) => n + (u.alive ? 2 + 2 * Math.max(0, Math.min(1, u.hpPct || 0)) : 0), 0) / units.length;
}

/** Growth windows only advance under demonstrated AI cover, leaving recruitment money. */
export function relayUpgradeWanted(m, ps, price) {
  const role = relayRole(m, ps);
  if (!role || relayDuty(m, ps) || ps.allChess().length < 6 || ps.funds < price + 4) return false;
  const target = role === 'bridge' && m.round >= 4 && m.round <= 6 ? (m.round < 6 ? 3 : 4)
    : role === 'anchor' && m.round >= 7 && m.round <= 9 ? (m.round < 9 ? 4 : 5) : 0;
  return ps.shop.level < target;
}


/** A bounded stress test, not a forecast of teammates' hidden outcomes. Sample at most twelve
 * announced enemies across distinct types and use the real single-helper escape routes.
 * Operator HP/SP/down/active-skill state carries over; combat layers and rewards do not.
 */
export function createRelayRehearsal(m, ps, input, result) {
  if (!relayDuty(m, ps) || !m.wave || result.perfect === false || (result.leaked || []).some(l => l.counted !== false)) return null;
  const types = new Map();
  for (const sp of m.wave.spawns || []) {
    if (sp.countInTotal === false || !(ps?.gd || m.gd).enemy(sp.enemyKey)) continue;
    const key = `${sp.enemyKey}|${JSON.stringify(sp.mods || {})}`;
    const entry = types.get(key) || { sp, count: 0 };
    entry.count += sp.count || 1;
    types.set(key, entry);
  }
  // an idle teammate leaks its whole wave: test this helper's share of it (2 helpers when 2+ AIs are alive)
  let cap = 12;
  if (blankMode(m)) {
    const total = [...types.values()].reduce((n, e) => n + e.count, 0) * idleTeammates(m).length;
    const helpers = Math.max(1, Math.min(2, m.order.filter((p) => p.isBot && p.alive && !p.left).length));
    cap = Math.max(12, Math.min((m.botPolicy || BOT_POLICY).blankSampleCap ?? 30, Math.ceil(total / helpers)));
  }
  const sample = [];
  for (let pass = 0; sample.length < cap && pass < 60; pass++) {
    let added = false;
    for (const { sp, count } of types.values()) {
      if (pass >= count * Math.max(1, idleTeammates(m).length) || sample.length >= cap) continue;
      sample.push({ enemyKey: sp.enemyKey, mods: sp.mods ? { ...sp.mods } : null, sourcePlayerId: 'relay-preview' });
      added = true;
    }
    if (!added) break;
  }
  if (!sample.length) return null;
  const wave = buildUniteWave(m.gd, sample, 1, m.wave.timeLimit);
  if (!wave.spawns.length) return null;
  const carry = new Map((result.unitsEnd || []).map(u => [u.uid, u.alive
    ? { hpPct: Math.max(0.01, Math.min(1, u.hpPct ?? 1)), sp: u.sp || 0, skillActive: !!u.skillActive }
    : { down: true }]));
  const player = structuredClone(input);
  if (player.contentInfo) player.contentInfo.kind = 'unite';
  for (const u of player.units) if (u.kind === 'chess' && carry.has(u.uid)) u.carryState = carry.get(u.uid);
  const battle = m.newBattle({ seed: deriveSeed(m.seed, `relay:${m.round}:${ps.seat}`), kind: 'unite',
    modeId: m.modeId, round: m.round, stageId: m.stageId, rect: { ...GEO.UNITE_RECT },
    timeLimit: m.wave.timeLimit, players: [player], spawns: wave.spawns, routes: wave.routes,
    sharedBoss: null, flags: { layerGainsEnabled: false, ...(ps?.gd || m.gd).dp },
    fieldId: `relay:${ps.playerId}`, enemyOverrides: m.wave.overrides, waveId: wave.templateId });
  return { battle, count: sample.length };
}

export function relayDefenseValue(result, count, m = null) {
  if (!result || result.synthetic || !count) return 0;
  const missed = Object.values(result.perPlayer || {}).reduce((n, p) =>
    n + (p.leaked || []).filter(l => l.counted !== false).length, 0) + (result.unspawned || []).length;
  const w = m && blankMode(m) ? ((m.botPolicy || BOT_POLICY).blankDefenseWeight ?? 6) : 6;
  return w * Math.max(0, 1 - missed / count);
}
