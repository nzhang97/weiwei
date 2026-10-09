import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { buildBattleSpec } from '../../server/sim/spec.js';
import { validateClientResult } from '../../server/match/fields.js';
import { makeMatch, give, legalTileFor, checkInvariants } from './harness.js';

test('growth beyond the estimate requires verification while the real layer cap and disabled gains still apply', () => {
  const spec = buildBattleSpec({ battleId: 'layers', fieldId: 'n:p', kind: 'normal', round: 3, timeLimit: 120,
    players: [{ playerId: 'p', units: [] }], spawns: [], flags: { layerGainsEnabled: true } });
  const result = { reason: 'cleared', time: 20, perPlayer: { p: { killed: 0, total: 0, leaked: [], perfect: true, coins: 0, layerGains: { yanShip: 73 }, unitsEnd: [] } } };
  assert.equal(validateClientResult(spec, result).reason, 'layer bound');
  const checked = validateClientResult(spec, result, { verifyLayerOverflow: true });
  assert.ok(checked.ok); assert.equal(checked.requiresLayerVerification, true);
  result.perPlayer.p.layerGains.yanShip = 1000;
  assert.equal(validateClientResult(spec, result, { verifyLayerOverflow: true }).reason, 'layer bound');
  result.perPlayer.p.layerGains.yanShip = 73;
  spec.flags.layerGainsEnabled = false;
  assert.equal(validateClientResult(spec, result, { verifyLayerOverflow: true }).reason, 'layers disabled');
});

test('forged high layer gains are replaced by a server simulation even when routine verification is off', (t) => {
  const tamper = (r) => { r.perPlayer.p_0.layerGains = { yanShip: 500 }; return r; };
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 9112,
    captureFrames: false, clientCombat: true, verify: 'off', perPlayer: { p_0: { tamper } } }).start();
  const m = h.m; t.after(() => { m.dispose(); h.clients.closeAll(); }); h.toPrep(1);
  const ps = h.ps('p_0');
  const c = Object.values(m.gd.raw.chess).find((c) => c.visible && !c.isGolden && c.tier === 1 && c.bonds.includes('yanShip'));
  give(m, ps, c.chessId, 'board', legalTileFor(m, ps, c.chessId));
  h.drive(() => [PHASE.UNITE, PHASE.SETTLE].includes(m.phase));
  assert.ok(m.verifyStats.checked >= 1);
  assert.ok(m.verifyStats.mismatches >= 1);
  assert.equal(m.verifyStats.rejected, 0);
  assert.equal(m.verifyStats.takeovers, 0);
  assert.ok((m.lastResults.get('p_0').layerGains.yanShip || 0) < 500);
  checkInvariants(m);
});

test('an honest 148-layer round passes exact server verification above the round-13 estimate of 112', (t) => {
  const { spec, result } = JSON.parse(fs.readFileSync(new URL('../fixtures/high-layer-client-result.json', import.meta.url), 'utf8'));
  const { m } = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, bots: 1, seed: 101, verify: 'off' });
  t.after(() => m.dispose());
  const checked = validateClientResult(spec, result, { gd: m.gd, verifyLayerOverflow: true });
  assert.ok(checked.ok); assert.equal(checked.requiresLayerVerification, true);
  const actual = m._verifyResult({ spec, players: spec.players.map((p) => p.playerId) }, checked.result, { force: true });
  assert.equal(m.verifyStats.checked, 1);
  assert.equal(m.verifyStats.mismatches, 0);
  assert.deepEqual(Object.values(actual.perPlayer).map((p) => p.layerGains), [{ kjeragShip: 148 }]);
});
