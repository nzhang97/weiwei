// 战术家 summons (伺夜 狼群, 缪尔赛思 流形): deployable only on a deployable tile inside the owner's attack range
// (PRTS 战术家 trait "可以在攻击范围内选择一次战术点来召唤援军"; user report 2026-10-11). Server PlayerState and the
// client mirror (public/js/ui/gameLogic.js canPlace) agree tile by tile; an owner that turns sends summons now out of its
// range back onto their stack; a summon swapped with its own owner must still be in range afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';
import { summonRangeKeys } from '../../shared/summonRange.js';
import { placementContext, canPlace as clientCanPlace } from '../../public/js/ui/gameLogic.js';

const VIGIL = 'chess_char_3_19_a';
const MLYSS = 'chess_char_6_11_a';
const WOLF = 'token_10028_vigil_wolf';
const WTRMAN = 'token_10030_mlyss_wtrman';
const HEMO = 'chess_char_2_02_a'; // 赫默: not a tactician — her drone stays unrestricted
const DRONE = 'token_10000_silent_healrb';

function prep(seed = 11) {
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }];
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats, seed }).start();
  h.toPrep(1);
  h.setStage('act2autochess_m04');
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  ps.recompute();
  return { h, m: h.m, ps };
}
const move = (m, uid, to, dir) => m.handle('p_0', { t: 'g.move', uid, to, ...(dir ? { dir } : {}) });
const stackOf = (ps, id) => ps.hand.find((p) => p && p.kind === 'token' && p.id === id) ?? null;
const tilesOf = (ps, id) => [...ps.deployMap().keys()].map((k) => k.split(',').map(Number))
  .filter(([r, c]) => !ps.board.has(`${r},${c}`) && ps._legal({ kind: 'token', id, ownerUid: -1 }, r, c));

/** Owner tile + facing with both an in-range and an out-of-range free tile for the summon. */
function ownerSpot(m, ps, ownerId, tokenId) {
  const rec = DATA.chess[ownerId];
  for (const k of ps.deployMap().keys()) {
    const [r, c] = k.split(',').map(Number);
    if (!ps._legal({ kind: 'chess', id: ownerId }, r, c)) continue;
    for (const dir of ['RIGHT', 'UP', 'DOWN', 'LEFT']) {
      const keys = summonRangeKeys(rec, r, c, dir);
      const free = tilesOf(ps, tokenId).filter(([a, b]) => !(a === r && b === c));
      const inside = free.filter(([a, b]) => keys.has(`${a},${b}`));
      const outside = free.filter(([a, b]) => !keys.has(`${a},${b}`));
      if (inside.length && outside.length) return { r, c, dir, inside, outside, keys };
    }
  }
  return null;
}

for (const [ownerId, tokenId, name] of [[VIGIL, WOLF, '伺夜 狼群'], [MLYSS, WTRMAN, '缪尔赛思 流形']]) {
  test(`${name}: only inside the owner's attack range; server and client agree on every tile`, () => {
    const { m, ps } = prep();
    const op = give(m, ps, ownerId);
    const spot = ownerSpot(m, ps, ownerId, tokenId);
    assert.ok(spot, 'a test spot exists on this stage');
    assert.deepEqual(move(m, op.uid, { area: 'board', row: spot.r, col: spot.c }, spot.dir), { ok: true });
    const stack = stackOf(ps, tokenId);
    assert.ok(stack, 'summon card in the hand');
    // client mirror (legal-tile highlights) == server legality for every field tile
    const ctx = placementContext({ priv: m.privateView ? m.privateView(ps) : ps.privateView?.() ?? null, stage: m.gd.stage(m.stageId), editable: true,
      getChess: (id) => m.gd.chess(id), getToken: (id) => m.gd.token(id), getItem: (id) => m.gd.item(id), getEffect: (id) => m.gd.effect(id) });
    assert.ok(ctx.pieces.size > 0, 'client context built from the private view');
    {
      for (const k of ps.deployMap().keys()) {
        const [r, c] = k.split(',').map(Number);
        if (ps.board.has(k)) continue;
        const server = ps._legal(stack, r, c);
        const client = clientCanPlace(ctx, stack.uid, { area: 'board', row: r, col: c }).ok;
        assert.equal(client, server, `tile ${k}: client ${client} vs server ${server}`);
      }
    }
    const [orow, ocol] = spot.outside[0];
    const bad = move(m, stack.uid, { area: 'board', row: orow, col: ocol });
    assert.notEqual(bad.ok, true, 'out of range refused');
    assert.equal(ps.board.get(`${orow},${ocol}`), undefined);
    const [irow, icol] = spot.inside[0];
    assert.deepEqual(move(m, stack.uid, { area: 'board', row: irow, col: icol }), { ok: true });
    const placed = ps.board.get(`${irow},${icol}`);
    assert.equal(placed?.id, tokenId);
    // owner turns so that the summon's tile leaves its range: the summon goes back onto its stack
    const turn = ['RIGHT', 'UP', 'DOWN', 'LEFT'].find((d) => d !== spot.dir && !summonRangeKeys(DATA.chess[ownerId], spot.r, spot.c, d).has(`${irow},${icol}`));
    assert.ok(turn);
    assert.deepEqual(move(m, op.uid, { area: 'board', row: spot.r, col: spot.c }, turn), { ok: true });
    assert.equal(ps.board.get(`${irow},${icol}`), undefined, 'summon lifted off the board');
    assert.ok(stackOf(ps, tokenId), 'back on its stack');
  });
}

test('赫默 医疗探机 (not a tactician) stays unrestricted', () => {
  const { m, ps } = prep();
  const hm = give(m, ps, HEMO);
  const at = legalTileFor(m, ps, HEMO);
  assert.deepEqual(move(m, hm.uid, { area: 'board', row: at[0], col: at[1] }), { ok: true });
  const stack = stackOf(ps, DRONE);
  assert.ok(stack);
  for (const [r, c] of tilesOf(ps, DRONE)) assert.equal(ps.summonTileOk(stack, r, c), true);
});
