#!/usr/bin/env node
// Research runner: 3 real AI seats + a fixed late-game human proxy. All actions use game rules.
// --root PATH --human-root PATH --difficulty HARD|ABYSS --seed N --seeds N
// Pin --human-root to the baseline checkout for paired comparisons; no grants or stat overrides.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const opt = {};
for (let i = 2; i < process.argv.length; i += 2) opt[process.argv[i].slice(2)] = process.argv[i + 1];
const root = path.resolve(opt.root || fileURLToPath(new URL('../..', import.meta.url)));
const humanRoot = path.resolve(opt['human-root'] || root);
const get = (root, f) => import(pathToFileURL(path.join(root, f)));
const { Match } = await get(root, 'server/match/Match.js');
const { VirtualScheduler } = await get(root, 'server/match/scheduler.js');
const { attachAudit } = await get(root, 'server/match/audit.js');
const { getData } = await get(root, 'server/data.js');
const humanBot = await get(humanRoot, 'server/match/bot.js');
const data = getData({ log: { info() {}, warn() {}, error() {} } });
const difficulty = opt.difficulty || 'HARD';
const counted = (r) => (r?.leaked || []).filter(l => l.counted !== false).length;

function lateBand(m, ps) {
  // Equipment sharing / skill cycling first; fall back to a reachable equipment or summon core.
  const candidates = [['band_narant', 'sargonShip'], ['band_pepe', 'sargonShip'],
    ['band_harold', 'victoriaShip'], ['band_duyaoy', 'yanShip'], ['band_sciurus', 'kjeragShip']];
  for (const [band, core] of candidates) {
    const members = [...m.pool.entries].filter(([id, e]) => e.left > 0 && m.gd.chess(id)?.bonds?.includes(core));
    if (!m.bandTaken(band, ps.playerId) && !m.gd.modeInactiveBonds.has(core)
      && members.length >= m.gd.bond(core).thresholds[1]) return band;
  }
  return humanBot.botPickBand(m, ps);
}

function run(seed) {
  const scheduler = new VirtualScheduler(), errors = [], rounds = [];
  let summary;
  const seats = Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: seat ? `ai_${seat}` : 'human',
    name: seat ? `AI ${seat}` : 'Late-game human proxy', isBot: seat !== 0, connected: true }));
  const m = new Match({ mode: 'coop', difficulty, seed, seats, data, scheduler, botRehearsal: 3,
    aiOperatorBuff: false, humanOperatorBuff: false, aiRound34Nerf: false,
    log: { info() {}, warn() {}, error: (...x) => errors.push(x.join(' ')) },
    send: () => true, broadcast() {}, onEnd: s => { summary = s; } });
  m.players.get('human').autoplay = true;
  const band = m.scheduleBandBot.bind(m), prep = m.scheduleBotPrep.bind(m), card = m.scheduleSpBot.bind(m);
  m.scheduleBandBot = () => {
    const ps = m.players.get(m.draftTurn());
    if (ps?.isBot) return band();
    m.later(0, () => { if (m.phase === 'BAND_DRAFT' && m.draftTurn() === ps.playerId) m._applyBand(ps, lateBand(m, ps), { dedupe: true }); });
  };
  m.scheduleSpBot = () => {
    const ps = m.players.get(m.spTurn());
    if (ps?.isBot) return card();
    m.later(0, () => {
      if (m.phase !== 'SP_DRAFT' || m.spTurn() !== ps.playerId) return;
      const available = m.sp.cards.map(c => c.idx).filter(i => m.sp.taken[i] == null);
      if (available.length) m._applyCard(ps, humanBot.botPickCard(m, ps, m.sp.cards, available));
    });
  };
  m.scheduleBotPrep = (ps, i) => {
    if (ps.isBot) return prep(ps, i);
    const round = m.round;
    m.later(0, () => {
      if (m.phase !== 'PREP' || m.round !== round || !ps.alive || ps.ready) return;
      // A fixed greedy investment curve: six owned units, then earlier access to late-game carries.
      const target = Math.min(6, Math.max(1, Math.floor((round + 1) / 2)));
      while (ps.shop.level < target && ps.allChess().length >= 6 && ps.funds >= ps.shop.upgradePrice + 5) {
        if (!ps.levelUp().ok) break;
      }
      humanBot.botPrep(m, ps);
    });
  };
  const settle = m.settle.bind(m);
  m.settle = (plan, result) => {
    const before = m.order.map(ps => ({ ps, lost: ps.stats.lpLost, alive: ps.alive, r: m.lastResults.get(ps.playerId) }));
    settle(plan, result);
    const allAiHelpers = !!plan?.helpers.length && plan.helpers.every(p => p.isBot);
    rounds.push({ round: m.round, helpers: plan?.helpers.map(p => p.playerId) || [],
      allAiHelpers, players: Object.fromEntries(before.map(({ ps, lost, alive, r }) => [ps.playerId, {
        aliveBefore: alive, alive: ps.alive, lp: ps.lp, leaks: counted(r),
        perfect: alive && !!r && counted(r) === 0 && r.perfect !== false,
        lpLoss: ps.stats.lpLost - lost,
        savedLp: alive ? Math.max(0, Math.min(m.gd.lpCapPerRound, counted(r)) - (ps.stats.lpLost - lost)) : 0,
        band: ps.bandId, core: ps._botCore?.id, role: ps._botRelayRole, level: ps.shop.level,
        standing: (r?.unitsEnd || []).filter(u => u.alive).length,
        layers: { ...ps.layers }, bonds: Object.entries(ps.bonds).filter(([, b]) => b.active).map(([id, b]) => `${id}:${b.count}`),
      }])) });
  };
  const audit = attachAudit(m, { invariants: true });
  const t0 = Date.now();
  m.start();
  scheduler.runUntil(() => !!summary, { maxSteps: 5e6 });
  if (!summary) errors.push(`stuck ${m.phase} ${m.round}`);
  const result = { seed, difficulty, ms: Date.now() - t0, victory: summary?.victory,
    roundsPassed: summary?.roundsPassed, reason: summary?.reason, summary, rounds,
    errors, matchErrors: m.errorCount, simErrors: m.simErrorLog.size, metaErrors: m.dispatcher.errors,
    schedulerErrors: scheduler.errors, violations: audit.violations };
  m.dispose();
  return result;
}
const results = [];
for (let i = 0; i < Number(opt.seeds || 1); i++) {
  const r = run(Number(opt.seed || 1) + i);
  results.push(r);
  console.error(`${difficulty} ${r.seed}: ${r.victory ? 'win' : r.roundsPassed} (${r.ms} ms)`);
}
console.log(JSON.stringify(results));
if (results.some(r => r.errors.length || r.matchErrors || r.simErrors || r.metaErrors || r.schedulerErrors.length || r.violations.length)) process.exitCode = 1;
