import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeMatch,give} from './harness.js';
import {positionalEngineValue,traitValue,combatBondValue,bandScore} from '../../server/match/botStrategy.js';

test('空弦/断崖 value a real owned active-bond neighbour; no bench, inactive, cap or missing-target credit',()=>{
 const h=makeMatch({mode:'solo',fake:true,seed:4501}).start();h.toPrep(1);const m=h.m,ps=h.ps('p_0');
 const core=Object.values(m.gd.raw.chess).find(c=>c.visible&&!c.isGolden&&c.bonds.includes('yanShip'));
 const target=give(m,ps,core.chessId,'hand');const board=new Map([['x0',target]]);
 const bonds={yanShip:{active:true,count:3,layers:80}};ps.layers={yanShip:80};
 m.botPolicy={...m.botPolicy,positionEngineWeight:1.4,positionTargetCredit:0.5,positionEngineMinRound:1,positionEngineCoreOnly:false};
 for(const name of ['空弦','断崖']){
  const rec=Object.values(m.gd.raw.chess).find(c=>c.name===name&&!c.isGolden);
  const piece={kind:'chess',uid:99999,id:rec.chessId};
  const events=name==='空弦'?['SERVER_PREP_START']:['SERVER_PREP_FIN'];
  assert.ok(traitValue(m,ps,piece,events,{board,bonds})>0,`${name}: neighbour gain with own bonds inactive`);
  assert.equal(traitValue(m,ps,piece,events,{board,bonds,bench:true}),0);
  m.botPolicy.positionEngineMinRound=5;
  assert.equal(positionalEngineValue(m,ps,piece,3,{board,bonds}),0);
  m.round=5;assert.ok(positionalEngineValue(m,ps,piece,3,{board,bonds})>0);
  m.botPolicy.positionEngineCoreOnly=true;
  const addon=Object.values(m.gd.raw.chess).find(c=>c.visible&&!c.isGolden&&c.bonds.includes('skillfulShip'));
  const addonBoard=new Map([['x0',{kind:'chess',id:addon.chessId,uid:111}]]);
  assert.equal(positionalEngineValue(m,ps,piece,3,{board:addonBoard,bonds:{skillfulShip:{active:true,count:3}}}),0);
  m.round=1;m.botPolicy.positionEngineMinRound=1;m.botPolicy.positionEngineCoreOnly=false;

  assert.equal(positionalEngineValue(m,ps,piece,3,{board:new Map(),bonds}),0);
  assert.equal(positionalEngineValue(m,ps,piece,3,{board,bonds:{yanShip:{active:false}}}),0);
  ps.layers.yanShip=999;assert.equal(positionalEngineValue(m,ps,piece,3,{board,bonds}),0);ps.layers.yanShip=80;
 }
 m.dispose();
});

test('灵巧/奥术 bonus is conditional on combat composition and disabled restores the prior estimate',()=>{
 const h=makeMatch({mode:'solo',fake:true,seed:4502}).start();const m=h.m,ps=h.ps('p_0');
 const defs=new Map([['source',{tier:3,bonds:['skillfulShip','arcaneShip'],dmgType:'arts',attackKind:'ranged',stats:{blockCnt:0}}],['target',{tier:3,bonds:[],dmgType:'arts',attackKind:'ranged',stats:{blockCnt:0}}]]);
 const lookup=m.gd.chess.bind(m.gd);m.gd.chess=id=>defs.get(id)||lookup(id);
 const set=[{id:'source',uid:1,kind:'chess'},{id:'target',uid:2,kind:'chess'}];
 for(const id of ['skillfulShip','arcaneShip']){
  const bonds={[id]:{active:true,count:3,layers:40}};
  m.botPolicy={...m.botPolicy,supportBondWeight:{}};const before=combatBondValue(m,set,bonds,ps);
  m.botPolicy.supportBondWeight={[id]:1.25};assert.ok(combatBondValue(m,set,bonds,ps)>before);
 }
 defs.get('source').dmgType='phys';assert.equal(combatBondValue(m,set,{arcaneShip:{active:true,count:3,layers:40}},ps),0);
 m.dispose();
});

test('core-starting-strategy bonus only applies while its core is available',()=>{
 const h=makeMatch({mode:'coop',humans:1,bots:0,fake:true,seed:4503}).start();const m=h.m,ps=h.ps('p_0');
 m.bondLive=()=>true;const before=bandScore(m,ps,'band_harold');
 m.botPolicy={...m.botPolicy,coreBandBonus:6};assert.equal(bandScore(m,ps,'band_harold'),before+6);
 m.bondLive=()=>false;const blocked=bandScore(m,ps,'band_harold');m.botPolicy.coreBandBonus=0;assert.equal(bandScore(m,ps,'band_harold'),blocked);
 m.dispose();
});
