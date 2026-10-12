import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';
import { generateDraft } from '../../server/match/choices.js';
import { createRng } from '../../server/sim/rng.js';
import { Battle } from '../../server/sim/Battle.js';
import { FakeBattle } from './fakeBattle.js';
import { PHASE } from '../../shared/constants.js';

test('initial bounty drafts only offer two battles and include the 3-coin 山海众 card', () => {
  for (const [mode, schedule] of Object.entries(DATA.choices.schedule)) {
    const gd = new GameData(DATA, mode);
    for (const [round, sch] of Object.entries(schedule.rounds)) {
      if (!sch.events.bounty.some(id => id.startsWith('enemy_initial'))) continue;
      let seen = false;
      for (let seed=1; seed<=200; seed++) {
        const d = generateDraft(gd, createRng(seed), Number(round));
        if (d.family !== 'bounty') continue;
        for (const c of d.cards) {
          assert.equal(c.rounds, 2, `${mode} R${round} ${c.id}`);
          assert.notEqual(c.id, 'enemyeffect_3_4');
          if (c.id === 'enemyeffect_14_6') {
            assert.equal(c.coin, 3);
            assert.equal(c.enemyKey, 'enemy_1299_ymkilr');
            seen = true;
          }
        }
      }
      if (sch.families.some(f => f.family === 'bounty')) assert.ok(seen, `${mode} R${round}: tier III is available`);
    }
  }
});

test('山海众 隐匿III appears in rounds 3 and 4, not 5, and each real kill pays 3 coins', () => {
  const h = makeMatch({ mode:'coop', difficulty:'HARD', humans:1, bots:0, seed:1501, fake:true }).start();
  h.toPrep(3);
  const ps=h.ps('p_0');
  const card=DATA.choices.cards.bounty.find(c => c.effectId === 'enemyeffect_14_6');
  const id=h.m.addBounty(ps, card);
  assert.ok(h.drive(() => h.m.round === 5 && h.m.phase === PHASE.PREP));
  const battles=FakeBattle.instances.filter(b => b.kind==='normal' && b.spawns.some(s=>s.mods?.bountyId===id));
  assert.deepEqual(battles.map(b=>b.round), [3,4]);
  for (const f of battles) {
    const specs=f.spawns.filter(s=>s.mods?.bountyId===id);
    assert.equal(specs.reduce((n,s)=>n+s.count,0),1);
    const b=new Battle({data:DATA, content:'none', quiet:true, players:[{playerId:'p_0',units:[]}], routes:f.opts.routes, stageId:h.m.stageId, spawns:[]});
    const enemy=b.spawnEnemy(card.enemyKey,specs[0]);
    assert.equal(enemy.bounty.coins,3);
    b.kill(enemy);
    b.kill(enemy);
    b.forceEnd('test');
    assert.equal(b.result().perPlayer.p_0.coins,3);
  }
  assert.ok(!ps.bounties.some(b=>b.id===id));
  h.m.dispose();
});

test('solo HARD first decision follows round 3; co-op retains decision before round 3', () => {
  assert.deepEqual(DATA.config.modes.mode_single_hard.spRounds,[4,9,11]);
  assert.deepEqual(DATA.choices.schedule.mode_single_hard.spRounds,[4,9,11]);
  assert.deepEqual(DATA.config.modes.mode_multi_hard.spRounds,[3,9,11]);
});


test('round 9 bounty pools contain only one-battle cards in every mode', () => {
  for (const [mode, schedule] of Object.entries(DATA.choices.schedule)) {
    const sch=schedule.rounds['9'];
    if (!sch) continue;
    assert.equal(sch.bountyRounds,1,mode);
    if (!sch.families.some(f=>f.family==='bounty')) continue;
    const gd=new GameData(DATA,mode);
    const pool=DATA.choices.cards.bounty.filter(c=>c.draft && c.rounds===1 && sch.bountyTiers.includes(c.tier) && gd.enemy(c.enemyKey) && !gd.inactiveEnemies.has(c.enemyKey));
    assert.ok(pool.length>=sch.cards,`${mode}: enough distinct one-battle candidates`);
    // Put each eligible card first, so the entire pool is checked rather than a random sample.
    for (const target of pool) {
      const rng=createRng(9);
      rng.shuffle=arr=>arr.sort((a,b)=>Number(b.effectId===target.effectId)-Number(a.effectId===target.effectId));
      const draft=generateDraft(gd,rng,9);
      assert.equal(draft.family,'bounty');
      assert.equal(draft.cards.length,sch.cards);
      assert.ok(draft.cards.some(c=>c.id===target.effectId));
      assert.equal(new Set(draft.cards.map(c=>c.id)).size,sch.cards);
      for (const c of draft.cards) assert.equal(c.rounds,1,`${mode}: ${c.id}`);
    }
  }
});

test('a bounty chosen for round 9 spawns in round 9 and expires before round 10', () => {
  const h=makeMatch({mode:'coop',difficulty:'HARD',humans:1,bots:0,seed:9001,fake:true}).start();
  h.toPrep(9);
  const draft=generateDraft(h.m.gd,createRng(9),9);
  assert.equal(draft.family,'bounty');
  const chosen=draft.cards[0];
  const card=DATA.choices.cards.bounty.find(c=>c.effectId===chosen.id);
  const ps=h.ps('p_0');const id=h.m.addBounty(ps,card);
  assert.ok(h.drive(()=>h.m.round===11 && h.m.phase===PHASE.PREP));
  const battles=FakeBattle.instances.filter(b=>b.kind==='normal' && b.spawns.some(s=>s.mods?.bountyId===id));
  assert.deepEqual(battles.map(b=>b.round),[9]);
  assert.equal(battles[0].spawns.filter(s=>s.mods?.bountyId===id).reduce((n,s)=>n+s.count,0),card.count);
  assert.ok(!ps.bounties.some(b=>b.id===id));
  h.invariants();h.m.dispose();
});
