import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, legalTileFor, checkInvariants } from '../match/harness.js';
import { corePlan, coreReserveValue, coreUpgradeWanted, bandBonds, bandScore, layerValue, battleLayerValue, combatBondValue, equipmentScore } from '../../server/match/ai/botStrategy.js';
import { arrange, botPrep, createRehearsal, planLayout } from '../../server/match/bot.js';

function setup(t) {
  const h = makeMatch({ mode: 'coop', difficulty: 'ABYSS', humans: 1, seed: 7, fake: true }).start();
  h.toPrep(1);
  const { m } = h, ps = m.order[0];
  t.after(() => m.dispose());
  m.round = 7;
  ps.funds = 0;
  ps.shop.freeRefreshes = 0;
  ps.shop.slots = Array(ps.shop.layout.chess + ps.shop.layout.item).fill(null);
  return { m, ps };
}
function id(m, name, elite = false) {
  return Object.values(m.gd.raw.chess).find(c => c.name === name && c.isGolden === elite).chessId;
}
function put(m, ps, name, elite = false) {
  const key = id(m, name, elite);
  return give(m, ps, key, 'board', legalTileFor(m, ps, key));
}

test('core targets include strategy gift pools and faction replacement effects', (t) => {
  const { m } = setup(t);
  assert.deepEqual(bandBonds(m, 'band_paganini'), ['lateranoShip']);
  assert.deepEqual(bandBonds(m, 'band_narant'), ['sargonShip']);
  assert.deepEqual(bandBonds(m, 'band_duyaoy'), ['yanShip']);
  assert.deepEqual(bandBonds(m, 'band_bldsk'), []);
});

test('opening strategy retains its reachable core despite a temporary off-core pair', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_harold';
  give(m, ps, id(m, '刺玫'));
  give(m, ps, id(m, '普罗旺斯'));
  give(m, ps, id(m, '德克萨斯'));
  const plan = corePlan(m, ps);
  assert.equal(plan.id, 'victoriaShip');
  assert.equal(plan.target, 6);
  assert.equal(plan.count, 1);
});

test('unreachable cores are rejected even with their strategy and many duplicate copies', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_duyaoy';
  give(m, ps, id(m, '惊蛰'));
  give(m, ps, id(m, '惊蛰'));
  give(m, ps, id(m, '普罗旺斯'));
  for (const [key, entry] of m.pool.entries) if (m.gd.chess(key).bonds.includes('yanShip')) entry.left = 0;
  assert.notEqual(corePlan(m, ps)?.id, 'yanShip');
});

test('core reserves count distinct operators and respect the actual five-member Egir threshold', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_clementia';
  for (const name of ['深巡', '幽灵鲨', '斯卡蒂']) put(m, ps, name);
  const plan = corePlan(m, ps);
  assert.equal(plan.id, 'egirShip');
  assert.equal(plan.target, 5);
  assert.ok(coreReserveValue(m, ps, id(m, '水月')) > 0);
  assert.equal(coreReserveValue(m, ps, id(m, '斯卡蒂')), 0);
  assert.equal(coreReserveValue(m, ps, id(m, '洛洛')), 0);
  m.round = m.gd.bossRound;
  assert.equal(coreReserveValue(m, ps, id(m, '水月')), 0);
});

test('core layers take priority over incidental addons without rewarding capped or inactive bonds', (t) => {
  const { m, ps } = setup(t);
  ps._botCore = { id: 'yanShip' };
  const bonds = { yanShip: { active: true }, preciShip: { active: true } };
  assert.ok(layerValue(m, ps, 'yanShip', 5, bonds) > layerValue(m, ps, 'preciShip', 5, bonds));
  ps.layers.yanShip = 999;
  assert.equal(layerValue(m, ps, 'yanShip', 5, bonds), 0);
  assert.equal(layerValue(m, ps, 'yanShip', 5, {}), 0);
});

test('a complete owned core reaches its upper tier instead of scattering into addon contracts', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_chiave';
  for (const name of ['普罗旺斯', '德克萨斯', '拉普兰德', '忍冬', '伺夜', '阿罗玛']) give(m, ps, id(m, name));
  put(m, ps, '角峰'); put(m, ps, '雪猎'); put(m, ps, '深靛'); put(m, ps, '跃跃');
  ps.layers.siracusaShip = 60;
  arrange(m, ps);
  assert.ok(ps.bonds.siracusaShip.count >= 6);
  checkInvariants(m);
});

test('battle layer engines need deployment and active uncapped cores', (t) => {
  const { m, ps } = setup(t);
  const p = { id: id(m, '瑕光'), kind: 'chess', items: [] };
  const bonds = { kazimierzShip: { active: true, count: 3, layers: 0 } };
  assert.ok(battleLayerValue(m, ps, p, { bonds }) > 0);
  assert.equal(battleLayerValue(m, ps, p, { bonds, bench: true }), 0);
  assert.equal(battleLayerValue(m, ps, p, { bonds: {} }), 0);
  ps.layers.kazimierzShip = 999;
  assert.equal(battleLayerValue(m, ps, p, { bonds }), 0);
});

test('Narant strategy does not receive the normal six-Sargon attack bonus', (t) => {
  const { m, ps } = setup(t);
  const set = ['艾丝黛尔', '莎草', '泡泡', '菲莱', '至简', '百炼嘉维尔'].map(name => ({ id: id(m, name), kind: 'chess', items: [] }));
  const bonds = { sargonShip: { active: true, count: 6, tier: 2, layers: 100 } };
  const normal = combatBondValue(m, set, bonds);
  ps.bandId = 'band_narant';
  assert.ok(combatBondValue(m, set, bonds, ps) < normal);
});

test('a technically live faction with only late recruits loses its opening strategy premium', (t) => {
  const { m, ps } = setup(t);
  m.bondLive = () => true;
  const early = bandScore(m, ps, 'band_harold');
  for (const [key, entry] of m.pool.entries) if (m.gd.chess(key).bonds.includes('victoriaShip') && entry.tier <= 3) entry.left = 0;
  assert.ok(bandScore(m, ps, 'band_harold') < early - 10);
});

test('Victoria first equipment receives its real bond damage benefit only while active', (t) => {
  const { m, ps } = setup(t);
  const p = { id: id(m, '洛洛'), kind: 'chess', items: [] };
  const loaded = { ...p, items: [{ uid: 888, id: 'chess_item_1_01_e_a' }] };
  ps.layers.victoriaShip = 100;
  ps.bonds.victoriaShip = { active: true, count: 3, layers: 100 };
  const first = equipmentScore(m, ps, 'chess_item_1_02_e_a', p);
  assert.ok(first > equipmentScore(m, ps, 'chess_item_1_02_e_a', loaded));
  ps.bonds.victoriaShip.active = false;
  assert.equal(equipmentScore(m, ps, 'chess_item_1_02_e_a', p), equipmentScore(m, ps, 'chess_item_1_02_e_a', loaded));
});

test('a general opening strategy prefers a core that the current shop can complete sooner', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_bldsk';
  ps.shop.level = 2;
  give(m, ps, id(m, '惊蛰'));
  give(m, ps, id(m, '德克萨斯'));
  for (const [key, entry] of m.pool.entries) if (m.gd.chess(key).bonds.includes('yanShip') && entry.tier < 5) entry.left = 0;
  assert.equal(corePlan(m, ps).id, 'siracusaShip');
});

test('shopping keeps an intermediate core member even when elite substitutes fill the board', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_chiave';
  for (const name of ['普罗旺斯', '德克萨斯', '忍冬']) put(m, ps, name, true);
  for (const name of ['星熊', '能天使', '雪猎', '深靛', '莎草']) put(m, ps, name, true);
  const recruit = id(m, '拉普兰德');
  ps.funds = m.gd.chessPrice(recruit);
  ps.shop.slots[0] = { kind: 'chess', id: recruit, basePrice: ps.funds, sold: false, frozen: false };
  botPrep(m, ps);
  assert.ok(ps.allChess().some(p => p.id === recruit), 'the fourth core member was purchased and retained');
  checkInvariants(m);
});

test('equal rehearsal defense prefers useful layers, but additional leaks cannot purchase growth', (t) => {
  const { m, ps } = setup(t);
  const units = ['艾丝黛尔', '莎草', '泡泡', '菲莱'].map(name => put(m, ps, name));
  ps._botCore = { id: 'sargonShip' };
  m.botRehearsal = 3;
  const sets = [units.slice(0, 3), units.slice(1), [units[0], units[2], units[3]]];
  const plans = sets.map(set => planLayout(m, ps, set));
  const before = JSON.stringify({ board: [...ps.board], hand: ps.hand, layers: ps.layers, funds: ps.funds });
  const run = (capped = false) => {
    let i = 0;
    m.newBattle = () => {
      const idx = i++;
      return { finished: true, result: () => ({ perPlayer: { [ps.playerId]: {
        killed: 10, leaked: idx === 2 ? [{ counted: true }] : [],
        layerGains: { sargonShip: [1, 20, 999][idx] },
      } } }) };
    };
    const job = createRehearsal(m, ps, sets[0], plans);
    job.run();
    assert.equal(job.best, plans[capped ? 0 : 1]);
  };
  run();
  assert.equal(JSON.stringify({ board: [...ps.board], hand: ps.hand, layers: ps.layers, funds: ps.funds }), before);
  ps.layers.sargonShip = 999;
  ps.recompute();
  run(true);
});

test('core access upgrades preserve buying money and do not outrun the curve or a completed core', (t) => {
  const { m, ps } = setup(t);
  for (const name of ['惊蛰', '小满', '诗怀雅', '星熊', '能天使', '深靛']) put(m, ps, name);
  ps._botCore = { id: 'yanShip', count: 4, first: 3, target: 6, finishLevel: 5 };
  ps.shop.level = 3;
  ps.funds = 11;
  assert.ok(coreUpgradeWanted(m, ps, 3, 7));
  ps.funds = 10;
  assert.equal(coreUpgradeWanted(m, ps, 3, 7), false, 'keep at least four coins for recruitment');
  ps.funds = 100;
  ps.shop.level = 4;
  assert.equal(coreUpgradeWanted(m, ps, 3, 7), false, 'at most one level ahead');
  ps.shop.level = 5;
  assert.equal(coreUpgradeWanted(m, ps, 5, 7), false, 'remaining members are already available');
  ps.shop.level = 3;
  ps._botCore.count = 6;
  assert.equal(coreUpgradeWanted(m, ps, 3, 7), false, 'the formation is already complete');
});

test('rehearsal growth follows the candidate core activation instead of the restored board', (t) => {
  const { m, ps } = setup(t);
  const oldCore = ['普罗旺斯', '德克萨斯', '忍冬'].map(name => put(m, ps, name));
  const newCore = ['艾丝黛尔', '莎草', '泡泡'].map(name => give(m, ps, id(m, name)));
  ps._botCore = { id: 'sargonShip' };
  ps.recompute();
  assert.ok(ps.bonds.siracusaShip.active);
  assert.ok(!ps.bonds.sargonShip?.active);
  m.botRehearsal = 2;
  const plans = [oldCore, newCore].map(set => planLayout(m, ps, set));
  const before = JSON.stringify({ board: [...ps.board], hand: ps.hand, layers: ps.layers, funds: ps.funds });
  let i = 0;
  m.newBattle = () => {
    const bond = ['siracusaShip', 'sargonShip'][i++];
    return { finished: true, result: () => ({ perPlayer: { [ps.playerId]: {
      killed: 10, leaked: [], layerGains: { [bond]: 10 },
    } } }) };
  };
  const job = createRehearsal(m, ps, oldCore, plans);
  job.run();
  assert.equal(job.best, plans[1], 'prefer the activated focus core with equal immediate defense and layers');
  assert.equal(JSON.stringify({ board: [...ps.board], hand: ps.hand, layers: ps.layers, funds: ps.funds }), before);
});
