// test/match/ai-coop-hidden-drive.test.js — botPolicy.hiddenLayerDrive in co-op (botStrategy hiddenDrive / driveLayers):
// the team 隐秘核心 threshold (hiddenCore.multi, Σ activated layers of every alive player) instead of the solo own Σ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenDrive, driveLayers } from '../../server/match/botStrategy.js';

const gd = { hiddenRound: 15, bossRound: 14, hiddenCore: { single: 350, multi: 1200, difficulties: ['ABYSS'] } };
const player = (playerId, L) => ({ playerId, gd, activatedLayers: () => L });
const D = { from: 9, mul: 1.8, addonAsCore: true, finalBonus: 150 };

test('co-op drive: team threshold and the team Σ', () => {
  const ps = [player('a', 300), player('b', 250), player('c', 400), player('d', 100)];
  const m = { isSolo: false, difficulty: 'ABYSS', gd, botPolicy: { hiddenLayerDrive: D }, alivePlayers: () => ps.slice(0, 3) };
  const drive = hiddenDrive(m, ps[0]);
  assert.equal(drive.threshold, 1200);
  assert.equal(drive.team, true);
  assert.equal(driveLayers(m, ps[0], drive), 950, 'alive players only (d is out)');
  assert.equal(driveLayers(m, ps[0], drive, 500), 1150, 'a projected own Σ replaces the current one');
  const solo = { ...m, isSolo: true, alivePlayers: () => [ps[0]] };
  const sd = hiddenDrive(solo, ps[0]);
  assert.equal(sd.threshold, 350);
  assert.equal(driveLayers(solo, ps[0], sd), 300);
  assert.equal(hiddenDrive({ ...m, botPolicy: {} }, ps[0]), null, 'off without the policy knob');
  assert.equal(hiddenDrive({ ...m, difficulty: 'FUNNY' }, ps[0]), null, 'no hidden core on this difficulty');
});
