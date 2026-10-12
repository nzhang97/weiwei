import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Unit } from '../server/sim/units.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

const data = getData();
const stats = ['atk', 'def', 'maxHp'];
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7,
  `${actual} should equal ${expected}`);

function unit(nerf, { boost = false, kind = 'op', side = 'ally' } = {}) {
  const u = new Unit({ id: 1, side, kind, aiRound34Nerf: nerf, aiOperatorBuff: boost,
    base: { maxHp: 1000, atk: 100, def: 80, res: 20, aspd: 100, blockCnt: 2, moveSpeed: 1 } });
  u.buffs.push({ key: 'equipment', stacks: 1,
    mods: { atkFlat: 40, defFlat: 20, hpFlat: 200, atkPct: .5, defPct: .25, hpPct: .4 } });
  u.buffs.push({ key: 'skill', stacks: 1,
    mods: { atkPct: .7, atkMul: 1.3, defMul: 1.5, hpMul: 1.2 } });
  return u;
}

function match(enabled, overrides = {}) {
  return new Match({ mode: 'coop', difficulty: 'NORMAL', aiRound34Nerf: enabled, data,
    seats: [
      { seat: 0, playerId: 'human', name: 'Human', isBot: false, connected: true },
      { seat: 1, playerId: 'bot', name: 'AI', isBot: true, connected: true },
    ],
    scheduler: new VirtualScheduler(), send() {}, broadcast() {}, onEnd() {}, ...overrides });
}

test('round 3/4 AI nerf multiplies final dynamic stats by 0.2 and keeps the current HP ratio', () => {
  const plain = unit(false), weak = unit(true);
  plain.hp = plain.s.maxHp / 2;
  weak.hp = weak.s.maxHp / 2;
  const check = () => {
    for (const key of stats) approx(weak.s[key], plain.s[key] * .2);
    for (const key of ['res', 'aspd', 'blockCnt', 'moveSpeed', 'interval']) {
      assert.equal(weak.s[key], plain.s[key], key);
    }
    approx(weak.hpRatio, .5);
    approx(plain.hpRatio, .5);
    approx(weak.hp, plain.hp * .2);
  };
  check();
  approx(weak.s.atk, (100 + 40) * (1 + .5 + .7) * 1.3 * .2);
  for (const u of [plain, weak]) {
    u.buffs.push({ key: 'later-skill', stacks: 1,
      mods: { atkFlat: 50, atkPct: 1, atkMul: 1.1, defPct: .5, hpFlat: 300, hpMul: 1.5 } });
    u.markDirty();
  }
  check();
  for (const u of [plain, weak]) { u.buffs.pop(); u.markDirty(); }
  check();
});

test('AI boost is included before the 80 percent reduction, while non-operators are not directly reduced', () => {
  const plain = unit(false), boosted = unit(false, { boost: true });
  const weakBoosted = unit(true, { boost: true });
  for (const key of stats) {
    approx(weakBoosted.s[key], boosted.s[key] * .2);
    approx(weakBoosted.s[key], plain.s[key] * .4);
  }
  assert.deepEqual(unit(undefined).s, plain.s);
  for (const [kind, side] of [['token', 'ally'], ['device', 'ally'], ['enemy', 'enemy'], ['op', 'enemy']]) {
    assert.deepEqual(unit(true, { kind, side }).s, unit(false, { kind, side }).s, `${side} ${kind}`);
  }
});

test('only true AI players are reduced in rounds 3 and 4, restoring round 5 and leaving humans unchanged', () => {
  const m = match(true, { aiOperatorBuff: true, humanOperatorBuff: true });
  const off = match(undefined);
  const solo = match(true, { mode: 'solo' });
  try {
    assert.equal(m.aiRound34Nerf, true);
    assert.equal(off.aiRound34Nerf, false);
    assert.equal(solo.aiRound34Nerf, false);
    const human = m.players.get('human');
    human.autoplay = true;
    human.connected = false;
    for (let round = 1; round <= 18; round++) {
      m.round = round;
      off.round = round;
      const h = human.battleInput(), bot = m.players.get('bot').battleInput();
      assert.equal(bot.aiRound34Nerf, round === 3 || round === 4, `round ${round}`);
      assert.equal(h.aiRound34Nerf, false, `autoplay human round ${round}`);
      assert.equal(off.players.get('bot').battleInput().aiRound34Nerf, false);
      assert.equal(bot.aiOperatorBuff, true);
      assert.equal(h.aiOperatorBuff, false);
      assert.equal(bot.humanOperatorBuffMul, 1);
      approx(h.humanOperatorBuffMul, 1 + Math.max(10, 160 - round * 10) / 100);
    }
  } finally { m.dispose(); off.dispose(); solo.dispose(); }
});

test('AI round nerf survives all BattleSpec replicas and redeployments without leaking to later rounds or humans', () => {
  const m = match(true, { aiOperatorBuff: true, humanOperatorBuff: true });
  const off = match(false, { aiOperatorBuff: true, humanOperatorBuff: true });
  try {
    for (const owner of [m, off]) for (const [i, p] of owner.order.entries()) {
      p.board.set(`9,${4 + i}`, p.newPiece('chess', 'chess_char_1_01_a'));
    }
    m.players.get('human').autoplay = true;
    for (const round of [2, 3, 4, 5]) {
      m.round = round;
      off.round = round;
      for (const kind of ['normal', 'unite', 'boss', 'hidden']) {
        const makeSpec = owner => buildBattleSpec({ kind, round,
          players: owner.order.map((p, i) => p.battleInput({ side: i ? 'R' : 'L', colOffset: kind === 'unite' ? i * 8 : 0 })),
          seed: 12, stageId: owner.stageId, content: 'none', timeLimit: 10 });
        const spec = makeSpec(m);
        const b = createBattleFromSpec(spec, data);
        const replica = createBattleFromSpec(JSON.parse(JSON.stringify(spec)), data);
        const baseline = createBattleFromSpec(makeSpec(off), data);
        for (const battle of [b, replica, baseline]) battle.start();
        for (const ownerId of ['human', 'bot']) {
          const u = b.allyUnits.find(u => u.ownerId === ownerId);
          const mirror = replica.allyUnits.find(u => u.ownerId === ownerId);
          const original = baseline.allyUnits.find(u => u.ownerId === ownerId);
          const reduced = ownerId === 'bot' && (round === 3 || round === 4);
          assert.ok(u && mirror && original, `${kind} ${ownerId} round ${round}`);
          for (const deployed of [u, mirror, original]) {
            assert.equal(deployed.deployed, true, `${kind} ${ownerId} round ${round}`);
          }
          assert.equal(u.aiRound34Nerf, reduced);
          for (const key of stats) {
            approx(u.s[key], original.s[key] * (reduced ? .2 : 1));
            approx(u.s[key], mirror.s[key]);
          }
          approx(u.hpRatio, 1);
          const before = { ...u.s };
          b.kill(u);
          assert.equal(b.redeploy(u, { free: true }), true);
          assert.equal(u.aiRound34Nerf, reduced);
          for (const key of stats) approx(u.s[key], before[key]);
          approx(u.hpRatio, 1);
        }
      }
    }
  } finally { m.dispose(); off.dispose(); }
});

test('AI round nerf room option defaults off, synchronizes, resets ready, requires the host and locks at start', async () => {
  const srv = await startServer({ port: 0, quiet: true });
  const clients = [];
  try {
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const host = await TestClient.connect(url); clients.push(host);
    const guest = await TestClient.connect(url); clients.push(guest);
    const h = await host.hello('Host'); await guest.hello('Guest');
    await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const state = await host.waitFor('room.state');
    assert.equal(state.aiRound34Nerf, false);
    await guest.request({ t: 'room.join', code: state.code });
    assert.equal((await guest.request({ t: 'room.setAiRound34Nerf', enabled: true })).code, ERR.NOT_HOST);
    await guest.request({ t: 'room.ready', ready: true });
    assert.equal((await host.request({ t: 'room.setAiRound34Nerf', enabled: true })).t, 'ok');
    const changed = await guest.waitFor('room.state', s => s.aiRound34Nerf === true);
    assert.equal(changed.seats.find(s => s && s.playerId !== h.playerId).ready, false);
    assert.equal(changed.aiOperatorBuff, false);
    assert.equal(changed.humanOperatorBuff, false);
    await host.request({ t: 'room.addBot' });
    await guest.request({ t: 'room.ready', ready: true });
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    const room = srv.lobby.getRoom(state.code);
    assert.equal(room.match.aiRound34Nerf, true);
    assert.equal(room.match.order.find(p => p.isBot).battleInput().aiRound34Nerf, false);
    assert.equal((await host.request({ t: 'room.setAiRound34Nerf', enabled: false })).code, ERR.ROOM_STARTED);
  } finally {
    for (const c of clients) c.ws.terminate();
    await srv.close();
  }
});

test('AI round nerf protocol rejects missing and non-boolean values, non-room requests and solo rooms', async () => {
  const srv = await startServer({ port: 0, quiet: true });
  let host;
  try {
    host = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    await host.hello('Host');
    assert.equal((await host.request({ t: 'room.setAiRound34Nerf', enabled: true })).code, ERR.NOT_IN_ROOM);
    await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const state = await host.waitFor('room.state');
    for (const enabled of [undefined, null, 0, 1, 'true', {}, []]) {
      assert.equal((await host.request({ t: 'room.setAiRound34Nerf', enabled })).code, ERR.BAD_MSG);
      assert.equal(srv.lobby.getRoom(state.code).aiRound34Nerf, false);
    }
    assert.equal((await host.request({ t: 'room.setAiRound34Nerf', enabled: true })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setAiRound34Nerf', enabled: false })).t, 'ok');
    assert.equal(srv.lobby.getRoom(state.code).aiRound34Nerf, false);
    await host.request({ t: 'room.leave' });
    await host.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal((await host.request({ t: 'room.setAiRound34Nerf', enabled: true })).code, ERR.BAD_MSG);
  } finally {
    host?.ws.terminate();
    await srv.close();
  }
});
