import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, legalTileFor, checkInvariants } from './harness.js';
import { botPickBand, botPickCard, botPrep, fieldModel, damageRatio, planLayout, arrange, createRehearsalSteps } from '../../server/match/bot.js';
import { bandScore, benchValue, recurringValue, refreshValue, equipmentScore, bestEquipmentTarget, lineupState, layerValue, traitValue, combatBondValue, combatRecord } from '../../server/match/botStrategy.js';

function setup(t) {
  const h = makeMatch({ mode: 'solo', seed: 7, fake: true }).start();
  h.toPrep(1);
  const { m } = h, ps = m.order[0];
  t.after(() => m.dispose());
  m.round = 7;
  ps.funds = 0;
  ps.shop.freeRefreshes = 0;
  ps.shop.slots = [];
  return { h, m, ps };
}
const byName = (m, name, golden = false) => Object.values(m.gd.raw.chess).find((c) => c.name === name && c.isGolden === golden).chessId;
function put(m, ps, name, golden = false) {
  const id = byName(m, name, golden);
  return give(m, ps, id, 'board', legalTileFor(m, ps, id));
}

test('strategy score respects actual allies, faction bans, and already-taken strategies', (t) => {
  const { m, ps } = setup(t);
  const alone = bandScore(m, ps, 'band_lmlee');
  m.order.push({ playerId: 'friend', alive: true, bandId: 'band_bldsk' });
  assert.ok(bandScore(m, ps, 'band_lmlee') > alone);
  const live = m.bondLive;
  m.bondLive = () => true;
  const available = bandScore(m, ps, 'band_harold');
  m.bondLive = () => false;
  assert.ok(bandScore(m, ps, 'band_harold') < available - 20);
  m.bondLive = live;
  m.bandTaken = (id) => id !== 'band_sarkazb';
  assert.equal(botPickBand(m, ps), 'band_sarkazb');
});

test('bench layer engines are kept, board-only traits do not receive bench credit, inactive/capped layers have no value', (t) => {
  const { m, ps } = setup(t);
  put(m, ps, '角峰'); put(m, ps, '耶拉'); put(m, ps, '雪猎');
  for (let i = 0; i < 5; i++) give(m, ps, byName(m, '星熊', true));
  const podenco = give(m, ps, byName(m, '波登可'));
  const aroma = give(m, ps, byName(m, '刺玫'));
  assert.ok(benchValue(m, ps, podenco) > 0);
  assert.equal(recurringValue(m, ps, aroma, { bench: true }), 0);
  botPrep(m, ps);
  assert.ok(ps.find(podenco.uid), 'the layer engine remains owned');
  ps.layers.kjeragShip = 999;
  assert.equal(layerValue(m, ps, 'kjeragShip', 10), 0);
  assert.equal(layerValue(m, ps, 'unknown', 10), 0);
});

test('moving a deck-counted bond member off board preserves its activation in lineup estimates', (t) => {
  const { m, ps } = setup(t);
  const members = Object.values(m.gd.raw.chess).filter((c) => !c.isGolden && c.visible && c.bonds.includes('visiShip')).slice(0, 3);
  const pieces = members.map((c) => give(m, ps, c.chessId, 'board', legalTileFor(m, ps, c.chessId)));
  const before = ps.bonds.visiShip;
  const state = lineupState(m, ps, pieces.slice(1));
  assert.ok(state.hand.includes(pieces[0]));
  assert.equal(state.bonds.visiShip.tier, before.tier);
  assert.equal(state.bonds.visiShip.count, before.count);
});

test('first-refresh layers are credited once and refresh growth stops at its per-round and global caps', (t) => {
  const { m, ps } = setup(t);
  put(m, ps, '德克萨斯'); put(m, ps, '普罗旺斯'); put(m, ps, '伺夜');
  const lap = give(m, ps, byName(m, '拉普兰德'));
  ps.round.refreshes = 0;
  assert.ok(refreshValue(m, ps) > 0);
  // this copy has had its first refresh of the round (per-copy rule, garrisons/meta.js)
  ps.round.refreshes = 1;
  ps.counters[`refreshLayer:garrison_123_a:${lap.uid}:round`] = m.round;
  ps.counters[`refreshLayer:garrison_123_a:${lap.uid}:count`] = 1;
  assert.equal(refreshValue(m, ps), 0);
  put(m, ps, '安洁莉娜');
  assert.ok(refreshValue(m, ps) > 0);
  ps.round.refreshes = 3;
  assert.equal(refreshValue(m, ps), 0);
  ps.round.refreshes = 0; ps.layers.siracusaShip = 999;
  assert.equal(refreshValue(m, ps), 0);
});

test('armor goes to blockers, penetration to arts, and harmful transformations spare elites', (t) => {
  const { m, ps } = setup(t);
  const tank = put(m, ps, '星熊'), sniper = put(m, ps, '能天使'), caster = put(m, ps, '惊蛰');
  assert.equal(bestEquipmentTarget(m, ps, 'chess_item_1_02_e_a').piece.uid, tank.uid);
  assert.equal(bestEquipmentTarget(m, ps, 'chess_item_3_03_e_a').piece.uid, caster.uid);
  assert.ok(equipmentScore(m, ps, 'chess_item_3_03_e_a', caster) > equipmentScore(m, ps, 'chess_item_3_03_e_a', sniper));
  const elite = { ...sniper, id: m.gd.goldenIdOf(sniper.id) };
  assert.equal(equipmentScore(m, ps, 'chess_item_5_08_e_a', elite), -Infinity);
  assert.equal(equipmentScore(m, ps, 'chess_item_5_06_e_b', elite), -Infinity);
});

test('item combinations and signatures are evaluated on the actual holder', (t) => {
  const { m, ps } = setup(t);
  const c = put(m, ps, '角峰'), other = put(m, ps, '星熊');
  const ice = giveItem(m, ps, 'chess_item_5_02_e_a');
  assert.ok(ps.equip(ice.uid, c.uid).ok);
  const target = bestEquipmentTarget(m, ps, 'chess_item_6_06_e_a');
  assert.equal(target.piece.uid, c.uid);
  assert.ok(target.score > equipmentScore(m, ps, 'chess_item_6_06_e_a', other));
});

test('better equipment replaces the weakest item explicitly, equal equipment is not churned', (t) => {
  const { m, ps } = setup(t);
  const tank = put(m, ps, '星熊');
  for (const id of ['chess_item_1_01_e_a', 'chess_item_3_03_e_a']) assert.ok(ps.equip(giveItem(m, ps, id).uid, tank.uid).ok);
  const target = bestEquipmentTarget(m, ps, 'chess_item_1_02_e_b');
  assert.equal(target.replaceUid, tank.items.find((it) => it.id === 'chess_item_3_03_e_a').uid);
  assert.ok(ps.equip(giveItem(m, ps, 'chess_item_1_02_e_b').uid, tank.uid, target.replaceUid).ok);
  assert.equal(bestEquipmentTarget(m, ps, 'chess_item_1_01_e_a'), null);
});

test('wave model never invents ground enemies for an all-flying wave and tracks defenses/quantities', (t) => {
  const { m, ps } = setup(t);
  const enemy = Object.values(m.gd.raw.enemies).find((e) => e.isFlyEnemy);
  m.wave = { templateId: 'flying-test', routes: [{ start: [9, 9], end: [9, 0], motion: 'FLY' }],
    spawns: [{ enemyKey: enemy.key, routeIndex: 0, count: 15, interval: 1 }] };
  m._botPath = null;
  const model = fieldModel(m, ps);
  assert.equal(model.flyTotal, 15);
  assert.equal(model.ground.size, 0);
  assert.ok(model.routes.every((r) => r.fly));
  assert.equal(model.routes[0].def, enemy.stats.def);
  assert.equal(model.routes[0].res, enemy.stats.res);
});

test('enemy armor favors arts, resistance favors physical damage', () => {
  const physical = { dmgType: 'phys', stats: { atk: 500 } }, arts = { dmgType: 'arts', stats: { atk: 500 } };
  assert.ok(damageRatio(physical, { def: 900, res: 0 }) < damageRatio(arts, { def: 900, res: 0 }));
  assert.ok(damageRatio(physical, { def: 0, res: 80 }) > damageRatio(arts, { def: 0, res: 80 }));
});

test('wave estimates apply template overrides before spawn multipliers, including zero defense', (t) => {
  const { m, ps } = setup(t);
  const enemy = Object.values(m.gd.raw.enemies).find((e) => e.stats?.def > 100);
  m.wave = { templateId: 'override-test', routes: [{ start: [9, 9], end: [9, 0], motion: 'WALK' }],
    overrides: { [enemy.key]: { stats: { hp: 2000, atk: 400, def: 0, res: 25, moveSpeed: 1 } } },
    spawns: [{ enemyKey: enemy.key, routeIndex: 0, count: 5, mods: { hpMul: 2, atkMul: 3, defMul: 2, resMul: 2 } }] };
  m._botPath = null;
  const r = fieldModel(m, ps).routes[0];
  assert.deepEqual([r.hp, r.atk, r.def, r.res, r.n], [4000, 1200, 0, 50, 5]);
});

test('layered combat bonds value the deployed beneficiaries and third precision member shares its buff', (t) => {
  const { m, ps } = setup(t);
  const units = ['跃跃', '深靛', '雪猎', '至简'].map((name) => ({ id: byName(m, name), kind: 'chess', items: [] }));
  const on = (count, layers) => ({ active: true, count, tier: count >= 3 ? 2 : 1, layers });
  const low = combatBondValue(m, units, { preciShip: on(2, 0) });
  const high = combatBondValue(m, units, { preciShip: on(2, 120) });
  assert.ok(high > low * 3);
  assert.ok(combatBondValue(m, units, { preciShip: on(3, 120) }) > high);
  assert.equal(combatBondValue(m, units, { preciShip: { active: false, layers: 999 } }), 0);
  assert.equal(combatBondValue(m, [], { preciShip: on(3, 120) }), 0);
});

test('route planning uses accumulated buffs without mutating shared operator stats', (t) => {
  const { m, ps } = setup(t);
  const p = { id: byName(m, '深靛'), kind: 'chess', items: [] };
  const rec = m.gd.chess(p.id), before = JSON.stringify(rec);
  const bonds = { preciShip: { active: true, count: 2, tier: 1, layers: 100 } };
  const boosted = combatRecord(m, ps, p, bonds, 8);
  assert.ok(boosted.stats.atk > rec.stats.atk * 2);
  assert.equal(combatRecord(m, ps, p, {}, 8).stats.atk, rec.stats.atk);
  assert.equal(JSON.stringify(rec), before);
});

test('alternative-roster rehearsals preserve inventory at every yield and include team context and isolated growth', (t) => {
  const { m, ps } = setup(t);
  ps.shop.slots = Array(ps.shop.layout.chess + ps.shop.layout.item).fill(null);
  m.botRehearsal = 2;
  const a = put(m, ps, '角峰'), b = put(m, ps, '耶拉');
  const c = give(m, ps, byName(m, '雪猎'));
  const snap = () => JSON.stringify({ board: [...ps.board], hand: ps.hand, temp: ps.temp, layers: ps.layers, bonds: ps.bonds, uid: m.uidSeq, pool: m.pool.snapshot() });
  const before = snap(), inputs = [];
  const build = m.newBattle.bind(m);
  m.newBattle = (opts) => { inputs.push(opts); return build(opts); };
  const job = createRehearsalSteps(m, ps, [a, b], [planLayout(m, ps, [a, b]), planLayout(m, ps, [a, c])]);
  let step;
  do { step = job.next(); assert.equal(snap(), before); } while (!step.done);
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((opts) => opts.flags.layerGainsEnabled && opts.players[0].contentInfo.matchBands.includes(ps.bandId)));
  step.value.run();
  assert.equal(snap(), before, 'simulated gains are not applied to real players');
  checkInvariants(m);
});

test('investor repeats acquisition traits and layer estimates remain capped', (t) => {
  const { m, ps } = setup(t);
  put(m, ps, '角峰'); put(m, ps, '耶拉'); put(m, ps, '雪猎');
  const c = { id: byName(m, '角峰'), kind: 'chess', items: [] };
  const single = traitValue(m, ps, c, ['SERVER_GAIN']);
  ps.bonds.investShip = { active: true, tier: 1, layers: 0 };
  assert.ok(Math.abs(traitValue(m, ps, c, ['SERVER_GAIN']) - single * 2) < 1e-9);
  ps.bonds.investShip.layers = 100;
  assert.ok(Math.abs(traitValue(m, ps, c, ['SERVER_GAIN']) - single * 3) < 1e-9);
  ps.layers.kjeragShip = 998;
  assert.ok(traitValue(m, ps, c, ['SERVER_GAIN']) < single * 3);
});

test('actual selected lineup changes between armored and resistant enemy waves', (t) => {
  const { m, ps } = setup(t);
  const original = m.gd.chess.bind(m.gd);
  const archerId = byName(m, '能天使'), casterId = byName(m, '惊蛰'), anchorId = byName(m, '星熊', true);
  const overrides = new Map([archerId, casterId, anchorId].map((id) => [id, { ...original(id), bonds: [], garrisonIds: [] }]));
  for (const id of [archerId, casterId]) overrides.set(id, { ...overrides.get(id), tier: 3, stats: { ...overrides.get(id).stats, atk: 500 } });
  m.gd.chess = (id) => overrides.get(id) || original(id);
  for (let i = 0; i < 7; i++) give(m, ps, anchorId);
  const archer = give(m, ps, archerId), caster = give(m, ps, casterId);
  const enemy = Object.values(m.gd.raw.enemies).find((e) => !e.isFlyEnemy && e.stats);
  const enemyLookup = m.gd.enemy.bind(m.gd);
  for (const [name, def, res, expected] of [['armor', 1500, 0, caster], ['resistance', 0, 90, archer]]) {
    ps.ready = false;
    m.gd.enemy = (id) => id === enemy.key ? { ...enemy, stats: { ...enemy.stats, def, res } } : enemyLookup(id);
    m.wave = { templateId: name, routes: [{ start: [10, 9], end: [10, 0], motion: 'WALK' }], spawns: [{ enemyKey: enemy.key, routeIndex: 0, count: 20, interval: 1 }] };
    m._botPath = null;
    arrange(m, ps);
    assert.equal(ps.find(expected.uid)?.area, 'board', `${name}: correct damage dealer deployed`);
    assert.equal(ps.deployCount, 8);
  }
});

test('route quantity changes move a blocker to the busier lane', (t) => {
  const { m, ps } = setup(t);
  const guard = give(m, ps, byName(m, '星熊'));
  const enemy = Object.values(m.gd.raw.enemies).find((e) => !e.isFlyEnemy && e.stats);
  // The two visible routes occupy separated rows of the real stage.
  const rows = [9, 12];
  const destinations = [];
  for (const heavy of [0, 1]) {
    m.wave = { templateId: `lanes-${heavy}`, routes: rows.map((r) => ({ start: [r, 9], end: [r, 0], motion: 'WALK' })),
      spawns: rows.map((_, i) => ({ enemyKey: enemy.key, routeIndex: i, count: i === heavy ? 30 : 1, interval: 1 })) };
    m._botPath = null;
    const plan = planLayout(m, ps, [guard]);
    destinations.push(plan.get(guard.uid));
  }
  assert.notEqual(destinations[0], destinations[1]);
});

test('income consumables fund a purchase during the same prep', (t) => {
  const { m, ps } = setup(t);
  put(m, ps, '星熊');
  giveItem(m, ps, 'chess_item_1_03_e_a');
  ps.funds = 1;
  const id = byName(m, '普罗旺斯');
  ps.shop.slots = [{ kind: 'chess', id, basePrice: 2, sold: false, frozen: false }];
  botPrep(m, ps);
  assert.ok(ps.allChess().some((p) => p.id === id));
  assert.ok(ps.stats.buys > 0);
});

test('an unaffordable third copy is frozen for next round', (t) => {
  const { m, ps } = setup(t);
  const id = byName(m, '星熊');
  give(m, ps, id); give(m, ps, id);
  ps.shop.slots = [{ kind: 'chess', id, basePrice: m.gd.chessPrice(id), sold: false, frozen: false }];
  botPrep(m, ps);
  assert.equal(ps.shop.frozen, true);
  assert.equal(ps.shop.slots[0].frozen, true);
});

test('low life discourages additional bounty enemies and unusable layers lose to useful supplies', (t) => {
  const { m, ps } = setup(t);
  put(m, ps, '星熊');
  ps.lp = 1;
  const cards = [{ kind: 'bounty', payout: 'perfect', tier: 3, count: 5, rounds: 2, coin: 5 },
    { kind: 'item', id: 'chess_item_1_02_e_a', tier: 1 }];
  assert.equal(botPickCard(m, ps, cards, [0, 1]), 1);
});


test('Narant replaces six-Sargon attack stacks; other strategies retain the normal estimate', (t) => {
  const { m, ps } = setup(t);
  const set = ['艾丝黛尔', '莎草', '泡泡', '菲莱', '至简', '百炼嘉维尔'].map((name) => ({ id: byName(m, name), kind: 'chess', items: [] }));
  const bonds = { sargonShip: { active: true, count: 6, tier: 2, layers: 100 } };
  const normal = combatBondValue(m, set, bonds);
  ps.bandId = 'band_bldsk';
  assert.equal(combatBondValue(m, set, bonds, ps), normal);
  ps.bandId = 'band_narant';
  assert.ok(combatBondValue(m, set, bonds, ps) < normal);
  bonds.sargonShip.count = 3; bonds.sargonShip.tier = 1;
  assert.equal(combatBondValue(m, set, bonds, ps), combatBondValue(m, set, bonds), 'the replacement changes the upper effect only');
});
