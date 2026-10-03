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
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} ≈ ${b}`);
function unit(boost, kind = 'op', side = 'ally') {
  const u = new Unit({ id: 1, side, kind, aiOperatorBuff: boost,
    base: { maxHp: 1000, atk: 100, def: 80, res: 20, aspd: 100 } });
  u.buffs.push({ key: 'equipment', stacks: 1, mods: { atkFlat: 40, defFlat: 20, hpFlat: 200, atkPct: .5, defPct: .25, hpPct: .4 } });
  u.buffs.push({ key: 'skill', stacks: 1, mods: { atkPct: .7, atkMul: 1.3, defMul: 1.5, hpMul: 1.2 } });
  return u;
}

test('AI boost doubles final flat, additive and multiplicative stats, including later skill buffs', () => {
  const plain = unit(false), boosted = unit(true);
  for (const key of ['atk', 'def', 'maxHp']) approx(boosted.s[key], plain.s[key] * 2);
  approx(boosted.s.atk, (100 + 40) * (1 + .5 + .7) * 1.3 * 2);
  assert.equal(boosted.s.res, plain.s.res);
  assert.equal(boosted.s.aspd, plain.s.aspd);
  boosted.alive = true; boosted.hp = boosted.s.maxHp / 2;
  for (const u of [plain, boosted]) {
    u.buffs.push({ key: 'new-skill', stacks: 1, mods: { atkFlat: 50, atkPct: 1, defPct: .5, hpPct: .6 } });
    u.markDirty();
  }
  for (const key of ['atk', 'def', 'maxHp']) approx(boosted.s[key], plain.s[key] * 2);
  approx(boosted.hpRatio, .5);
  for (const u of [plain, boosted]) { u.buffs.pop(); u.markDirty(); }
  for (const key of ['atk', 'def', 'maxHp']) approx(boosted.s[key], plain.s[key] * 2);
});

test('disabled option, summons, devices and enemies are not directly boosted', () => {
  for (const [kind, side] of [['token', 'ally'], ['device', 'ally'], ['enemy', 'enemy']]) {
    const plain = unit(false, kind, side), boosted = unit(true, kind, side);
    assert.deepEqual(boosted.s, plain.s);
  }
});

function match(enabled) {
  return new Match({ mode: 'coop', difficulty: 'NORMAL', aiOperatorBuff: enabled, data,
    seats: [ { seat: 0, playerId: 'human', name: 'Human', isBot: false, connected: true },
      { seat: 1, playerId: 'bot', name: 'AI', isBot: true, connected: true } ],
    scheduler: new VirtualScheduler(), send() {}, broadcast() {}, onEnd() {} });
}

test('match option enters AI-only BattleSpecs and stays exact through replicas and redeployment', () => {
  const m = match(true), off = match(false);
  try {
    for (const ps of m.order) {
      const piece = ps.newPiece('chess', 'chess_char_1_01_a');
      ps.board.set('9,4', piece);
    }
    const human = m.players.get('human'); human.autoplay = true;
    assert.equal(human.battleInput().aiOperatorBuff, false);
    assert.equal(off.players.get('bot').battleInput().aiOperatorBuff, false);
    for (const kind of ['normal', 'unite', 'boss', 'hidden']) {
      const players = m.order.map((ps, i) => ps.battleInput({ side: i ? 'R' : 'L', colOffset: kind === 'unite' ? i * 8 : 0 }));
      const spec = buildBattleSpec({ kind, players, seed: 12, stageId: m.stageId, content: 'none', timeLimit: 10 });
      const b = createBattleFromSpec(JSON.parse(JSON.stringify(spec)), data);
      const replica = createBattleFromSpec(spec, data);
      b.start(); replica.start();
      const bot = b.allyUnits.find(u => u.ownerId === 'bot');
      const player = b.allyUnits.find(u => u.ownerId === 'human');
      assert.ok(bot && player);
      for (const key of ['atk', 'def', 'maxHp']) {
        approx(bot.s[key], player.s[key] * 2);
        approx(bot.s[key], replica.allyUnits.find(u => u.ownerId === 'bot').s[key]);
      }
      const before = { ...bot.s };
      b.kill(bot); b.redeploy(bot, { free: true });
      for (const key of ['atk', 'def', 'maxHp']) approx(bot.s[key], before[key]);
    }
  } finally { m.dispose(); off.dispose(); }
});

test('room option is off by default, host-only, synchronized and locked after start', async () => {
  const srv = await startServer({ port: 0, quiet: true });
  const clients = [];
  try {
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const host = await TestClient.connect(url); clients.push(host);
    const guest = await TestClient.connect(url); clients.push(guest);
    const h = await host.hello('Host'); await guest.hello('Guest');
    await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const state = await host.waitFor('room.state');
    assert.equal(state.aiOperatorBuff, false);
    await guest.request({ t: 'room.join', code: state.code });
    const denied = await guest.request({ t: 'room.setAiOperatorBuff', enabled: true });
    assert.equal(denied.code, ERR.NOT_HOST);
    await guest.request({ t: 'room.ready', ready: true });
    assert.equal((await host.request({ t: 'room.setAiOperatorBuff', enabled: true })).t, 'ok');
    const changed = await guest.waitFor('room.state', s => s.aiOperatorBuff === true);
    assert.equal(changed.seats.find(s => s && s.playerId !== h.playerId).ready, false);
    await host.request({ t: 'room.addBot' });
    await guest.request({ t: 'room.ready', ready: true });
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    const room = srv.lobby.getRoom(state.code);
    assert.equal(room.match.aiOperatorBuff, true);
    assert.equal(room.match.order.find(p => p.isBot).battleInput().aiOperatorBuff, true);
    assert.equal((await host.request({ t: 'room.setAiOperatorBuff', enabled: false })).code, ERR.ROOM_STARTED);
  } finally {
    for (const c of clients) c.ws.terminate();
    await srv.close();
  }
});

