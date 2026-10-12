import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA, makeMatch } from './harness.js';
import { bountySpawns } from '../../server/match/waves.js';
import { Battle } from '../../server/sim/Battle.js';
import { planUnite } from '../../server/match/unite.js';
const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/bounty-wiki-lower.json',import.meta.url),'utf8'));
const quiet={error(){},warn(){},info(){}};
const wave={routes:[{motion:'WALK',start:[0,4],end:[13,4],checkpoints:[]},{motion:'FLY',start:[0,4],end:[13,4],checkpoints:[]}],spawns:[],actions:[]};

test('125 Wiki bounties match card data, effect blackboards, spawned counts and actual kill rewards', () => {
  assert.equal(fixture.cards.length,125);
  const h=makeMatch({mode:'coop',difficulty:'HARD',humans:1,bots:0,seed:991,fake:true}).start();
  h.toPrep(1);const ps=h.ps('p_0');
  for (const expected of fixture.cards) {
    const c=DATA.choices.cards.bounty.find(c=>c.effectId===expected.id);
    assert.ok(c,expected.id);
    for (const k of ['count','coin','rounds','payout','enemyKey']) assert.equal(c[k],expected[k],`${expected.id} ${k}`);
    const effect=DATA.effects[expected.id];
    const add=effect.buffs.find(b=>/add_enemy/.test(b.key) && b.key!=='next_battle_add_enemy_win_gain_coin' && b.bbStr.enemy_id===c.enemyKey);
    assert.ok(add,expected.id);
    assert.equal(add.bb.count,c.count);assert.equal(add.bb.coin,c.coin);assert.equal(add.bb.round,c.rounds);
    ps.bounties=[];const id=h.m.addBounty(ps,c);
    const spawns=bountySpawns(h.m.gd,3,wave,ps.bounties,'p_0');
    assert.equal(spawns.reduce((n,s)=>n+s.count,0),c.count,expected.id);
    const battle=new Battle({data:DATA,content:'none',logger:quiet,quiet:true,players:[{playerId:'p_0',units:[]}],routes:wave.routes,spawns:[]});
    for (const s of spawns) for (let i=0;i<s.count;i++) {const enemy=battle.spawnEnemy(c.enemyKey,s);battle.kill(enemy);battle.kill(enemy);}
    battle.forceEnd('test');
    assert.equal(battle.result().perPlayer.p_0.coins,c.payout==='kill'?c.count*c.coin:0,expected.id);
    assert.equal(ps.bounties[0].id,id);
    assert.equal(c.draft,c.payout!=='perfect',`${expected.id}: training only comes from 教鞭`);
  }
  h.m.dispose();
});

test('leaked bounty retains its reward in unite and pays the helping killer once', () => {
  const h=makeMatch({mode:'coop',difficulty:'HARD',humans:2,bots:0,fake:true,seed:995}).start();
  const m=h.m;const owner=h.ps('p_0');
  const c=DATA.choices.cards.bounty.find(c=>c.effectId==='enemyeffect_14_6');
  const id=m.addBounty(owner,c);
  const results=new Map([['p_0',{perfect:false,leaked:[{enemyKey:c.enemyKey,counted:true,mods:{bountyId:id},lpr:1}]}],['p_1',{perfect:true,leaked:[]}]]);
  const plan=planUnite(m,results);assert.equal(plan.leaked[0].bounty.coins,3);
  const battle=new Battle({data:DATA,content:'none',quiet:true,logger:quiet,kind:'unite',players:[{playerId:'p_1',units:[]}],routes:wave.routes,spawns:[]});
  const enemy=battle.spawnEnemy(c.enemyKey,{...plan.leaked[0],routeIndex:0});
  const killer={side:'ally',ownerId:'p_1',stats:{kills:0}};
  battle.kill(enemy,killer);battle.kill(enemy,killer);battle.forceEnd('test');
  assert.equal(battle.result().perPlayer.p_1.coins,3);h.m.dispose();
});

test('boss training rewards perfect own battle once per card, not per enemy', () => {
  for (const perfect of [true,false]) {
    const h=makeMatch({mode:'coop',difficulty:'HARD',humans:1,bots:0,fake:true,seed:998}).start();
    h.toPrep(1);const ps=h.ps('p_0');
    const c=DATA.choices.cards.bounty.find(c=>c.effectId==='enemyeffect_1');
    assert.equal(c.count,3);assert.equal(c.coin,2);assert.equal(c.payout,'perfect');
    h.m.addBounty(ps,c);const before=ps.pendingFunds;
    h.m._settleBossBounties(ps,{coins:3,perfect});
    assert.equal(ps.pendingFunds-before,perfect?5:3);
    assert.equal(ps.bounties.length,0);h.m.dispose();
  }
});
