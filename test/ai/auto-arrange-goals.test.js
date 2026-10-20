// test/ai/auto-arrange-goals.test.js — the 「AI站位」 tendencies (g.autoArrange { goal, bench }, bot.js
// recommendLayout + server/match/ai/botLayoutGoals.js): 战斗力 / 叠层 / 经济优先, the 整备区 option, the dry run of the
// prep 特质 (no side effect on the match) and the goal scores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor, checkInvariants } from '../match/harness.js';
import { validateC2S } from '../../shared/protocol.js';
import { ERR } from '../../shared/constants.js';
import { tileKey, FIELD } from '../../server/match/board.js';
import { recommendLayout } from '../../server/match/bot.js';
import { autoArrangeNote } from '../../server/match/match/intents.js';
import {
  dryRunPrepTraits, goalScore, leakSummary, isBountyLeak, chessFundsValue, layerFunds, BOUNTY_LEAK_WEIGHT, layoutGoal,
} from '../../server/match/ai/botLayoutGoals.js';

const GLADIIA = 'chess_char_4_12_a'; // garrison_39_a: 进入休整期时 若同一行有3名干员 获得1个斯卡蒂/幽灵鲨/深巡

function setup(o = {}) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 11, ...o });
  h.start();
  h.toPrep(1);
  const m = h.m;
  const ps = m.players.get('p_0');
  for (const [k, p] of [...ps.board]) if (p && p.kind === 'chess') ps.board.delete(k);
  ps.recompute();
  return { h, m, ps };
}

const owned = (ps) => ps.allChess().map((p) => p.uid).sort((a, b) => a - b);
const boardChess = (ps) => [...ps.board.values()].filter((p) => p && p.kind === 'chess').map((p) => p.uid).sort((a, b) => a - b);

test('schema: goal is one of the three tendencies, bench a boolean, both optional', () => {
  assert.equal(validateC2S({ t: 'g.autoArrange' }), null);
  for (const goal of ['combat', 'layers', 'economy']) assert.equal(validateC2S({ t: 'g.autoArrange', goal, bench: true }), null);
  assert.notEqual(validateC2S({ t: 'g.autoArrange', goal: 'gold' }), null);
  assert.notEqual(validateC2S({ t: 'g.autoArrange', bench: 'yes' }), null);
  assert.equal(layoutGoal('nope'), 'combat');
});

test('dry run: 歌蕾蒂娅 grants a pool operator only with three operators in her row — and changes nothing', (t) => {
  const { m, ps } = setup();
  t.after(() => m.dispose());
  const others = chessOfTier(1).filter((id) => id !== GLADIIA).slice(0, 2);
  const g = give(m, ps, GLADIIA, 'hand');
  const a = give(m, ps, others[0], 'hand');
  const b = give(m, ps, others[1], 'hand');
  const put = (piece, r, c) => { for (const [k, p] of [...ps.board]) if (p === piece) ps.board.delete(k); ps.hand[ps.hand.indexOf(piece)] = null; ps.board.set(tileKey(r, c), piece); };
  const R = FIELD.r0, C = FIELD.c0; // the dry run reads positions only (tile legality is not its concern)
  put(g, R, C); put(a, R, C + 1); put(b, R + 1, C + 1);
  ps.recompute();
  const snap = () => JSON.stringify({ funds: ps.funds, pending: ps.pendingFunds, layers: ps.layers, counters: ps.counters, hand: ps.hand.map((p) => p && p.uid), free: ps.shop.freeRefreshes, rng: m.rngMeta.state?.() });
  const before = snap();
  const off = dryRunPrepTraits(m, ps);
  assert.equal(off.chess.length, 0, 'two in the row: no gift');
  ps.board.delete(tileKey(R + 1, C + 1)); ps.board.set(tileKey(R, C + 2), b); ps.recompute();
  const on = dryRunPrepTraits(m, ps);
  assert.equal(on.chess.length, 1, 'three in the row: one gift');
  assert.ok(Array.isArray(on.chess[0].alts) && on.chess[0].alts.length > 1, 'valued over the pool');
  assert.ok(['chess_char_3_05_a', 'chess_char_2_07_a', 'chess_char_1_04_a'].includes(on.chess[0].id));
  // nothing in the match moved: funds, layers, counters, hand, free refreshes, the match RNG
  ps.board.delete(tileKey(R, C + 2)); ps.board.set(tileKey(R + 1, C + 1), b); ps.recompute();
  assert.equal(snap(), before);
});

test('goal scores: a bounty leak weighs BOUNTY_LEAK_WEIGHT normal leaks; layers / economy rank their yield', (t) => {
  const { m, ps } = setup();
  t.after(() => m.dispose());
  const normal = { enemyKey: 'e', counted: true };
  const bounty = { enemyKey: 'e', counted: true, tag: 'bounty' };
  assert.ok(isBountyLeak(bounty) && isBountyLeak({ mods: { bountyId: 3 } }) && !isBountyLeak(normal));
  assert.deepEqual(leakSummary({ leaked: [normal, bounty, { ...normal, counted: false }] }), { counted: 2, bounty: 1, weighted: 1 + BOUNTY_LEAK_WEIGHT });
  const rec = { layers: {}, funds: 0, refresh: 0, items: [], chess: [] };
  const fiveNormal = goalScore(m, ps, 'combat', { leaked: Array(5).fill(normal), killed: 10 }, rec).score;
  const oneBounty = goalScore(m, ps, 'combat', { leaked: [bounty], killed: 10 }, rec).score;
  assert.ok(fiveNormal > oneBounty, 'five normal leaks beat one bounty leak');
  const bond = Object.keys(m.gd.raw.bonds || {})[0] || 'skillfulShip';
  const lay = goalScore(m, ps, 'layers', { leaked: [normal], killed: 0, layerGains: {} }, { ...rec, layers: { [bond]: 6 } });
  const lay0 = goalScore(m, ps, 'layers', { leaked: [], killed: 0, layerGains: {} }, rec);
  assert.equal(lay.metrics.layers, 6);
  assert.ok(lay.score > lay0.score, 'more layers win despite a leak');
  const eco = goalScore(m, ps, 'economy', { leaked: [], killed: 0, coins: 3 }, { ...rec, funds: 2, refresh: 1 });
  assert.ok(eco.metrics.funds >= 6, `funds ${eco.metrics.funds}`);
});

test('economy values: 三合一 completion is worth more than a lone copy; 远见 pays per 10 layers', (t) => {
  const { m, ps } = setup();
  t.after(() => m.dispose());
  const id = chessOfTier(2)[0];
  const lone = chessFundsValue(m, ps, id);
  give(m, ps, id, 'hand'); give(m, ps, id, 'hand');
  const third = chessFundsValue(m, ps, id);
  assert.ok(third > lone * 2, `${third} vs ${lone}`);
  ps.layers.visiShip = 8;
  assert.equal(layerFunds(m, ps, { visiShip: 3 }), 2, '8 → 11 crosses one 10');
  assert.equal(layerFunds(m, ps, { visiShip: 1 }), 0);
});

for (const goal of ['combat', 'layers', 'economy']) {
  test(`g.autoArrange goal=${goal}: only the board's operators move without the bench option`, (t) => {
    const { m, ps } = setup({ botRehearsal: 3 });
    t.after(() => m.dispose());
    for (const id of chessOfTier(1).slice(0, 3)) give(m, ps, id, 'board', legalTileFor(m, ps, id));
    give(m, ps, chessOfTier(1)[5], 'hand');
    ps.recompute();
    const before = boardChess(ps);
    const all = owned(ps);
    const funds = ps.funds;
    assert.deepEqual(m.handle('p_0', { t: 'g.autoArrange', goal }), { ok: true });
    assert.deepEqual(boardChess(ps), before);
    assert.deepEqual(owned(ps), all);
    assert.equal(ps.funds, funds);
    checkInvariants(m);
  });
}

test('bench option: hand operators may be swapped in; nothing is sold or bought and the cap holds', (t) => {
  const { m, ps } = setup({ botRehearsal: 3 });
  t.after(() => m.dispose());
  const ids = chessOfTier(1);
  give(m, ps, ids[0], 'board', legalTileFor(m, ps, ids[0]));
  for (const id of [GLADIIA, ...chessOfTier(2).slice(0, 3)]) give(m, ps, id, 'hand');
  ps.recompute();
  const all = owned(ps);
  const funds = ps.funds;
  for (const goal of ['economy', 'layers', 'combat']) {
    const r = recommendLayout(m, ps, { goal, bench: true });
    assert.ok(r && r.bench === true && r.goal === goal);
    assert.deepEqual(owned(ps), all, `${goal}: same pieces owned`);
    assert.equal(ps.funds, funds);
    assert.ok(ps.deployCount <= ps.deployCap);
    assert.ok(boardChess(ps).length >= 1);
    checkInvariants(m);
  }
  // an empty board with the bench option deploys from the hand
  for (const [k, p] of [...ps.board]) if (p && p.kind === 'chess') { ps.board.delete(k); ps.hand[ps.hand.indexOf(null)] = p; }
  ps.recompute();
  assert.equal(recommendLayout(m, ps, { goal: 'combat', bench: false }), false);
  const r = recommendLayout(m, ps, { goal: 'combat', bench: true });
  assert.ok(r && boardChess(ps).length > 0);
  checkInvariants(m);
});

test('economy refinement: 歌蕾蒂娅 ends with three operators in her row when the tiles allow it', (t) => {
  const { m, ps } = setup({ botRehearsal: 3 });
  t.after(() => m.dispose());
  // three operators deployed in three different rows on legal tiles
  const ids = [GLADIIA, ...chessOfTier(1).filter((id) => id !== GLADIIA).slice(0, 2)];
  const used = new Set();
  const pieces = [];
  for (const id of ids) {
    let at = null;
    for (let tries = 0; tries < 40; tries++) {
      const k = legalTileFor(m, ps, id, used);
      if (!k) break;
      if (!pieces.some((p) => p.r === k[0])) { at = k; break; }
      used.add(tileKey(k[0], k[1]));
    }
    if (!at) return t.skip('no distinct rows');
    pieces.push({ piece: give(m, ps, id, 'board', at), r: at[0] });
  }
  ps.recompute();
  assert.equal(dryRunPrepTraits(m, ps).chess.length, 0, 'not three in her row yet');
  const r = recommendLayout(m, ps, { goal: 'economy' });
  assert.ok(r);
  const rec = dryRunPrepTraits(m, ps);
  const gl = [...ps.board.entries()].find(([, p]) => p.id === GLADIIA);
  const row = Number(gl[0].split(',')[0]);
  const inRow = [...ps.board.entries()].filter(([k, p]) => p.kind === 'chess' && Number(k.split(',')[0]) === row).length;
  assert.equal(inRow, 3, 'three in her row');
  assert.equal(rec.chess.length, 1, 'the gift now fires');
  checkInvariants(m);
});

test('bounded slices: the request returns at once, a second one is refused while it runs, the layout lands later', (t) => {
  const { m, ps } = setup({ botRehearsal: 3 });
  t.after(() => m.dispose());
  for (const id of chessOfTier(1).slice(0, 4)) give(m, ps, id, 'board', legalTileFor(m, ps, id));
  ps.recompute();
  const before = boardChess(ps);
  m.botSliceMs = 0.01; // every step its own callback
  assert.deepEqual(m.handle('p_0', { t: 'g.autoArrange', goal: 'layers' }), { ok: true });
  assert.equal(ps._autoArrangeRunning, true, 'still planning after the reply');
  ps._autoArrangeAt = -Infinity;
  assert.equal(m.handle('p_0', { t: 'g.autoArrange' }).error, ERR.RATE, 'one at a time');
  m.sched.advance(0);
  for (let i = 0; i < 10000 && ps._autoArrangeRunning; i++) m.sched.advance(1);
  assert.equal(ps._autoArrangeRunning, false);
  assert.deepEqual(boardChess(ps), before);
  checkInvariants(m);
});

test('the result note names the tendency and the estimate', () => {
  assert.equal(autoArrangeNote({ goal: 'layers', metrics: null }), null);
  const n = autoArrangeNote({ goal: 'economy', metrics: { leaks: 1, bountyLeaks: 0, killed: 9, layers: 4, funds: 7.4 }, swapped: 2 });
  assert.ok(n && JSON.stringify(n).includes('7'));
});
