import test from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../../server/data.js';
import { GRANTED_CAP_OVERRIDE } from '../../server/sim/content/garrisons/battle.js';
import { correctContentDescriptions } from '../../tools/content-text.mjs';

const data = getData({ log: { warn() {}, error() {} } });
test('granted skill-layer descriptions match the cap actually exercised by combat tests', () => {
  for (const quality of ['a', 'b']) {
    const grant = data.garrisons[`garrison_72_${quality}`];
    const cap = GRANTED_CAP_OVERRIDE[grant.bbStr.give_garrison_id];
    for (const text of [grant.desc, grant.descRaw]) assert.ok(text.includes(`至多${cap}层`));
  }
});
test('Yan helper descriptions preserve the template stats plus the 30 percent share', () => {
  for (const field of ['desc', 'descRaw', 'effectDesc', 'effectDescRaw']) {
    assert.match(data.bonds.yanShip[field], /基础攻击力和生命值分别增加开战时/);
    assert.match(data.bonds.yanShip[field], /总和的30%/);
  }
});
test('description corrections survive rebuilding, are idempotent, and never change numeric rules', () => {
  const files = { garrisons: { garrison_72_a: { desc: '至多7层', descRaw: '至多7层', bb: { cap: 7 } } },
    bonds: { yanShip: { desc: '其攻击力生命值分别为开战时【炎】干员攻击力生命值总和的30%', buffs: [{ bb: { atk: 0.23 } }] } } };
  const corrected = correctContentDescriptions(files);
  assert.match(corrected.garrisons.garrison_72_a.desc, /至多12层/);
  assert.equal(corrected.garrisons.garrison_72_a.bb.cap, 7);
  assert.equal(corrected.bonds.yanShip.buffs[0].bb.atk, 0.23);
  const before = JSON.stringify(corrected);
  correctContentDescriptions(corrected);
  assert.equal(JSON.stringify(corrected), before);
});