import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chessDrawWeight} from '../../server/match/drawOptimization.js';
import {makeCtx} from '../../server/match/effectsMeta.js';
import {SharedPool} from '../../server/match/pool.js';
import {createRng} from '../../server/sim/rng.js';
import {makeMatch,DATA} from './harness.js';
import {Room,Lobby} from '../../server/lobby.js';
import {validateC2S} from '../../shared/protocol.js';

test('ranks: 3/2.5/2/1.5/1; ties, zero layers, no-stack and multi-bond maximum',()=>{
 const bonds={a:{},b:{},c:{},d:{},e:{},t:{},zero:{},solo:{noStack:true},harmony:{noStack:true}};
 const chess={A:{bonds:['a']},B:{bonds:['b']},C:{bonds:['c']},D:{bonds:['d']},E:{bonds:['e']},T:{bonds:['t']},Z:{bonds:['zero']},N:{bonds:['solo','harmony']},M:{bonds:['a','b','solo']}};
 const gd={bond:id=>bonds[id],chess:id=>chess[id]};
 const layers={a:500,b:400,c:300,d:200,e:100,t:400,zero:0,solo:999,harmony:999};
 const weight=chessDrawWeight(gd,layers,true);
 assert.deepEqual(['A','B','C','D','E','T','Z','N','M'].map(weight),[3,2.5,2,1.5,1,2.5,1,1,3]);
 assert.equal(chessDrawWeight(gd,layers,false),undefined);
 assert.equal(chessDrawWeight(gd,{},true)('A'),1);
 for(const id of ['suntShip','soloShip','maniShip','emptyShip']) assert.equal(DATA.bonds[id].noStack,true);
});

test('probability is original copy count times multiplier; disabled is seed-identical and exhausted stays excluded',()=>{
 const gd={visibleChess:['a','b'],poolCopies:id=>id==='a'?2:4,tierOf:()=>1};
 const pool=new SharedPool(gd);
 const rng=createRng(222),counts={a:0,b:0};
 const weight=id=>id==='a'?3:1;
 for(let i=0;i<30000;i++) counts[pool.roll(rng,{weight})]++;
 assert.ok(Math.abs(counts.a/30000-0.6)<0.015,JSON.stringify(counts)); // 2*3 / (2*3 + 4*1)
 const r1=createRng(9),r2=createRng(9);
 for(let i=0;i<1000;i++) assert.equal(pool.roll(r1),pool.roll(r2,{weight:undefined}));
 pool.take('a',2);
 for(let i=0;i<100;i++) assert.equal(pool.roll(rng,{weight}),'b');
 assert.deepEqual(pool.snapshot(),{a:0,b:4});
});

test('human and AI use personal live rankings for fresh shops, refresh, frozen slots and promotion rewards',()=>{
 const h=makeMatch({mode:'coop',difficulty:'HARD',humans:1,bots:1,fake:true,seed:64,drawOptimization:true}).start();h.toPrep(1);
 const m=h.m,human=h.ps('p_0'),ai=h.ps('ai_0');
 const id=[...m.pool.entries.keys()].find(id=>DATA.chess[id].bonds.some(b=>b!=='yanShip' && !DATA.bonds[b].noStack));
 const bond=DATA.chess[id].bonds.find(b=>b!=='yanShip' && !DATA.bonds[b].noStack);
 human.layers={[bond]:100};ai.layers={[bond]:50,yanShip:200};
 assert.equal(ai.chessDrawWeight()(id),DATA.chess[id].bonds.includes('yanShip')?3:2.5);
 const original=m.pool.roll.bind(m.pool),calls=[];
 m.pool.roll=(rng,opts={})=>{calls.push({weight:opts.weight?.(id),...opts});return original(rng,opts);};
 human.rollShop();assert.ok(calls.length>0&&calls.every(c=>c.weight(id)===3));
 calls.length=0;ai.rollShop();assert.ok(calls.length>0&&calls.every(c=>c.weight(id)===ai.chessDrawWeight()(id)));
 human.layers={};calls.length=0;human.ready=false;human.funds=30;assert.equal(human.refresh().ok,true);assert.ok(calls.every(c=>c.weight(id)===1));
 human.layers={[bond]:100};human.shop.frozen=true;human.shop.slots[0].frozen=true;const frozen={...human.shop.slots[0]};calls.length=0;human.rollShop({keepFrozen:true});assert.deepEqual(human.shop.slots[0],frozen);assert.ok(calls.every(c=>c.weight(id)===3));
 calls.length=0;human.pushRewardOffer();assert.ok(calls.length>0&&calls.every(c=>c.weight(id)===3));
 m.drawOptimization=false;calls.length=0;human.rollShop();assert.ok(calls.every(c=>c.weight===undefined));
 human.recompute();ai.recompute();h.invariants();m.dispose();
});

test('explicit chess pools multiply existing weights, retain restrictions, and leave item pools unchanged',()=>{
 const d=structuredClone(DATA);const h=makeMatch({mode:'solo',fake:true,seed:18,data:d}).start();const m=h.m;
 const ids=[...m.pool.entries.keys()].slice(0,2);
 d.choices={...d.choices,pools:{...m.gd.choices.pools,weightedTest:{kind:'chess',weighted:[[ids[0],2],[ids[1],4]]},uniformTest:{kind:'chess',items:ids}}};
 const weight=id=>id===ids[0]?3:1;
 m.rngMeta=()=>0.59;assert.equal(m.rollPool('weightedTest',{weight}).id,ids[0]);
 m.rngMeta=()=>0.61;assert.equal(m.rollPool('weightedTest',{weight}).id,ids[1]);
 m.rngMeta=()=>0.7;assert.equal(m.rollPool('uniformTest',{weight}).id,ids[0]);
 m.pool.take(ids[0],m.pool.left(ids[0]));assert.equal(m.rollPool('weightedTest',{weight}).id,ids[1]);
 m.pool.give(ids[0],m.pool.cap(ids[0]));h.invariants();m.dispose();
});

test('room toggle defaults on, is host-only, clears readiness, broadcasts, and reaches the started match',()=>{
 let opts;class FakeMatch{constructor(o){opts=o;}start(){}}
 const lobby=new Lobby({registry:{byId:()=>null},MatchClass:FakeMatch,getData:()=>DATA});
 const room=new Room('ABCDE','coop','HARD',0);room.hostId='host';room.seats[0]={seat:0,playerId:'host',name:'host',connected:true};room.seats[1]={seat:1,playerId:'guest',name:'guest',connected:true,ready:true};lobby.rooms.set(room.code,room);
 const host={playerId:'host',roomCode:room.code},guest={playerId:'guest',roomCode:room.code};
 assert.equal(room.toState().drawOptimization,true);
 assert.notEqual(lobby.setDrawOptimization(guest,{enabled:true}).ok,true);
 assert.notEqual(lobby.setDrawOptimization(host,{enabled:'true'}).ok,true);
 assert.equal(lobby.setDrawOptimization(host,{enabled:false}).ok,true);
 assert.equal(lobby.setDrawOptimization(host,{enabled:true}).ok,true);
 assert.equal(room.seats[1].ready,false);assert.equal(room.toState().drawOptimization,true);
 assert.equal(lobby.setDrawOptimization(host,{enabled:false}).ok,true);assert.equal(room.toState().drawOptimization,false);
 assert.equal(lobby.setDrawOptimization(host,{enabled:true}).ok,true);
 lobby.startMatch(room);assert.equal(opts.drawOptimization,true);
 assert.notEqual(lobby.setDrawOptimization(host,{enabled:false}).ok,true);
 assert.equal(validateC2S({t:'room.setDrawOptimization',enabled:true}),null);
});


test('effect random grants use the owner weights and equipment odds are unchanged',()=>{
 const h=makeMatch({mode:'solo',fake:true,drawOptimization:true,seed:49}).start();h.toPrep(1);
 const m=h.m,ps=h.ps('p_0');ps.layers={yanShip:200};
 const target=Object.keys(DATA.chess).find(id=>DATA.chess[id].bonds.includes('yanShip'));
 const ctx=makeCtx(m,ps,{kind:'global',key:'test'},'onRoundStart');
 const roll=m.pool.roll.bind(m.pool);let captured;
 m.pool.roll=(rng,opts)=>{captured=opts;return roll(rng,opts);};
 ctx.rollChess();assert.equal(captured.weight(target),3);
 const r1=createRng(66),r2=createRng(66);m.rngShop=r1;
 for(let i=0;i<100;i++) assert.equal(ps._rollItemSlot()?.id,m.pool.rollItem(r2,ps.shop.level));
 ps.recompute();h.invariants();m.dispose();
});
