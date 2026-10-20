import { BOT_POLICY } from './botPolicy.js';
// Isolated final-assault planning. The opponent wave is already announced.
// Partner estimates use public deployed pieces, default loadouts and visible effects;
// no other player's hand, shop, funds or future RNG is inspected.
import { GEO } from '../../../shared/constants.js';
import { resolveLoadout } from '../../../shared/protocol.js';
import { deriveSeed } from '../../sim/rng.js';
import { parseKey, pieceDir } from '../board.js';
import { bossPoolHp, SharedBossPool } from '../finalAssault.js';
import { lineupState } from './botStrategy.js';
import { withBounties } from '../waves.js';
import { makeCtx } from '../effectsMeta.js';

export function publicBossInput(m, ps, side, teamLp) {
  const units = [];
  for (const [key, p] of ps.board) {
    const [row, col] = parseKey(key);
    if (p.kind === 'chess') {
      const c = (ps?.gd || m.gd).chess(p.id), lo = resolveLoadout({}, c, id => (ps?.gd || m.gd).chess(id));
      units.push({ uid: p.uid, kind: 'chess', chessId: p.id, row, col, dir: pieceDir(p),
        items: (p.items || []).map(i => i.id), skillIndex: lo.skillIndex, moduleId: lo.moduleId });
    } else if (p.kind === 'token') {
      units.push({ uid: p.uid, kind: 'token', tokenId: p.id, row, col, dir: pieceDir(p), ownerUid: p.ownerUid });
    }
  }
  return { playerId: ps.playerId, seat: ps.seat, side, colOffset: side === 'R' ? 8 : 0,
    units, bonds: structuredClone(ps.bonds), bandId: ps.bandId, lpForBoss: teamLp,
    playerEffects: structuredClone((ps.effects || []).filter(e => e.battle !== false && !e.hidden)),
    deviceOverrides: { ...ps.deviceOverrides },
    contentInfo: { round: m.round, kind: 'boss', handUnits: 0, handChess: 0, funds: 0,
      roundStats: {}, matchBands: m.order.filter(p => p.alive && !p.left).map(p => p.bandId).filter(Boolean),
      teammates: m.order.filter(p => p !== ps && p.alive && !p.left).map(p => ({ playerId: p.playerId, bandId: p.bandId })) } };
}

export function bossPlanValue(pool, lp, initialLp, seconds, lossWeight = 30) {
  if (pool.hp <= 0) return 10000 + Math.max(0, lp) - seconds * 0.01;
  return 100 * (1 - pool.hp / pool.maxHp)
    - Math.max(0, Math.min(100, lossWeight)) * (1 - Math.max(0, lp) / Math.max(1, initialLp));
}

export function* createBossRehearsalSteps(m, ps, chosen, plans) {
  const group = m.bossGroupOf?.(ps);
  if (!group || plans.length < 2 || !(m.botRehearsal > 0)) return null;
  const limit = Math.max(2, Math.min(8, Math.floor((m.botPolicy || BOT_POLICY).bossRehearsalPlans || 0)));
  // Keep both roster and geometry alternatives when the budget cannot fit every plan.
  const geometryCount = plans.length > limit && limit >= 4 ? Math.floor((limit - 1) / 2) : 0;
  const cands = geometryCount ? plans.slice(0, limit - geometryCount).concat(plans.slice(-geometryCount)) : plans.slice(0, limit);
  const own = new Map(ps.allChess().concat(chosen).map(p => [p.uid, p]));
  const initialLp = m.order.filter(p => p.alive && !p.left).reduce((n, p) => n + Math.max(0, p.lp), 0);
  const bossId = m.round === (ps?.gd || m.gd).hiddenRound ? m.hiddenBossId : m.bossId;
  const hidden = m.round === (ps?.gd || m.gd).hiddenRound;
  const seconds = Math.max(60, Math.min(240, (m.botPolicy || BOT_POLICY).bossRehearsalSeconds || 180));
  const partners = group.players.filter(id => id !== ps.playerId).map(id => m.players.get(id)).filter(Boolean);
  const partnerInputs = partners.map(p => publicBossInput(m, p, group.players.indexOf(p.playerId) === 1 ? 'R' : 'L', initialLp));
  const wave = group.wave;
  const spawns = withBounties(m.gd, m.round, wave, ps.bounties, ps.playerId, { side: group.side }).map(s => structuredClone(s));
  for (const p of partners) {
    const side = group.players.indexOf(p.playerId) === 1 ? 'R' : 'L';
    spawns.push(...withBounties(m.gd, m.round, wave, p.bounties, p.playerId, { side }).slice(wave.spawns.length).map(s => structuredClone(s)));
  }
  const candidates = [];
  for (const plan of cands) {
    const saved = [...ps.board], hand = ps.hand.slice(), temp = ps.temp.slice();
    const dirs = new Map([...own.values(), ...saved.map(([, p]) => p)].map(p => [p, Object.hasOwn(p, 'dir') ? { value: p.dir } : null]));
    try {
      ps.board.clear();
      for (const [uid, key] of plan) {
        const p = own.get(uid);
        if (p) { p.dir = typeof plan.dirOf === 'function' ? plan.dirOf(uid) : 'RIGHT'; ps.board.set(key, p); }
      }
      const state = lineupState(m, { ...ps, board: new Map(saved), hand, temp }, [...ps.board.values()]);
      ps.hand.splice(0, ps.hand.length, ...state.hand, ...Array(Math.max(0, hand.length - state.hand.length)).fill(null));
      ps.temp.splice(0, ps.temp.length, ...temp.map(p => p && plan.has(p.uid) ? null : p));
      for (const [key, p] of saved) if (p.kind === 'token' && plan.has(p.ownerUid) && !ps.board.has(key)) ps.board.set(key, p);
      ps.recompute();
      const input = ps.battleInput({ side: group.side, colOffset: group.side === 'R' ? 8 : 0 });
      input.lpForBoss = initialLp;
      m.registry.get('global:contentb_info')?.onBattleStart(makeCtx(m, ps, {}, 'onBattleStart'), { input, kind: hidden ? 'hidden' : 'boss' });
      const pool = new SharedBossPool(bossPoolHp(m.gd, bossId, m.order.filter(p => p.alive && !p.left).length));
      const candidate = { plan, pool, lp: initialLp, battle: null, ticks: 0 };
      const inputs = [input, ...structuredClone(partnerInputs)].sort((a, b) => a.seat - b.seat);
      candidate.battle = m.newBattle({ seed: deriveSeed(m.seed, `boss-rehearse:${m.round}:${ps.seat}`),
        kind: hidden ? 'hidden' : 'boss', modeId: m.modeId, round: m.round, stageId: m.stageId,
        rect: { ...GEO.BOSS_RECT }, timeLimit: Infinity, players: inputs,
        spawns: m._sanitizeSpawns(structuredClone(spawns)), routes: wave.routes, sharedBoss: pool,
        flags: { layerGainsEnabled: false, ...(ps?.gd || m.gd).dp }, fieldId: `boss-rehearse:${ps.playerId}`,
        enemyOverrides: wave.overrides, waveId: wave.templateId, bossId });
      candidate.battle.on('enemyLeak', ev => { const e = ev?.enemy; if (e) candidate.lp -= Number.isFinite(e.lpr) && e.lpr >= 0 ? e.lpr : 1; }, { owner: 'bot-preview', priority: -1000 });
      candidate.battle.on('lpLoss', ev => { if (Number.isFinite(ev?.amount) && ev.amount > 0) candidate.lp -= ev.amount; }, { owner: 'bot-preview', priority: -1000 });
      candidates.push(candidate);
    } catch (e) {
      m.log.warn?.(`[match ${m.roomCode}] boss rehearsal failed: ${e?.message || e}`);
    } finally {
      ps.board.clear();
      for (const [p, dir] of dirs) { if (dir) p.dir = dir.value; else delete p.dir; }
      for (const [key, p] of saved) ps.board.set(key, p);
      ps.hand.splice(0, ps.hand.length, ...hand); ps.temp.splice(0, ps.temp.length, ...temp); ps.recompute();
    }
    yield;
  }
  let index = 0, best = -Infinity;
  const job = { chosen, plans: cands, best: cands[0], done: false,
    run(budgetMs = Infinity) {
      const start = performance.now(); let stepped = 0;
      while (index < candidates.length) { // loop-cap: the boss candidate list
        const c = candidates[index], b = c.battle;
        if (stepped > 0 && performance.now() - start >= budgetMs) return false;
        try {
          while (!b.finished && c.ticks < Math.ceil(seconds * 30) && c.lp > 0) { // loop-cap: ceil(seconds*30) ticks of the boss fight
            b.step(); c.ticks++; stepped++;
            if ((stepped & 3) === 0 && performance.now() - start >= budgetMs) return false;
          }
          if (!b.finished) b.forceEnd(c.lp <= 0 ? 'preview-team-lp' : 'preview-budget');
          const score = bossPlanValue(c.pool, c.lp, initialLp, b.time || c.ticks / 30, (m.botPolicy || BOT_POLICY).bossRehearsalLossWeight ?? 30) - index * 0.0001;
          if (score > best) { best = score; job.best = c.plan; job.chosen = [...c.plan.keys()].map(uid => own.get(uid)).filter(Boolean); }
        } catch (e) { m.log.warn?.(`[match ${m.roomCode}] boss rehearsal failed: ${e?.message || e}`); }
        c.battle = null; index++;
      }
      job.done = true; return true;
    } };
  return job;
}
