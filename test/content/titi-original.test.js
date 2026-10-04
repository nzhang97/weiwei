// Regression cases from the supplied PRTS skill notes, using the shipped Lv4/Lv7 loadouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { getData } from '../../server/data.js';
import { TICK } from '../../server/sim/constants.js';

const ds = getDefaultSource();
const data = getData({ log: { warn() {}, error() {}, info() {} } });
const ids = ['chess_char_5_02_a', 'chess_char_5_02_b'];
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should be within ${tolerance} of ${expected}`);
const dummy = (key, overrides = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...overrides });
const ally = (id) => chessRec({ id, skill: null, stats: { maxHp: 10000, atk: 0, def: 0, blockCnt: 0 } });
const statusEvents = (h, target, source = null) => h.hooksOf('statusApplied')
  .filter((c) => c.target === target && (source == null || c.source === source));
const damage = (h, unit, tag, target) => h.hooksOf('damaged')
  .filter((c) => c.source === unit && c.target === target && c.dmg?.tags?.includes(tag));
const gains = (h) => h.result().perPlayer.p1.layerGains.preciShip ?? 0;
const clean = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors, []); };

function scenario(id, skillId, options = {}) {
  const skill = ds.rawChess(id).skills.find((s) => s.skillId === skillId);
  assert.ok(skill, `${id} has ${skillId}`);
  const h = makeBattle({
    seed: 7, autoFinish: false, timeLimit: 100, captureNoisy: true,
    hooks: ['damaged', 'statusApplied', 'attack', 'skillStart', 'skillEnd', 'layerGain'],
    defs: { enemies: { e_dummy: dummy('e_dummy'), ...options.enemyDefs }, chess: options.chess ?? {} },
    units: [{ chessId: id, row: 10, col: 4, skillIndex: skill.index }, ...(options.units ?? [])],
    enemies: options.enemies ?? [{ key: 'e_dummy', pos: [10, 6] }],
    bonds: options.bonds ?? {},
  }).step();
  const unit = h.unit(id);
  assert.equal(unit.skill.id, skillId);
  assert.ok(!unit.kit.generic && unit.kit.skillSource !== 'generic', 'the selected skill is hand-authored');
  if (options.disarm !== false) h.b.addBuff(unit, { key: 'test:disarm', flags: { disarm: true } });
  return { h, unit, bb: unit.def.skill.bb };
}

function activate(h, unit) {
  unit.skill.gainSp(1000);
  assert.equal(unit.skill.activate('test'), true);
  return h.b.time;
}

function expectedWake(bb, atk, seconds) {
  return atk * (bb.min_atk_scale + (bb.max_atk_scale - bb.min_atk_scale) * Math.min(1, seconds / 5));
}

test('Titi S1 refreshes an already sleeping target with the selected skill level duration', () => {
  for (const id of ids) {
    const { h, unit, bb } = scenario(id, 'skchr_titi_1', { disarm: false });
    const target = h.b.enemies[0];
    h.b.rng.chance = () => true;
    activate(h, unit);
    h.b.applyStatus(target, 'sleep', { duration: 30 });
    h.b.forceAttack(unit, [target]);
    assert.ok(h.runUntil(() => statusEvents(h, target, unit).some((c) => c.status === 'sleep'), 2));
    const applied = statusEvents(h, target, unit).filter((c) => c.status === 'sleep');
    for (const event of applied) {
      close(event.duration, bb['attack@sleep']);
      assert.equal(event.entered, false, 'a successful proc refreshes existing sleep');
    }
    clean(h);
  }
});

test('Titi S2 pulses every 0.1 s and refreshes enemies for 0.3 s', () => {
  for (const id of ids) {
    const { h, unit, bb } = scenario(id, 'skchr_titi_2', {
      enemies: [{ key: 'e_dummy', pos: [10, 5] }],
    });
    const target = h.b.enemies[0];
    const atk = unit.s.atk;
    activate(h, unit);
    close(unit.s.atk, atk * (1 + bb.atk));
    h.run(0.75);
    const pulses = statusEvents(h, target, unit).filter((c) => c.status === 'sleep');
    assert.ok(pulses.length >= 7, `at least seven pulses, got ${pulses.length}`);
    for (let i = 0; i < pulses.length; i++) {
      close(pulses[i].duration, 0.3);
      assert.equal(pulses[i].entered, i === 0, 'continuous sleep has one entry');
      if (i) close(pulses[i].t - pulses[i - 1].t, 0.1, TICK + 1e-6);
    }
    unit.skill.stop();
    h.run(0.4);
    assert.ok(!target.s.flags.sleep, 'the final short sleep expires after the aura ends');
    clean(h);
  }
});

test('Titi S2 aura uses enemy centre positions, including enemies with large hit areas', () => {
  const { h, unit } = scenario(ids[0], 'skchr_titi_2', {
    enemies: [{ key: 'e_dummy', pos: [10, 5] }, { key: 'e_dummy', pos: [10, 6] }],
  });
  const [inside, outside] = h.b.enemies;
  outside.hitArea = { w: 3, h: 1, dx: 0, dy: 0 };
  assert.ok(h.b.enemiesInRadius(unit.x, unit.y, 1.5).includes(outside), 'its body intersects the aura');
  assert.ok(!h.b.enemiesInRadius(unit.x, unit.y, 1.5, true).includes(outside), 'its centre does not');
  activate(h, unit);
  h.run(0.3);
  assert.ok(inside.s.flags.sleep);
  assert.ok(!outside.s.flags.sleep, 'body overlap alone must not receive sleep');
  clean(h);
});

test('Titi S2 ally slumber is distinct from sleep; cleansing it preserves the aura and forced disarm', () => {
  for (const id of ids) {
    const { h, unit } = scenario(id, 'skchr_titi_2', {
      disarm: false,
      chess: { t_hurt: ally('t_hurt'), t_fine: ally('t_fine') },
      units: [{ chessId: 't_hurt', row: 10, col: 6 }, { chessId: 't_fine', row: 11, col: 5 }],
      enemies: [{ key: 'e_dummy', pos: [10, 7] }],
    });
    const hurt = h.unit('t_hurt'), fine = h.unit('t_fine'), target = h.b.enemies[0];
    hurt.hp = hurt.s.maxHp * 0.2;
    fine.hp = fine.s.maxHp * 0.6;
    activate(h, unit);
    for (const chosen of [unit, hurt]) {
      assert.ok(chosen.buffs.some((b) => b.status === 'slumber'), 'selected ally has slumber');
      assert.equal(statusEvents(h, chosen, unit).filter((c) => c.status === 'sleep').length, 0,
        'ally slumber must not emit an enemy-sleep entry');
    }
    assert.ok(!fine.buffs.some((b) => b.status === 'slumber'));
    h.b.removeStatus(hurt, 'slumber');
    h.b.removeStatus(unit, 'slumber');
    assert.ok(unit.s.flags.disarm, 'S2 continues to disarm Titi after cleansing slumber');
    const start = h.b.time;
    h.run(1);
    assert.ok(target.s.flags.sleep, 'the cleansed ally retains its aura');
    assert.ok(statusEvents(h, target, unit).filter((c) => c.t > start && c.status === 'sleep').length >= 9);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === unit && c.t > start).length, 0);
    unit.skill.stop();
    h.run(0.4);
    assert.ok(!target.s.flags.sleep);
    for (const chosen of [unit, hurt]) assert.ok(!chosen.buffs.some((b) => b.status === 'slumber'));
    clean(h);
  }
});

test('Titi S2 aura covers the full surrounding 3x3 grid using centre tile boundaries', () => {
  const { h, unit } = scenario(ids[0], 'skchr_titi_2', {
    enemies: [{ key: 'e_dummy', pos: [11, 5] }, { key: 'e_dummy', pos: [10, 6] }],
  });
  const [corner, outside] = h.b.enemies;
  corner.x = unit.x + 1.4;
  corner.y = unit.y + 1.4;
  outside.x = unit.x + 1.51;
  outside.y = unit.y;
  assert.ok(Math.hypot(corner.x - unit.x, corner.y - unit.y) > 1.5, 'corner lies beyond a radius-1.5 circle');
  activate(h, unit);
  assert.ok(corner.s.flags.sleep, 'the diagonal neighbour tile belongs to the aura');
  assert.ok(!outside.s.flags.sleep, 'a centre beyond the neighbour tile edge is outside');
  h.run(0.4);
  assert.ok(corner.s.flags.sleep && !outside.s.flags.sleep, 'later pulses use the same tile area');
  clean(h);
});

test('Titi S2 shared ally slumber survives until both Titi sources finish', () => {
  const skillIndex = ds.rawChess(ids[0]).skills.find((s) => s.skillId === 'skchr_titi_2').index;
  const { h, unit } = scenario(ids[0], 'skchr_titi_2', {
    chess: { t_hurt: ally('t_hurt') },
    units: [{ chessId: ids[0], row: 11, col: 4, skillIndex }, { chessId: 't_hurt', row: 10, col: 5 }],
  });
  const second = h.unit(2), shared = h.unit('t_hurt');
  assert.notEqual(second, unit);
  shared.hp = shared.s.maxHp * 0.2;
  activate(h, unit);
  activate(h, second);
  assert.ok(shared.s.flags.slumber);
  unit.skill.stop();
  assert.ok(shared.s.flags.slumber, 'ending one source must not remove the other source slumber');
  assert.equal(h.b.dealDamage(null, shared, { amount: 1e9, type: 'true' }), 0);
  second.skill.stop();
  assert.ok(!shared.s.flags.slumber, 'the last source releases the shared slumber');
  clean(h);
});

test('Titi S2 does not revive an old ally aura when its carrier retreats and redeploys', () => {
  const { h, unit } = scenario(ids[0], 'skchr_titi_2', {
    chess: { t_hurt: ally('t_hurt') }, units: [{ chessId: 't_hurt', row: 10, col: 6 }],
    enemies: [{ key: 'e_dummy', pos: [10, 7] }],
  });
  const carrier = h.unit('t_hurt'), target = h.b.enemies[0];
  carrier.hp = carrier.s.maxHp * 0.2;
  activate(h, unit);
  h.run(0.2);
  assert.ok(target.s.flags.sleep, 'the selected ally initially carries its aura');
  const departedAt = h.b.time;
  h.b.retreat(carrier);
  assert.equal(h.b.redeploy(carrier, { free: true }), true);
  assert.ok(carrier.alive && carrier.deployed && unit.skill.active);
  h.run(0.5);
  assert.ok(!target.s.flags.sleep, 'redeploying the same carrier object cannot restore its old aura');
  assert.equal(statusEvents(h, target, unit).filter((c) => c.t > departedAt && c.status === 'sleep').length, 0);
  clean(h);
});

test('Titi S2 successful sleep refreshes rapidly reach the 24 / 48 per-battle precision cap', (t) => {
  for (const id of ids) for (const auraCount of [1, 2]) {
    const bond = { count: 3, active: true, tier: 1, layers: 0 };
    const { h, unit } = scenario(id, 'skchr_titi_2', {
      chess: auraCount === 2 ? { t_ally: ally('t_ally') } : {},
      units: auraCount === 2 ? [{ chessId: 't_ally', row: 10, col: 6 }] : [],
      enemies: [{ key: 'e_dummy', pos: [10, 5] }], bonds: { preciShip: bond },
    });
    const target = h.b.enemies[0];
    const garrison = data.garrisons[ds.rawChess(id).garrisonIds[0]];
    const perApplication = garrison.bb.bond_add_count;
    const cap = garrison.bb.max_add_count_per_battle;
    const expectedSeconds = auraCount === 1 ? 2.3 : 1.1;
    const started = activate(h, unit);
    assert.equal(gains(h), auraCount * perApplication, 'the opening enemy pulses count, but friendly slumber does not');
    assert.ok(h.runUntil(() => gains(h) === cap, expectedSeconds + 2 * TICK));
    const layerEvents = h.hooksOf('layerGain').filter((c) => c.source === unit && c.bondId === 'preciShip');
    assert.equal(layerEvents.reduce((sum, c) => sum + c.n, 0), cap);
    const cappedAt = layerEvents.at(-1).t - started;
    close(cappedAt, expectedSeconds, TICK + 1e-6);
    const applied = statusEvents(h, target, unit).filter((c) => c.status === 'sleep');
    assert.equal(applied.filter((c) => c.entered).length, 1, 'the generic status entry signal remains unchanged');
    assert.ok(applied.filter((c) => !c.entered).length >= 23, 'successful continuous refreshes contribute layers');
    h.run(16);
    assert.equal(gains(h), cap, 'later pulses cannot exceed the per-battle limit');
    assert.equal(h.hooksOf('layerGain').filter((c) => c.source === unit && c.bondId === 'preciShip').length, layerEvents.length);
    t.diagnostic(`${id}: ${auraCount} aura(s), ${cap} layers reached after ${cappedAt.toFixed(3)} s`);
    clean(h);
  }
});

test('Titi S2 precision gains require successful sleep, attack-range coverage, and an active bond', () => {
  for (const kind of ['immune', 'outside', 'inactive']) {
    const bond = { count: 3, active: kind !== 'inactive', tier: kind === 'inactive' ? 0 : 1, layers: 0 };
    const { h, unit } = scenario(ids[0], 'skchr_titi_2', {
      chess: kind === 'outside' ? { t_ally: ally('t_ally') } : {},
      units: kind === 'outside' ? [{ chessId: 't_ally', row: 10, col: 7 }] : [],
      enemyDefs: { e_target: dummy('e_target', { immunities: { sleep: kind === 'immune' } }) },
      enemies: [{ key: 'e_target', pos: [10, kind === 'outside' ? 8 : 5] }],
      bonds: { preciShip: bond },
    });
    const target = h.b.enemies[0];
    activate(h, unit);
    h.run(3);
    assert.equal(gains(h), 0, `${kind}: no precision layers`);
    if (kind === 'immune') assert.ok(!target.s.flags.sleep, 'immune targets reject every aura pulse');
    else assert.ok(statusEvents(h, target, unit).filter((c) => c.status === 'sleep').length >= 30,
      `${kind}: the aura still successfully applies sleep`);
    clean(h);
  }
});

test('Titi T1 starts at 0.5 s, repeats every second, and resets on both skill transitions', () => {
  for (const id of ids) {
    const { h, unit } = scenario(id, 'skchr_titi_1');
    const target = h.b.enemies[0];
    h.b.applyStatus(target, 'sleep', { duration: 50 });
    assert.ok(h.runUntil(() => damage(h, unit, 'titiDream', target).length >= 2, 2));
    const [first, second] = damage(h, unit, 'titiDream', target);
    close(first.t, 0.5, TICK + 1e-6);
    close(second.t - first.t, 1, TICK + 1e-6);
    h.run(0.2);
    const skillStart = activate(h, unit);
    const beforeStart = damage(h, unit, 'titiDream', target).length;
    h.run(0.4);
    assert.equal(damage(h, unit, 'titiDream', target).length, beforeStart);
    assert.ok(h.runUntil(() => damage(h, unit, 'titiDream', target).length > beforeStart, 0.2));
    close(damage(h, unit, 'titiDream', target).at(-1).t - skillStart, 0.5, TICK + 1e-6);
    h.run(0.2);
    const skillEnd = h.b.time;
    unit.skill.stop();
    const beforeEnd = damage(h, unit, 'titiDream', target).length;
    h.run(0.4);
    assert.equal(damage(h, unit, 'titiDream', target).length, beforeEnd);
    assert.ok(h.runUntil(() => damage(h, unit, 'titiDream', target).length > beforeEnd, 0.2));
    close(damage(h, unit, 'titiDream', target).at(-1).t - skillEnd, 0.5, TICK + 1e-6);
    clean(h);
  }
});

test('Titi S3 includes pre-existing sleep, but only accumulates sleep during this activation', () => {
  for (const id of ids) {
    const { h, unit, bb } = scenario(id, 'skchr_titi_3');
    const target = h.b.enemies[0];
    h.b.applyStatus(target, 'sleep', { duration: 30 });
    h.run(2);
    const start = activate(h, unit);
    const atk = unit.s.atk;
    h.run(1);
    h.b.removeStatus(target, 'sleep');
    assert.ok(h.runUntil(() => damage(h, unit, 'titiWake', target).length > 0, 0.2));
    const wake = damage(h, unit, 'titiWake', target)[0];
    const tolerance = atk * (bb.max_atk_scale - bb.min_atk_scale) * (2 * TICK) / 5 + 1e-6;
    close(wake.amount, expectedWake(bb, atk, wake.t - start), tolerance);
    clean(h);
  }
});

test('Titi T1 starts a separate 0.5 s detection phase for an enemy that spawns later', () => {
  const { h, unit } = scenario(ids[0], 'skchr_titi_1');
  const original = h.b.enemies[0];
  h.b.applyStatus(original, 'sleep', { duration: 30 });
  h.run(0.8);
  const spawnedAt = h.b.time;
  const late = h.spawn('e_dummy', { pos: [11, 6] });
  h.b.applyStatus(late, 'sleep', { duration: 30 });
  h.run(0.4);
  assert.equal(damage(h, unit, 'titiDream', late).length, 0);
  assert.ok(h.runUntil(() => damage(h, unit, 'titiDream', late).length === 1, 0.2));
  const first = damage(h, unit, 'titiDream', late)[0];
  close(first.t - spawnedAt, 0.5, TICK + 1e-6);
  assert.ok(h.runUntil(() => damage(h, unit, 'titiDream', late).length === 2, 1.1));
  close(damage(h, unit, 'titiDream', late)[1].t - first.t, 1, TICK + 1e-6);
  clean(h);
});

test('Titi T1 extra damage includes ordinary splash damage but does not recur from DoT', () => {
  for (const id of ids) {
    const { h, unit } = scenario(id, 'skchr_titi_1');
    const target = h.b.enemies[0];
    const talent = unit.def.raw.talents.find((t) => t.index === 0).bb;
    h.b.dealDamage(unit, target, { amount: 100, type: 'arts', isSplash: true, tags: ['test:splash'] });
    const extra = damage(h, unit, 'titiStill', target);
    assert.equal(extra.length, 1, 'normal splash damage triggers the stationary-target rider');
    close(extra[0].amount, unit.s.atk * talent.extra_atk_scale);
    h.b.dealDamage(unit, target, { amount: 100, type: 'arts', tags: ['dot', 'test:dot'] });
    assert.equal(damage(h, unit, 'titiStill', target).length, 1, 'a DoT cannot trigger another rider');
    clean(h);
  }
});

test('Titi S3 ends tracked sleep exactly once on skill end, after its ATK bonus is removed', () => {
  for (const id of ids) {
    const { h, unit, bb } = scenario(id, 'skchr_titi_3');
    const target = h.b.enemies[0];
    h.b.applyStatus(target, 'sleep', { duration: 30 });
    const atk = unit.s.atk;
    const start = activate(h, unit);
    h.run(1);
    const end = h.b.time;
    unit.skill.stop();
    const wakes = damage(h, unit, 'titiWake', target);
    assert.equal(wakes.length, 1, 'ending the skill releases a target that is still sleeping');
    close(unit.s.atk, atk);
    const tolerance = atk * (bb.max_atk_scale - bb.min_atk_scale) * (2 * TICK) / 5 + 1e-6;
    close(wakes[0].amount, expectedWake(bb, atk, end - start), tolerance);
    h.run(0.5);
    assert.equal(damage(h, unit, 'titiWake', target).length, 1, 'the tail burst cannot repeat');
    clean(h);
  }
});

for (const exit of ['retreat', 'kill']) {
  test(`Titi S3 transfers sleep without a wake burst on ${exit}`, () => {
    for (const id of ids) {
      const { h, unit, bb } = scenario(id, 'skchr_titi_3', {
        enemies: [{ key: 'e_dummy', pos: [10, 6] }, { key: 'e_dummy', pos: [10, 7] }],
      });
      const [source, next] = h.b.enemies;
      h.b.applyStatus(source, 'sleep', { duration: 30 });
      activate(h, unit);
      h.run(1);
      if (exit === 'retreat') h.b.retreat(unit, { permanent: true });
      else h.b.kill(source, unit);
      assert.equal(damage(h, unit, 'titiWake', source).length, 0);
      assert.ok(next.s.flags.sleep, 'the tracked sleep still propagates');
      const transfers = statusEvents(h, next, unit).filter((c) => c.status === 'sleep');
      assert.equal(transfers.length, 1);
      close(transfers[0].duration, bb.sleep);
      h.run(0.3);
      assert.equal(damage(h, unit, 'titiWake', source).length, 0);
      clean(h);
    }
  });
}

test('Titi S3 sleep transfer prefers an awake enemy over a sleeping enemy with higher taunt', () => {
  const { h, unit, bb } = scenario(ids[0], 'skchr_titi_3', {
    enemyDefs: { e_taunt: dummy('e_taunt', { taunt: 5 }) },
    enemies: [{ key: 'e_dummy', pos: [10, 6] }, { key: 'e_dummy', pos: [10, 7] }, { key: 'e_taunt', pos: [11, 7] }],
  });
  const [source, awake, sleeping] = h.b.enemies;
  h.b.applyStatus(source, 'sleep', { duration: 30 });
  h.b.applyStatus(sleeping, 'sleep', { duration: 30 });
  activate(h, unit);
  h.run(0.3);
  h.b.removeStatus(source, 'sleep');
  assert.ok(h.runUntil(() => damage(h, unit, 'titiWake', source).length > 0, 0.2));
  assert.ok(awake.s.flags.sleep);
  assert.equal(statusEvents(h, sleeping, unit).filter((c) => c.status === 'sleep').length, 0);
  close(statusEvents(h, awake, unit).find((c) => c.status === 'sleep').duration, bb.sleep);
  clean(h);
});

test('Titi S3 transfer can refresh a sleeping enemy and excludes immune enemies before ranking', () => {
  const { h, unit, bb } = scenario(ids[1], 'skchr_titi_3', {
    enemyDefs: {
      e_immune: dummy('e_immune', { taunt: 100, immunities: { sleep: true } }),
      e_taunt: dummy('e_taunt', { taunt: 5 }),
    },
    enemies: [{ key: 'e_dummy', pos: [10, 6] }, { key: 'e_immune', pos: [10, 7] }, { key: 'e_taunt', pos: [11, 7] }],
  });
  const [source, immune, sleeping] = h.b.enemies;
  assert.ok(immune.def.immune.has('sleep'));
  h.b.applyStatus(source, 'sleep', { duration: 30 });
  h.b.applyStatus(sleeping, 'sleep', { duration: 30 });
  activate(h, unit);
  h.run(0.3);
  h.b.removeStatus(source, 'sleep');
  assert.ok(h.runUntil(() => damage(h, unit, 'titiWake', source).length > 0, 0.2));
  const transferred = statusEvents(h, sleeping, unit).filter((c) => c.status === 'sleep');
  assert.equal(transferred.length, 1, 'a sleeping eligible enemy remains a valid fallback');
  assert.equal(transferred[0].entered, false);
  close(transferred[0].duration, bb.sleep);
  assert.ok(!immune.s.flags.sleep);
  clean(h);
});

test('Titi S3 ally guard is slumber and releases its protection when slumber is cleansed', () => {
  const { h, unit } = scenario(ids[0], 'skchr_titi_3', {
    chess: { t_ally: ally('t_ally') }, units: [{ chessId: 't_ally', row: 10, col: 5 }],
  });
  const target = h.unit('t_ally');
  activate(h, unit);
  h.b.dealDamage(null, target, { amount: 1e9, type: 'true' });
  assert.ok(target.alive);
  assert.ok(target.buffs.some((b) => b.status === 'slumber'));
  assert.equal(statusEvents(h, target, unit).filter((c) => c.status === 'sleep').length, 0);
  assert.ok(unit.profile.hitSleep);
  const hp = target.hp;
  assert.equal(h.b.dealDamage(unit, target, { amount: 100, type: 'true', ignoreSleep: true }), 0,
    'hitSleep and ignoreSleep do not bypass the slumber invulnerability');
  assert.equal(target.hp, hp);
  h.b.removeStatus(target, 'slumber');
  h.run(0.3);
  assert.ok(!target.findBuff('titi:allySleep'), 'cleansing slumber ends the current rescue');
  clean(h);
});

test('Titi S3 does not settle a tracked sleeper twice when another wake burst kills it reentrantly', () => {
  const { h, unit } = scenario(ids[0], 'skchr_titi_3', {
    enemies: [{ key: 'e_dummy', pos: [10, 6] }, { key: 'e_dummy', pos: [10, 7] }, { key: 'e_dummy', pos: [10, 8] }],
  });
  const [first, killedDuringWake, next] = h.b.enemies;
  h.b.applyStatus(first, 'sleep', { duration: 30 });
  h.b.applyStatus(killedDuringWake, 'sleep', { duration: 30 });
  activate(h, unit);
  h.run(0.2);
  h.b.on('damaged', (c) => {
    if (c.source === unit && c.target === first && c.dmg.tags.includes('titiWake')) h.b.kill(killedDuringWake, unit);
  });
  h.b.removeStatus(first, 'sleep');
  h.b.removeStatus(killedDuringWake, 'sleep');
  assert.ok(h.runUntil(() => damage(h, unit, 'titiWake', first).length === 1, 0.2));
  assert.ok(!killedDuringWake.alive);
  assert.ok(first.s.flags.sleep, 'the killed sleeper transfers once to the earlier equally ranked enemy');
  assert.ok(!next.s.flags.sleep, 'the stale outer iteration must not perform a second transfer');
  assert.equal(statusEvents(h, first, unit).filter((c) => c.status === 'sleep').length, 1);
  assert.equal(statusEvents(h, next, unit).filter((c) => c.status === 'sleep').length, 0);
  h.run(0.1);
  h.b.removeStatus(first, 'sleep');
  assert.ok(h.runUntil(() => damage(h, unit, 'titiWake', first).length === 2, 0.2),
    'the newly transferred sleep is tracked again on a later check');
  clean(h);
});

test('Titi T1 does not damage sleeping enemies while they are stealthed or untargetable', () => {
  const { h, unit } = scenario(ids[0], 'skchr_titi_1', {
    enemies: [{ key: 'e_dummy', pos: [10, 6] }, { key: 'e_dummy', pos: [11, 6] }, { key: 'e_dummy', pos: [12, 6] }],
  });
  const [visible, stealthed, untargetable] = h.b.enemies;
  for (const target of h.b.enemies) h.b.applyStatus(target, 'sleep', { duration: 30 });
  h.b.applyStatus(stealthed, 'stealth', { duration: 30 });
  h.b.addBuff(untargetable, { key: 'test:untargetable', flags: { untargetable: true } });
  h.run(1.6);
  assert.ok(damage(h, unit, 'titiDream', visible).length >= 2, 'a visible sleeping enemy receives the DoT');
  assert.equal(damage(h, unit, 'titiDream', stealthed).length, 0);
  assert.equal(damage(h, unit, 'titiDream', untargetable).length, 0);
  h.b.applyStatus(stealthed, 'reveal', { duration: 30 });
  assert.ok(stealthed.s.flags.stealth && stealthed.s.flags.reveal, 'reveal suppresses an existing stealth effect');
  h.b.removeBuff(untargetable, untargetable.findBuff('test:untargetable'));
  h.run(1);
  assert.equal(damage(h, unit, 'titiDream', stealthed).length, 1, 'revealed stealth resumes damage on the next detection');
  assert.equal(damage(h, unit, 'titiDream', untargetable).length, 1);
  clean(h);
});
