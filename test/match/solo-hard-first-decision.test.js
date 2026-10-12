import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../../server/data.js';

// Solo 绝境 (mode_single_hard): the first 机变 decision follows battle 3 — it is prepared in round 4 (user report);
// co-op and the other modes keep round 3. tools/build-data.mjs buildConfig / buildChoices.
const data = getData({ log: { warn() {}, error() {}, info() {} } });

test('solo HARD prepares its first decision in round 4, co-op HARD / ABYSS in round 3', () => {
  const hard = data.config.modes.mode_single_hard;
  assert.equal(hard.rounds['3'].isSpPrepare, false);
  assert.equal(hard.rounds['4'].isSpPrepare, true);
  const sch = data.choices.schedule.mode_single_hard;
  assert.equal(sch.spRounds[0], 4);
  assert.ok(sch.rounds['4'] && !sch.rounds['3']);
  assert.equal(sch.rounds['4'].bountyDraft, 'initial');
  for (const [id, mode] of Object.entries(data.config.modes)) {
    if (id === 'mode_single_hard' || !mode.rounds['3']) continue;
    if (mode.rounds['3'].isSpPrepare) assert.notEqual(mode.rounds['4']?.isSpPrepare, true, id);
  }
});
