import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, legalTileFor } from '../match/harness.js';
import { createRehearsal } from '../../server/match/bot.js';
import { relayRole, relayDuty, relayCarryValue, relayBandValue, relayCoreValue,
  relayUpgradeWanted, createRelayRehearsal, relayDefenseValue } from '../../server/match/ai/botTeam.js';
import { bandBonds } from '../../server/match/ai/botStrategy.js';

function setup(t, opts = {}) {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 3, seed: 41, fake: true, ...opts });
  t.after(() => h.m.dispose());
  return h.m;
}
const perfect = { perfect: true, leaked: [], unitsEnd: [{ alive: true, hpPct: 1 }] };

test('three real bots have stable distinct phases; autoplay humans and other room shapes are unchanged', t => {
  const m = setup(t), bots = m.order.filter(p => p.isBot), human = m.order.find(p => !p.isBot);
  assert.deepEqual(bots.map(p => relayRole(m, p)), ['opening', 'bridge', 'anchor']);
  human.autoplay = true;
  assert.equal(relayRole(m, human), null);
  m.order.reverse();
  bots[0].alive = false;
  assert.equal(relayRole(m, bots[1]), 'bridge');
  m.difficulty = 'NORMAL';
  assert.equal(relayRole(m, bots[1]), null);
  const four = setup(t, { humans: 0, bots: 4 });
  assert.ok(four.order.every(p => relayRole(four, p) === null));
});

test('roles follow actual drafted strategy timing, then stay stable when a teammate dies', t => {
  const m = setup(t), [a, b, c] = m.order.filter(p => p.isBot);
  a.bandId = 'band_bldsk'; b.bandId = 'band_amedic'; c.bandId = 'band_orchid';
  assert.deepEqual([a, b, c].map(p => relayRole(m, p)), ['anchor', 'opening', 'bridge']);
  b.alive = false;
  m.order.reverse();
  assert.equal(relayRole(m, a), 'anchor');
  assert.equal(relayRole(m, c), 'bridge');
});

test('advance investment requires AI coverage and recruitment reserves without blocking the normal upgrade curve', t => {
  const m = setup(t), [a, b] = m.order.filter(p => p.isBot);
  m.round = 4;
  b.allChess = () => Array(6).fill({});
  b.shop.level = 2;
  b.funds = 9;
  assert.equal(relayUpgradeWanted(m, b, 5), false);
  m.lastResults.set(a.playerId, perfect);
  assert.equal(relayUpgradeWanted(m, b, 5), true);
  b.funds = 8;
  assert.equal(relayUpgradeWanted(m, b, 5), false);
  m.round = 5;
  assert.equal(relayUpgradeWanted(m, b, 5), false, 'the phase owner does not take an extra growth jump');
});

test('relay trial uses bounded preview samples and the real escape template with exact carry state', t => {
  const m = setup(t), bot = m.order.find(p => p.isBot);
  m.round = 3;
  const enemyKey = Object.keys(m.gd.raw.enemies).find(key => m.gd.enemy(key));
  m.wave = { spawns: [{ enemyKey, count: 100, mods: { hpMul: 2 } }], timeLimit: 60, overrides: {} };
  const input = { playerId: bot.playerId, side: 'L', colOffset: 0, units: [
    { uid: 1, kind: 'chess' }, { uid: 2, kind: 'chess' }, { uid: 3, kind: 'token' },
  ], bonds: { sargonShip: { layers: 7 } }, contentInfo: { kind: 'normal' } };
  const before = JSON.stringify(input);
  m.newBattle = opts => ({ opts });
  const preview = createRelayRehearsal(m, bot, input, { ...perfect, unitsEnd: [
    { uid: 1, alive: true, hpPct: 0.42, sp: 13, skillActive: true },
    { uid: 2, alive: false, hpPct: 0 }, { uid: 3, alive: false, hpPct: 0 },
  ] });
  assert.equal(preview.count, 12);
  const opts = preview.battle.opts;
  assert.equal(opts.kind, 'unite');
  assert.equal(opts.waveId, m.gd.unite.templates[1]);
  assert.equal(opts.flags.layerGainsEnabled, false);
  assert.equal(opts.players[0].contentInfo.kind, 'unite');
  assert.deepEqual(opts.players[0].units[0].carryState, { hpPct: 0.42, sp: 13, skillActive: true });
  assert.deepEqual(opts.players[0].units[1].carryState, { down: true });
  assert.equal(opts.players[0].units[2].carryState, undefined, 'summons do not inherit operator carry state');
  assert.equal(JSON.stringify(input), before);
  assert.equal(createRelayRehearsal(m, bot, input, { leaked: [{ counted: true }] }), null);
});

test('relay trial bills leaked and unspawned enemies without inventing a successful defense', () => {
  assert.equal(relayDefenseValue({ perPlayer: { a: { leaked: [] } } }, 12), 6);
  assert.equal(relayDefenseValue({ perPlayer: { a: { leaked: [{}, { counted: false }] } }, unspawned: [{}] }, 12), 5);
  assert.equal(relayDefenseValue({ synthetic: true }, 12), 0);
});

test('relay comparison remains sliced, chooses stronger backup only after a perfect own battle, and restores state', t => {
  const run = budget => {
    const m = setup(t), bot = m.order.find(p => p.isBot);
    m.round = 3;
    m.botRehearsal = 2;
    const id = [...m.pool.entries].find(([id, e]) => e.left > 0 && m.gd.chess(id)?.visible)[0];
    const piece = give(m, bot, id);
    const tile = legalTileFor(m, bot, id);
    const plans = ['RIGHT', 'UP'].map(dir => {
      const plan = new Map([[piece.uid, tile]]);
      plan.dirs = new Map([[piece.uid, dir]]);
      return plan;
    });
    const enemyKey = Object.keys(m.gd.raw.enemies).find(key => m.gd.enemy(key));
    m.wave = { spawns: [{ enemyKey, count: 12 }], routes: [], timeLimit: 60, overrides: {} };
    let ticks = 0, relayTrials = 0;
    m.newBattle = opts => {
      const relay = opts.kind === 'unite';
      if (relay) relayTrials++;
      const succeeds = opts.players[0].units[0].dir === 'UP';
      let step = 0;
      return { finished: false, step() { ticks++; if (++step >= 12) this.finished = true; },
        forceEnd() { this.finished = true; }, result() { return { perPlayer: { [bot.playerId]: {
          ...perfect, killed: 12, leaked: relay && !succeeds ? Array(12).fill({ counted: true }) : [],
          unitsEnd: [{ uid: piece.uid, alive: true, hpPct: 1, sp: 12 }], layerGains: {},
        } } }; } };
    };
    const state = () => JSON.stringify({ board: [...bot.board], hand: bot.hand, funds: bot.funds, layers: bot.layers });
    const before = state();
    const job = createRehearsal(m, bot, [piece], plans);
    assert.equal(state(), before);
    let done = false, largest = 0;
    while (!done) { const n = ticks; done = job.run(budget); largest = Math.max(largest, ticks - n); }
    assert.equal(job.best, plans[1]);
    assert.equal(state(), before);
    assert.equal(relayTrials, 2);
    return largest;
  };
  assert.ok(run(Infinity) >= 48);
  assert.ok(run(0) <= 4, 'additional relay trials obey the existing four-tick slice bound');
});

test('a stage owner defends; absent AI cover makes other bots defend, even when the human was perfect', t => {
  const m = setup(t), [a, b, c] = m.order.filter(p => p.isBot), human = m.order.find(p => !p.isBot);
  m.round = 3;
  m.lastResults.set(human.playerId, perfect);
  assert.ok(relayDuty(m, a));
  assert.ok(relayDuty(m, b));
  assert.ok(relayDuty(m, c));
  m.lastResults.set(a.playerId, perfect);
  assert.equal(relayDuty(m, b), false);
  m.lastResults.set(a.playerId, { ...perfect, unitsEnd: [{ alive: false, hpPct: 0 }] });
  assert.ok(relayDuty(m, b), 'a perfect result with everyone down is not reliable growth cover');
  m.lastResults.set(a.playerId, { ...perfect, unitsEnd: [{ alive: true, hpPct: 0.1 }] });
  assert.ok(relayDuty(m, b), 'a barely surviving defender is not reliable growth cover');
  m.lastResults.set(a.playerId, { perfect: false, leaked: [{ counted: true }] });
  assert.ok(relayDuty(m, b));
  m.lastResults.set(a.playerId, perfect);
  a.alive = false;
  assert.ok(relayDuty(m, b));
  m.round = m.gd.bossRound;
  assert.equal(relayDuty(m, b), false, 'boss fights do not use normal-round relay priorities');
});

test('rehearsal rewards carry-over health only for perfect defense and never grants layers or resources', t => {
  const m = setup(t), bot = m.order.find(p => p.isBot);
  m.round = 3;
  const before = JSON.stringify({ funds: bot.funds, layers: bot.layers, board: [...bot.board] });
  const healthy = relayCarryValue(m, bot, perfect);
  assert.ok(healthy > relayCarryValue(m, bot, { ...perfect, unitsEnd: [{ alive: true, hpPct: 0.1 }] }));
  assert.ok(healthy > relayCarryValue(m, bot, { ...perfect, unitsEnd: [{ alive: false, hpPct: 1 }] }));
  assert.equal(relayCarryValue(m, bot, { ...perfect, leaked: [{ counted: true }] }), 0);
  assert.equal(JSON.stringify({ funds: bot.funds, layers: bot.layers, board: [...bot.board] }), before);
});

test('core diversity reacts to public teammate commitments without discarding an established core', t => {
  const m = setup(t), [a, b] = m.order.filter(p => p.isBot);
  const score = () => relayCoreValue(m, b, 'sargonShip', 0, 3, bandBonds);
  const free = score();
  a.bandId = 'band_pepe';
  assert.ok(score() < free);
  assert.equal(relayCoreValue(m, b, 'sargonShip', 3, 3, bandBonds), free);
  b.layers.sargonShip = 30;
  assert.equal(score(), free);
  const open = relayBandValue(m, b, 'band_pepe', ['sargonShip'], bandBonds);
  a.bandId = null;
  assert.ok(relayBandValue(m, b, 'band_pepe', ['sargonShip'], bandBonds) > open);
});
