// test/match/auto-arrange.test.js — 一键站位 (g.autoArrange, server/match/match/intents.js autoArrange → bot.js
// recommendLayout): the operators on the human's board are re-placed by the AI planner; nothing is bought, sold or
// benched, and the intent is gated like any other prep edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor, checkInvariants } from './harness.js';
import { ERR } from '../../shared/constants.js';
import { AUTO_ARRANGE_COOLDOWN_MS } from '../../server/match/match/intents.js';
import { validateC2S } from '../../shared/protocol.js';

function setup(o = {}) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 11, ...o });
  h.start();
  h.toPrep(1);
  const m = h.m;
  const ps = m.players.get('p_0');
  for (const [k, p] of [...ps.board]) if (p && p.kind === 'chess') ps.board.delete(k);
  const ids = chessOfTier(1).slice(0, 3);
  const pieces = ids.map((id) => give(m, ps, id, 'board', legalTileFor(m, ps, id)));
  return { h, m, ps, pieces };
}

const boardChess = (ps) => [...ps.board.values()].filter((p) => p && p.kind === 'chess').map((p) => p.uid).sort((a, b) => a - b);

test('g.autoArrange re-places exactly the deployed operators (planner + rehearsal)', (t) => {
  const { m, ps, pieces } = setup({ botRehearsal: 3 });
  t.after(() => m.dispose());
  const before = boardChess(ps);
  const hand = ps.hand.map((p) => p && p.uid);
  const funds = ps.funds;
  assert.deepEqual(m.handle('p_0', { t: 'g.autoArrange' }), { ok: true });
  assert.deepEqual(boardChess(ps), before, 'same operators on the board');
  assert.deepEqual(ps.hand.map((p) => p && p.uid), hand, 'bench untouched');
  assert.equal(ps.funds, funds, 'nothing bought or sold');
  assert.equal(pieces.length, 3);
  checkInvariants(m);
});

test('g.autoArrange is gated: cooldown, ready, empty board; schema accepts it', (t) => {
  const { m, ps } = setup({ botRehearsal: 0 });
  t.after(() => m.dispose());
  assert.equal(validateC2S({ t: 'g.autoArrange' }), null);
  assert.deepEqual(m.handle('p_0', { t: 'g.autoArrange' }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.autoArrange' }).error, ERR.RATE, 'cooldown');
  assert.ok(AUTO_ARRANGE_COOLDOWN_MS > 0);
  ps._autoArrangeAt = -Infinity;
  assert.deepEqual(m.handle('p_0', { t: 'g.ready', ready: true }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.autoArrange' }).error, ERR.WRONG_PHASE, 'locked while ready');
  assert.deepEqual(m.handle('p_0', { t: 'g.ready', ready: false }), { ok: true });
  for (const [k, p] of [...ps.board]) if (p && p.kind === 'chess') { ps.board.delete(k); }
  ps.recompute();
  ps._autoArrangeAt = -Infinity;
  assert.equal(m.handle('p_0', { t: 'g.autoArrange' }).error, ERR.BAD_TARGET, 'nothing deployed');
});
