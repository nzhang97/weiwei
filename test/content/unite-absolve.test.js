// test/content/unite-absolve.test.js — 联防 本体击杀免责 (sim Battle._absolveRoot, user ruling 2026-10-15): a helper who
// knocks down the body a leaker sent in (频次, 术师快艇, any split / death-spawn / summoner) frees the leaker from its
// children's LP, even when they reach the objective; a body that gets through still costs its children too; normal
// fields are unchanged; the kill bounty stays on the body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle } from '../helpers/battleHarness.js';
import { spawnChildren } from '../../server/sim/content/enemies/helpers.js';
import { uniteLeft } from '../../server/sim/spec.js';
import { uniteSurvivors } from '../../server/match/unite.js';

const BOAT = 'enemy_1162_magmot'; // 术师快艇 · 控潮术师 on death
const players = [{ playerId: 'h1', seat: 1, side: 'L', colOffset: 0, units: [], bonds: {} }];
function field(kind = 'unite') {
  const h = makeBattle({ kind, players, autoFinish: false, timeLimit: 60 });
  h.step();
  return h;
}
const leaks = (h) => Object.values(h.b._perPlayer).flatMap((pp) => pp.leaked);
const charged = (h) => uniteSurvivors({ notReentered: new Map() }, { perPlayer: h.b._perPlayer }).get('p0') || 0;
const kids = (h, body) => h.b.enemies.filter((e) => e.alive && e.rootId === body.id);

test('联防: the body knocked down → its death spawns cost the leaker nothing, even through the blue gate', () => {
  const h = field();
  const boat = h.spawn(BOAT, { pos: [10, 6], sourcePlayerId: 'p0', bounty: { coins: 3, ownerPlayerId: 'p0' } });
  assert.equal(uniteLeft(h.b).p0, 1);
  h.b.kill(boat);
  const born = kids(h, boat);
  assert.ok(born.length >= 1, '术师快艇 drops its 控潮术师');
  assert.ok(born.every((c) => c.absolved && c.sourcePlayerId === 'p0'), 'born absolved');
  assert.ok(born.every((c) => !c.bounty && !(c.mods && c.mods.bountyId != null)), 'the bounty stays on the body');
  assert.equal(uniteLeft(h.b).p0, undefined, 'live 联防 count: nothing left for p0');
  for (const c of born) h.b.leak(c);
  assert.ok(leaks(h).length >= 1 && leaks(h).every((l) => l.sourcePlayerId === null && l.absolved === true));
  assert.equal(charged(h), 0, 'settlement charges p0 nothing');
});

test('联防: children through before the body falls are absolved once it falls; a body that gets through charges all', () => {
  const h = field();
  const body = h.spawn(BOAT, { pos: [10, 6], sourcePlayerId: 'p0' });
  const [early] = spawnChildren(h.b, body, BOAT, 1);
  h.b.leak(early);
  assert.equal(charged(h), 1, 'charged while the body stands');
  assert.equal(uniteLeft(h.b).p0, 2);
  h.b.kill(body);
  assert.equal(charged(h), 0, 'absolved retroactively');
  const g = field();
  const runner = g.spawn(BOAT, { pos: [10, 6], sourcePlayerId: 'p0' });
  const [kid] = spawnChildren(g.b, runner, BOAT, 1);
  g.b.leak(kid);
  g.b.leak(runner);
  assert.equal(charged(g), 2, 'the body itself leaked: body + child cost LP');
});

test('a normal field is unchanged: a split child that leaks still costs its owner', () => {
  const h = field('normal');
  const boat = h.spawn(BOAT, { pos: [10, 6] });
  h.b.kill(boat);
  const born = kids(h, boat);
  assert.ok(born.length >= 1 && born.every((c) => !c.absolved));
  for (const c of born) h.b.leak(c);
  assert.ok(leaks(h).every((l) => l.sourcePlayerId === 'h1' && !l.absolved && l.counted));
});
