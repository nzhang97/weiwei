import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeployMap } from '../../server/match/board.js';
import { deployMap } from '../../public/js/ui/gameLogic/placement.js';

// 深水区: no tile override may make deep water deployable; only an active 特制水上平台 does.
const rows = Array.from({ length: 19 }, () => '.'.repeat(13));
rows[10] = '..dd.........';
const stage = {
  rows,
  tiles: { '.': { height: 'LOW', buildable: 'ALL', tileKey: 'tile_floor' }, d: { height: 'LOW', buildable: 'NONE', tileKey: 'tile_deepsea' } },
  devices: [{ alias: 'wp', role: 'waterPlatform', pos: [10, 3], active: true }],
};

for (const [name, build] of [['server', buildDeployMap], ['client', deployMap]]) {
  test(`${name}: deep water refuses forced tile overrides, water platform still deployable`, () => {
    const map = build(stage, { tileOverrides: { '10,2': 'melee', '10,3': 'ranged' } });
    assert.equal(map.has('10,2'), false);
    assert.equal(map.get('10,3'), 'ranged');
    assert.equal(build(stage).get('10,3'), 'melee');
    assert.equal(build(stage, { deviceOverrides: { wp: false } }).has('10,3'), false);
    assert.equal(build(stage).get('10,5'), 'melee');
  });
}
