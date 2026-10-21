// 每轮自选 (server option SP_FREE_PICK, the launcher's checkbox; default off): one free pick per round for a human seat,
// unused picks carry over (no cap); any operator of the shared pool (not banned, a copy left) whose tier ≤ the shop
// level; the copy comes out of the shared pool like a purchase; AI seats get none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { Lobby } from '../../server/lobby.js';
import { makeMatch } from './harness.js';

const candidatesOf = (ps) => ps.freePickCandidates();

test('off by default: no picks, no view fields, g.freePick refused', () => {
  const h = makeMatch({ mode: 'solo', seed: 3 }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  assert.equal(h.m.freePick, false);
  assert.equal(ps.freePicks ?? 0, 0);
  const shop = ps.privateView().shop;
  assert.equal('freePicks' in shop, false);
  assert.equal('freePickCands' in shop, false);
  assert.deepEqual(candidatesOf(ps), []);
  const any = [...h.m.pool.entries.keys()][0];
  assert.equal(h.m.handle('p_0', { t: 'g.freePick', chessId: any }).error, ERR.WRONG_PHASE);
  h.m.dispose();
});

test('one pick per round, carried over without a cap; free; takes a shared-pool copy; tier ≤ shop level', () => {
  const h = makeMatch({ mode: 'solo', seed: 5, freePick: true }).start();
  h.toPrep(1);
  const m = h.m, ps = h.ps('p_0');
  assert.equal(ps.freePicks, 1, 'R1: one pick');
  const view = ps.privateView().shop;
  assert.equal(view.freePicks, 1);
  assert.ok(Array.isArray(view.freePickCands) && view.freePickCands.length > 0);
  for (const id of view.freePickCands) {
    assert.ok(m.gd.tierOf(id) <= ps.shop.level, `${id} tier ≤ level`);
    assert.ok(m.pool.has(id) && m.pool.left(id) > 0);
    assert.equal(m.gd.baseIdOf(id), id);
  }
  // a tier above the shop level is refused
  const high = [...m.pool.entries.entries()].find(([, e]) => e.tier > ps.shop.level && e.left > 0)?.[0];
  assert.ok(high, 'a higher-tier operator exists');
  assert.equal(m.handle('p_0', { t: 'g.freePick', chessId: high }).error, ERR.BAD_TARGET);
  assert.equal(ps.freePicks, 1, 'a refused pick is not spent');
  // carry over: skip R1's pick, R2 has two
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(ps.freePicks, 2, 'R2: the unused R1 pick carried over');
  h.drive(() => m.phase === PHASE.PREP && m.round === 3);
  assert.equal(ps.freePicks, 3, 'R3: no cap');
  // a pick: free, from the shared pool, into the hand
  const id = candidatesOf(ps)[0];
  const left0 = m.pool.left(id), funds0 = ps.funds, owned0 = ps.countCopies(id);
  assert.deepEqual(m.handle('p_0', { t: 'g.freePick', chessId: id }), { ok: true });
  assert.equal(ps.funds, funds0, 'free');
  assert.equal(m.pool.left(id), left0 - 1, 'one shared-pool copy taken');
  assert.ok(ps.countCopies(id) === owned0 + 1 || ps.allChess().some((p) => m.gd.isGolden(p.id) && m.gd.baseIdOf(p.id) === id), 'owned (or merged)');
  assert.equal(ps.freePicks, 2);
  // selling returns the copy to the pool
  const piece = [...ps.hand].find((p) => p && p.id === id);
  if (piece) {
    m.handle('p_0', { t: 'g.sell', uid: piece.uid });
    assert.equal(m.pool.left(id), left0, 'the sale returns the copy');
  }
  m.dispose();
});

test('refusals: no pick left, sold out, banned / unknown, full hand, after ready', () => {
  const h = makeMatch({ mode: 'solo', seed: 7, freePick: true }).start();
  h.toPrep(1);
  const m = h.m, ps = h.ps('p_0');
  const id = candidatesOf(ps)[0];
  // sold out: the shared pool has no copy left
  const e = m.pool.entries.get(id), keep = e.left;
  e.left = 0;
  assert.equal(candidatesOf(ps).includes(id), false, 'no copy left ⇒ not a candidate');
  assert.equal(m.handle('p_0', { t: 'g.freePick', chessId: id }).error, ERR.SOLD_OUT);
  e.left = keep;
  // banned / not in the pool / an elite id
  for (const b of m.pool.banned || []) assert.equal(m.handle('p_0', { t: 'g.freePick', chessId: b }).error, ERR.BAD_TARGET);
  assert.equal(m.handle('p_0', { t: 'g.freePick', chessId: 'chess_char_nope_a' }).error, ERR.BAD_TARGET);
  const golden = m.gd.goldenIdOf(id);
  if (golden) assert.equal(m.handle('p_0', { t: 'g.freePick', chessId: golden }).error, ERR.BAD_TARGET);
  // full hand
  const saved = [...ps.hand];
  for (let i = 0; i < ps.hand.length; i++) if (!ps.hand[i]) ps.hand[i] = ps.newPiece('chess', id, { poolCopies: 0 });
  assert.equal(m.handle('p_0', { t: 'g.freePick', chessId: id }).error, ERR.HAND_FULL);
  ps.hand.splice(0, ps.hand.length, ...saved);
  ps.recompute();
  // the pick, then none left
  assert.deepEqual(m.handle('p_0', { t: 'g.freePick', chessId: id }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.freePick', chessId: candidatesOf(ps)[0] }).error, ERR.NO_PICKS);
  m.dispose();
});

test('AI seats get no picks; the message is validated', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 3, seed: 9, freePick: true }).start();
  h.toPrep(1);
  for (const ps of h.m.order) {
    if (ps.isBot) {
      assert.equal(ps.freePicks ?? 0, 0, `${ps.playerId}: none`);
      assert.equal('freePicks' in ps.privateView().shop, false);
    } else assert.equal(ps.freePicks, 1);
  }
  h.m.dispose();
  assert.equal(validateC2S({ t: 'g.freePick', chessId: 'chess_char_1_01_a' }), null);
  assert.notEqual(validateC2S({ t: 'g.freePick' }), null, 'chessId required');
  assert.notEqual(validateC2S({ t: 'g.freePick', chessId: 42 }), null);
});

test('the lobby reads SP_FREE_PICK (or options.freePick) and passes it to every match; off by default', () => {
  const mk = (options) => new Lobby({ options, log: { info() {}, warn() {}, error() {}, debug() {} } });
  const prev = process.env.SP_FREE_PICK;
  try {
    delete process.env.SP_FREE_PICK;
    assert.equal(mk({}).freePick, false);
    process.env.SP_FREE_PICK = '1';
    assert.equal(mk({}).freePick, true);
    process.env.SP_FREE_PICK = 'off';
    assert.equal(mk({}).freePick, false);
    assert.equal(mk({ freePick: true }).freePick, true);
  } finally {
    if (prev == null) delete process.env.SP_FREE_PICK; else process.env.SP_FREE_PICK = prev;
  }
});
