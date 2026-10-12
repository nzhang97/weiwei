import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeMatch, give, checkInvariants} from './harness.js';
import {publicCoreCompetition} from '../../server/match/botStrategy.js';
import {legalTiles, positionClass, tileKey} from '../../server/match/board.js';
import {createRehearsalSteps,planLayoutSteps,skillfulAuraDpsScale,operatorCombatPower,botMergeReachable,botUnitRecord} from '../../server/match/bot.js';

test('expanded rehearsal remains bounded and never commits hypothetical resources or layers',()=>{
 for(const [extra,expected] of [[0,3],[5,8],[50,8]]){
  const h=makeMatch({mode:'solo',seed:7,fake:true}).start();h.toPrep(1);
  const m=h.m,ps=m.order[0];m.botRehearsal=3;m.botPolicy={...m.botPolicy,extraRehearsalPlans:extra};
  const rec=Object.values(m.gd.raw.chess).find(c=>!c.isGolden&&c.tier===1&&!m.gd.modeInactiveBonds.has(c.bonds?.[0]));
  const piece=give(m,ps,rec.chessId);
  const plans=legalTiles(ps.deployMap(),positionClass(rec)).slice(0,9).map(([r,c])=>new Map([[piece.uid,tileKey(r,c)]]));
  assert.equal(plans.length,9);
  const snapshot=()=>JSON.stringify({board:[...ps.board],hand:ps.hand,temp:ps.temp,lp:ps.lp,funds:ps.funds,layers:ps.layers,uid:m.uidSeq,pool:m.pool.snapshot()});
  const before=snapshot();let inputs=0;const build=m.newBattle.bind(m);m.newBattle=opts=>{inputs++;return build(opts);};
  const gen=createRehearsalSteps(m,ps,[piece],plans);let step;
  do{step=gen.next();assert.equal(snapshot(),before);}while(!step.done);
  assert.equal(inputs,expected);step.value.run();assert.equal(snapshot(),before);checkInvariants(m);m.dispose();
 }
});


test('whole-roster placement refinement is legal and leaves live pieces unchanged at every yield',()=>{
 const h=makeMatch({mode:'solo',seed:7,fake:true}).start();h.toPrep(1);
 const m=h.m,ps=m.order[0];m.botPolicy={...m.botPolicy,layoutRefinementPasses:2};
 const records=Object.values(m.gd.raw.chess).filter(c=>!c.isGolden&&c.tier===1).slice(0,4);
 const pieces=records.map(c=>give(m,ps,c.chessId));
 const snapshot=()=>JSON.stringify({board:[...ps.board],hand:ps.hand,temp:ps.temp,lp:ps.lp,funds:ps.funds,layers:ps.layers,uid:m.uidSeq,pool:m.pool.snapshot()});
 const before=snapshot();const gen=planLayoutSteps(m,ps,pieces);let step;
 do{step=gen.next();assert.equal(snapshot(),before);}while(!step.done);
 const plan=step.value;assert.equal(plan.size,pieces.length);assert.equal(new Set(plan.values()).size,plan.size);
 for(const p of pieces){const legal=new Set(legalTiles(ps.deployMap(),positionClass(m.gd.chess(p.id))).map(([r,c])=>tileKey(r,c)));assert.ok(legal.has(plan.get(p.uid)));assert.ok(['UP','RIGHT','DOWN','LEFT'].includes(plan.dirOf(p.uid)));}
 checkInvariants(m);m.dispose();
});


test('skillful exposure uses members and exact four/eight adjacency, once, with no token benefit',()=>{
 const op=(key,bonds=[])=>({key,rec:{chessId:key,bonds,stats:{aspd:100,bat:1}}});
 const a=op('10,4',['skillfulShip']),b=op('10,3',['skillfulShip']),near=op('10,5'),diag=op('11,5'),far=op('12,9');
 const token={key:'11,4',rec:{tokenId:'token',stats:{aspd:100,bat:1}}};const units=[a,b,near,diag,far,token];
 const cfg={active:true,wide:false,bonus:50};const before=JSON.stringify(units);
 assert.equal(skillfulAuraDpsScale(a,units,cfg),1.5);assert.equal(skillfulAuraDpsScale(near,units,cfg),1.5);
 assert.equal(skillfulAuraDpsScale(diag,units,cfg),1);assert.equal(skillfulAuraDpsScale(far,units,cfg),1);
 assert.equal(skillfulAuraDpsScale(diag,units,{...cfg,wide:true}),1.5);
 assert.equal(skillfulAuraDpsScale(token,units,cfg),1);assert.equal(skillfulAuraDpsScale(near,units,{...cfg,active:false}),1);
 assert.equal(JSON.stringify(units),before);
});


test('attack estimate distinguishes visible multi-hit skills without inventing slow-start or healer damage',()=>{
 const c={chessId:'probe',profession:'SNIPER',subProfessionId:'marksman',attackKind:'ranged',dmgType:'phys',stats:{atk:400,bat:1,aspd:100,spRecovery:1}};
 const burst={...c,skill:{duration:20,spCost:20,initSp:20,spType:'INCREASE_WITH_TIME',bb:{'attack@times':3,'attack@max_target':2,atk:0.1}}};
 const slow={...burst,skill:{...burst.skill,spCost:1000,initSp:0}};const before=JSON.stringify(burst);
 assert.ok(operatorCombatPower(burst)>operatorCombatPower(c));assert.equal(operatorCombatPower(slow),operatorCombatPower(c));
 assert.equal(operatorCombatPower(burst,0),operatorCombatPower(c));assert.equal(operatorCombatPower({...burst,dmgType:'heal'}),0);
 assert.equal(JSON.stringify(burst),before);assert.ok(operatorCombatPower(burst)<=30);
});


test('merge feasibility permits completion and distinguishes insufficient shared copies',()=>{
 let copies=1,left=1;const m={gd:{isGolden:()=>false,baseIdOf:id=>id,mergeCount:()=>3},pool:{has:()=>true,left:()=>left}};
 const ps={countCopies:()=>copies};assert.equal(botMergeReachable(m,ps,'x'),false);left=2;assert.equal(botMergeReachable(m,ps,'x'),true);
 copies=2;left=1;assert.equal(botMergeReachable(m,ps,'x'),true);left=0;assert.equal(botMergeReachable(m,ps,'x'),false);
});

test('public core competition reads visible distinct members, not private inventories',()=>{
 const ps={};const mate={alive:true,board:new Map([['a',{kind:'chess',id:'one'}],['b',{kind:'chess',id:'two'}],['c',{kind:'chess',id:'oneGold'}]]),get hand(){throw Error('private hand read');},get shop(){throw Error('private shop read');}};
 const m={order:[ps,mate],botPolicy:{publicCoreCompetitionWeight:1},gd:{bond:()=>({thresholds:[3,6]}),chess:id=>({bonds:['core']}),baseIdOf:id=>id==='oneGold'?'one':id}};
 assert.equal(publicCoreCompetition(m,ps,'core'),12);mate.alive=false;assert.equal(publicCoreCompetition(m,ps,'core'),0);mate.alive=true;m.botPolicy.publicCoreCompetitionWeight=0;assert.equal(publicCoreCompetition(m,ps,'core'),0);
});


test('projected unit power uses only active lineup buffs and never mutates real stats or layers',()=>{
 const h=makeMatch({mode:'solo',seed:7,fake:true}).start();h.toPrep(1);const m=h.m,ps=m.order[0];
 const c=Object.values(m.gd.raw.chess).find(c=>!c.isGolden&&c.bonds.includes('preciShip'));
 const piece=give(m,ps,c.chessId);const before=JSON.stringify({c,layers:ps.layers,piece});
 const bonds={preciShip:{active:true,count:2,tier:1,layers:100}};
 assert.equal(botUnitRecord(m,ps,piece,bonds,8),c);
 m.botPolicy={...m.botPolicy,projectedUnitPower:true};const effective=botUnitRecord(m,ps,piece,bonds,8);
 assert.ok(effective.stats.atk>c.stats.atk*2);assert.ok(operatorCombatPower(effective,0)>operatorCombatPower(c,0));
 assert.equal(botUnitRecord(m,ps,piece,{preciShip:{...bonds.preciShip,active:false}},8).stats.atk,c.stats.atk);
 assert.equal(JSON.stringify({c,layers:ps.layers,piece}),before);m.dispose();
});
