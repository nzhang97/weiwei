// Economy knobs (botPolicy.econSweep / bankCoins): leftover funds are lost at prep end, so the bot's last coins buy a
// money item — 见钱眼开玩偶 (1 → +2 next round) is used at once; 盟约之币 is kept in the hand as savings and cashed at
// the next prep start. With the knobs off (default) nothing changes: the coin stays unspent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, legalTileFor } from '../match/harness.js';
import { botPrepEnd, botPrepBeginSteps } from '../../server/match/bot.js';
import { BOT_POLICY } from '../../server/match/ai/botPolicy.js';

const NEXT = 'chess_item_2_07_e_a';
const COIN = 'chess_item_1_03_e_a';

function setup(policy, itemId) {
  const seats = [{ seat: 0, playerId: 'ai_0', name: 'AI', isBot: true, connected: true }];
  const h = makeMatch({ mode: 'solo', difficulty: 'ABYSS', seats, seed: 5 }).start();
  h.toPrep(2);
  const m = h.m, ps = h.ps('ai_0');
  // knob tests start from the plain defaults (solo ABYSS otherwise carries SOLO_POLICY, econSweep on)
  m.botPolicy = { ...BOT_POLICY, ...policy };
  ps.ready = false;
  if (![...ps.board.values()].some((p) => p.kind === 'chess')) { const c = give(m, ps, 'chess_char_1_14_a'); const at = legalTileFor(m, ps, c.id); ps.move(c.uid, { area: 'board', row: at[0], col: at[1] }); }
  for (let i = 0; i < ps.hand.length; i++) if (ps.hand[i] && ps.hand[i].kind === 'item') ps.hand[i] = null;
  ps.shop.slots = ps.shop.slots.map(() => null);
  ps.shop.slots[0] = { kind: 'item', id: itemId, price: 1, basePrice: 1, sold: false };
  ps.shop.frozen = false;
  ps.funds = 1;
  return { h, m, ps };
}
const handItems = (ps, id) => ps.hand.filter((p) => p && p.kind === 'item' && p.id === id);

test('default policy: the last coin is not spent on money items', () => {
  const { m, ps } = setup({}, NEXT);
  botPrepEnd(m, ps);
  assert.equal(ps.funds, 1);
  assert.equal(ps.shop.slots[0]?.sold, false);
});

test('econSweep: the last coin buys 见钱眼开玩偶 and uses it at once', () => {
  const { m, ps } = setup({ econSweep: true }, NEXT);
  botPrepEnd(m, ps);
  assert.equal(ps.funds, 0);
  assert.equal(ps.shop.slots[0].sold, true);
  assert.equal(handItems(ps, NEXT).length, 0, 'consumed on equip');
});

test('econSweep + bankCoins: 盟约之币 is kept as savings and cashed at the next prep start', () => {
  const { m, ps } = setup({ econSweep: true, bankCoins: true }, COIN);
  botPrepEnd(m, ps);
  assert.equal(ps.funds, 0);
  assert.equal(handItems(ps, COIN).length, 1, 'kept in the hand');
  // next prep start: the coin is used (1 fund back)
  ps.ready = false;
  const f0 = ps.funds;
  const it = botPrepBeginSteps(m, ps);
  it.next(); it.next();
  assert.equal(handItems(ps, COIN).length, 0);
  assert.ok(ps.funds >= f0 + 1 || ps.funds >= 1, `funds ${ps.funds}`);
});
