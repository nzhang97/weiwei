// PRTS 卫戍协议：盟约 下半 bounty table (test/fixtures/bounty-wiki-lower.json, checked 2026-10-09): every card's count,
// coin, duration, payout and enemy as the data (incl. the 5 corrections of tools/build-data.mjs buildEffects) carries them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getData } from '../../server/data.js';
import { bountyDraftCard } from '../../server/match/choices.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/bounty-wiki-lower.json', import.meta.url), 'utf8'));
const data = getData({ log: { warn() {}, error() {}, info() {} } });

test('the 125 PRTS bounties match the card data and the effect blackboards', () => {
  assert.equal(fixture.cards.length, 125);
  for (const expected of fixture.cards) {
    const c = data.choices.cards.bounty.find((x) => x.effectId === expected.id);
    assert.ok(c, expected.id);
    for (const k of ['count', 'coin', 'rounds', 'payout', 'enemyKey']) assert.equal(c[k], expected[k], `${expected.id} ${k}`);
    const add = data.effects[expected.id].buffs.find((b) => /add_enemy/.test(b.key) && b.key !== 'next_battle_add_enemy_win_gain_coin' && b.bbStr.enemy_id === c.enemyKey);
    assert.ok(add, expected.id);
    assert.equal(add.bb.count, c.count); assert.equal(add.bb.coin, c.coin); assert.equal(add.bb.round, c.rounds);
  }
});

test('the corrected durations keep their official drafts', () => {
  const card = (id) => data.choices.cards.bounty.find((x) => x.effectId === id);
  assert.equal(card('enemyeffect_18_1').rounds, 1); assert.equal(card('enemyeffect_18_1').draftPool, 'initial');
  assert.equal(card('enemyeffect_16_2').rounds, 2); assert.equal(card('enemyeffect_16_2').draftPool, 'hunter');
  assert.equal(card('enemyeffect_12_7').name, '悬赏·损伤I'); assert.equal(card('enemyeffect_12_7').coin, 1);
  assert.equal(card('enemyeffect_b_11').coin, 3);
  assert.equal(card('enemyeffect_11_6').enemyKey, 'enemy_1207_sfji');
});

test('a drafted bounty lasts by its draft: the first (R3 / solo HARD R4) two battles, R9 / R11 one battle', () => {
  const gd = { effect: (id) => data.effects[id] };
  const card = (id) => data.choices.cards.bounty.find((x) => x.effectId === id);
  const a = bountyDraftCard(gd, card('enemyeffect_18_1'), 'initial');
  assert.equal(a.rounds, 2); assert.match(a.desc, /接下来两场作战/); assert.match(a.descRaw, /接下来<@ba\.vup>两场作战<\/>/);
  const b = bountyDraftCard(gd, card('enemyeffect_16_2'), 'hunter');
  assert.equal(b.rounds, 1); assert.match(b.desc, /下场作战/); assert.doesNotMatch(b.desc, /两场/);
  for (const c of data.choices.cards.bounty) {
    if (!c.draft || c.multiRound) continue;
    assert.equal(bountyDraftCard(gd, c, c.draftPool).rounds, c.draftPool === 'initial' ? 2 : 1, c.effectId);
  }
});
