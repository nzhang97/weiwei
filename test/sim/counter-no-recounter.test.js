// Engine rule (the fork owner's call): 受击 → 反击 → 受击 stops after one step — a 反击 / 反伤 never triggers another
// counter (server/sim/damage.js COUNTER_TAGS, dealDamage). Before, two units that both strike back (泡泡 S2 “挨打” vs
// “碎铳之簧”'s 法术屏障 counter) bounced damage until the engine's 32-hook guard skipped handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { isCounterDamage } from '../../server/sim/damage.js';

test('a counter is not countered: two mutual counter hooks exchange one counter each way', () => {
  const h = makeBattle({ seed: 1, autoFinish: false, timeLimit: 30,
    defs: { chess: { t_a: chessRec({ id: 't_a', skill: null, stats: { maxHp: 1e6, atk: 0, def: 0, blockCnt: 0 } }) },
      enemies: { e_b: enemyRec({ key: 'e_b', hp: 1e6, atk: 0, speed: 0 }) } },
    units: [{ chessId: 't_a', row: 10, col: 4 }], enemies: [{ key: 'e_b', pos: [10, 5] }] });
  h.step();
  const a = h.unit('t_a'), e = h.b.enemies[0];
  let counters = 0;
  // both sides strike back at whatever damaged them
  h.b.on('damaged', (c) => {
    if (!c.source || !c.source.alive || c.amount <= 0) return;
    if (c.target !== a && c.target !== e) return;
    counters++;
    h.b.dealDamage(c.target, c.source, { amount: 1, type: 'phys', canDodge: false, tags: ['counter'] });
  });
  h.b.dealDamage(e, a, { amount: 5, type: 'phys', canDodge: false, isAttack: true });
  assert.equal(counters, 2, 'the attack is countered once; that counter is countered by nobody (its own damaged hook ran, the reply was dropped)');
  assert.deepEqual(h.b.errors, [], 'no hook-depth error');
  checkInvariants(h.b);
});

test('counter tags and flags are recognised', () => {
  assert.ok(isCounterDamage({ tags: ['counter'] }));
  assert.ok(isCounterDamage({ tags: ['talent', 'reflect'] }));
  assert.ok(isCounterDamage({ tags: ['springCounter'] }));
  assert.ok(isCounterDamage({ reflect: true }));
  assert.ok(!isCounterDamage({ tags: ['skill'] }));
});
