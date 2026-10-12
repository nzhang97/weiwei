import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeMatch,give} from './harness.js';
import {applyCard} from '../../server/match/choices.js';
import {botPrepBegin} from '../../server/match/bot.js';

test('free promotion recruit and choice fallback use each owner ranking, retain free distinct offer and pool copies',()=>{
 const h=makeMatch({mode:'coop',humans:1,bots:1,fake:true,seed:6501,drawOptimization:true}).start();h.toPrep(1);
 const m=h.m;for(const k of ['aiOperatorBuff','humanOperatorBuff','aiRound34Nerf','freeOperatorPick'])assert.equal(m[k],false);
 const base=[...m.pool.entries.keys()].find(id=>m.gd.chess(id).bonds.some(b=>!m.gd.bond(b).noStack));
 const bond=m.gd.chess(base).bonds.find(b=>!m.gd.bond(b).noStack);
 const effect=m.gd.effect.bind(m.gd);m.gd.effect=id=>id==='test-free' ? {buffs:[{key:'single_special_choice_gain_bond_chess',bb:{count:1},bbStr:{bond}}]} : effect(id);
 m.dispatcher.runKey=()=>0;
 const roll=m.pool.roll.bind(m.pool);let calls=[];m.pool.roll=(rng,o)=>{calls.push(o);return roll(rng,o);};
 for(const ps of m.order){
  ps.layers={[bond]:100};calls=[];const before=m.pool.snapshot();const offer=ps.pushRewardOffer();
  assert.ok(calls.length>0&&calls.every(o=>o.weight(base)===3));
  assert.deepEqual(m.pool.snapshot(),before,'offers reserve no copies');
  assert.equal(new Set(offer.slots.map(s=>s.id)).size,offer.slots.length);
  assert.ok(offer.slots.every(s=>s.price===0));
  ps.layers={[bond]:100};calls=[];applyCard(m,ps,{kind:'tactic',id:'test-free',team:false});
  assert.ok(calls.length>0&&calls.every(o=>o.weight(base)===3));
 }
 m.drawOptimization=false;calls=[];applyCard(m,m.order[0],{kind:'tactic',id:'test-free',team:false});assert.ok(calls.length>0&&calls.every(o=>o.weight===undefined));
 m.dispose();
});

test('development reserve preserves recruitment budget while free upgrades still proceed',()=>{
 for(const free of [false,true]){
  const h=makeMatch({mode:'solo',difficulty:'HARD',fake:true,seed:6502}).start();h.toPrep(1);const m=h.m,ps=m.order[0];
  m.round=4;m.botPolicy={...m.botPolicy,upgradeReserveCoins:3,upgradeReserveUntilRound:8};
  for(const [id] of [...m.pool.entries].filter(([id])=>m.gd.tierOf(id)===1).slice(0,8))give(m,ps,id);
  ps.shop.slots.fill(null);ps.shop.freeRefreshes=0;ps.shop.upgradePrice=free?0:5;ps.funds=free?0:5;
  const initial=ps.shop.level;botPrepBegin(m,ps);assert.equal(ps.shop.level>initial,free);
  m.dispose();
 }
});
