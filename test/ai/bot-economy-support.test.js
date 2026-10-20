import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, legalTileFor, checkInvariants } from '../match/harness.js';
import { botPrep, arrange } from '../../server/match/bot.js';
import { economyBondValue, economyRecruitValue, benchValue } from '../../server/match/ai/botStrategy.js';

function setup(t) {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, seed: 1, fake: true }).start();
  h.toPrep(1);
  const { m } = h, ps = m.order[0];
  t.after(() => m.dispose());
  m.round = 7;
  ps.bandId = 'band_touch';
  ps.funds = 0;
  ps.shop.level = m.gd.maxShopLevel;
  ps.shop.freeRefreshes = 0;
  ps.shop.slots = Array(ps.shop.layout.chess + ps.shop.layout.item).fill(null);
  return { m, ps };
}
const id = (m, name, golden = false) => Object.values(m.gd.raw.chess).find(c => c.name === name && c.isGolden === golden).chessId;
function put(m, ps, name, golden = false) {
  const key = id(m, name, golden);
  return give(m, ps, key, 'board', legalTileFor(m, ps, key));
}
function fullCombatBoard(m, ps) {
  for (const name of ['星熊', '惊蛰', '小满', '普罗旺斯', '德克萨斯', '拉普兰德', '雪猎', '深靛']) put(m, ps, name, true);
}

test('economy recruits complete distinct bench-counted members without replacing the combat core', (t) => {
  const { m, ps } = setup(t);
  give(m, ps, id(m, '能天使'));
  const before = JSON.stringify({ hand: ps.hand, board: [...ps.board], counters: ps.counters, funds: ps.funds });
  assert.ok(economyRecruitValue(m, ps, id(m, '风丸')) > 1);
  assert.equal(economyRecruitValue(m, ps, id(m, '能天使')), 0);
  assert.equal(JSON.stringify({ hand: ps.hand, board: [...ps.board], counters: ps.counters, funds: ps.funds }), before);
  give(m, ps, id(m, '风丸'));
  assert.equal(economyRecruitValue(m, ps, id(m, '伺夜')), 0, 'a third member does not improve this one-tier economy bond');
  checkInvariants(m);
});

test('unpaid vision milestones can justify reactivation; permanent paid discounts do not require keepers', (t) => {
  const { m, ps } = setup(t);
  give(m, ps, id(m, '赫默'));
  ps.layers.visiShip = 150;
  ps.recompute();
  const before = economyRecruitValue(m, ps, id(m, '初雪'));
  assert.ok(before > 20);
  ps.counters['bondaddon:visi:paid'] = 15;
  ps.counters['bondaddon:visi:disc'] = 2;
  m.round = m.gd.bossRound;
  assert.equal(economyRecruitValue(m, ps, id(m, '初雪')), 0);
  give(m, ps, id(m, '初雪'));
  assert.equal(economyBondValue(m, ps, 'visiShip'), 0);
  const normal = { kind: 'chess', id: id(m, '星熊'), basePrice: 4 };
  assert.equal(ps.priceOf(normal), 3, 'the permanent discount remains active regardless of the planner');
});

test('capped, already-paid vision has no economic retention premium and board removal is evaluated correctly', (t) => {
  const { m, ps } = setup(t);
  const one = put(m, ps, '初雪');
  give(m, ps, id(m, '迷迭香'));
  assert.ok(benchValue(m, ps, one) > 0, 'moving out then selling a board member would break the bond');
  ps.layers.visiShip = 999;
  ps.counters['bondaddon:visi:paid'] = 99;
  ps.counters['bondaddon:visi:disc'] = 2;
  ps.recompute();
  assert.equal(economyBondValue(m, ps, 'visiShip'), 0);
  assert.equal(benchValue(m, ps, one), 0);
});

test('the bot buys and retains the missing miracle partner with an already-full stronger combat roster', (t) => {
  const { m, ps } = setup(t);
  fullCombatBoard(m, ps);
  give(m, ps, id(m, '能天使'));
  const recruit = id(m, '风丸');
  ps.funds = m.gd.chessPrice(recruit);
  ps.shop.slots[0] = { kind: 'chess', id: recruit, basePrice: ps.funds, sold: false, frozen: false };
  botPrep(m, ps);
  assert.ok(ps.allChess().some(p => p.id === recruit));
  assert.ok(ps.bonds.miraShip.active);
  assert.equal(ps.deployCount, ps.deployCap);
  checkInvariants(m);
});

test('earned miracle refreshes have a separate bounded budget, including a guaranteed free chain', (t) => {
  const { m, ps } = setup(t);
  fullCombatBoard(m, ps);
  give(m, ps, id(m, '风丸'));
  give(m, ps, id(m, '能天使'));
  ps.layers.miraShip = 300;
  ps.counters['bondaddon:mira:paid'] = 3;
  ps.shop.freeRefreshes = 1;
  ps.recompute();
  const funds = ps.funds;
  ps.rollShop = () => { ps.shop.slots = Array(ps.shop.layout.chess + ps.shop.layout.item).fill(null); };
  botPrep(m, ps);
  assert.ok(ps.round.refreshes > 10, 'free rolls do not stop at the old 8 + 2 paid limit');
  assert.ok(ps.round.refreshes <= 24, 'a guaranteed chain cannot run without a bound');
  assert.equal(ps.funds, funds);
  checkInvariants(m);
});

test('a complementary support pair can strengthen an intact core when either support alone loses value', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_narant';
  for (const name of ['艾丝黛尔', '莎草', '泡泡', '菲莱', '卡涅利安', '百炼嘉维尔']) put(m, ps, name, true);
  put(m, ps, '星熊', true); put(m, ps, '能天使', true);
  const speed = give(m, ps, id(m, '蒂比'));
  const medic = give(m, ps, id(m, '白面鸮'));
  ps.layers.skillfulShip = 200;
  ps.recompute();
  assert.equal(ps.bonds.skillfulShip.count, 0);
  arrange(m, ps);
  assert.ok(ps.bonds.sargonShip.count >= 6, 'the core remains complete');
  assert.ok(ps.bonds.skillfulShip.active, 'the paired speed support is evaluated together');
  assert.ok([...ps.board.values()].some(p => p.uid === speed.uid));
  assert.ok([...ps.board.values()].some(p => p.uid === medic.uid));
  checkInvariants(m);
});
