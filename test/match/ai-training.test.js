import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defenseMetrics} from '../../tools/ai-training-score.mjs';
import {makeMatch} from './harness.js';
import {layerValue,corePlan,bandScore,phaseLayerWeights} from '../../server/match/botStrategy.js';
const row=(round,leaks)=>({round,players:{ai_0:{aliveBefore:true,leaks,total:20}}});
test('leak score outweighs progression and cannot reward early elimination',()=>{
 const good=defenseMetrics([row(1,0),row(2,0)],{normalRounds:2,players:1,roundsPassed:1});
 const bad=defenseMetrics([row(1,5),row(2,5)],{normalRounds:2,players:1,roundsPassed:15,victory:true});
 const eliminated=defenseMetrics([row(1,0)],{normalRounds:2,players:1,roundsPassed:1});
 assert.ok(good.score>bad.score);assert.ok(good.score>eliminated.score);assert.equal(eliminated.missing,1);
});
test('core layers are worth more while HP alone has much less influence on strategy score',()=>{
 const h=makeMatch({mode:'coop',humans:1,bots:0,fake:true}).start();h.toPrep(1);const m=h.m,ps=h.ps('p_0');
 const saved={...m.botPolicy};ps.layers.yanShip=200;ps.bonds.yanShip={active:true,count:3};ps._botCore={id:'yanShip'};
 const enhanced=layerValue(m,ps,'yanShip',10);m.botPolicy.coreLayerValueMul=1;assert.ok(enhanced>layerValue(m,ps,'yanShip',10)*1.3);m.botPolicy=saved;
 const score=bandScore(m,ps,'band_sarkazb');m.botPolicy.bandLpWeight=1.3;assert.ok(bandScore(m,ps,'band_sarkazb')>score+20);
 m.dispose();
});

test('early small bonds and late core bonds receive phase-specific layer priorities',()=>{
 const h=makeMatch({mode:'coop',humans:1,bots:0,fake:true}).start();h.toPrep(1);const m=h.m,ps=h.ps('p_0');
 m.botPolicy={...m.botPolicy,phaseAware:true};
 ps.layers={};ps.bonds.yanShip={active:true,count:3};ps.bonds.preciseShip={active:true,count:2};
 // Use the actual data id of 精准 rather than relying on an English alias.
 const addon=m.gd.bondIds.find(id=>m.gd.bond(id).name==='精准');assert.ok(addon);ps.bonds[addon]={active:true,count:2};
 m.round=2;const earlyCore=layerValue(m,ps,'yanShip',10),earlyAddon=layerValue(m,ps,addon,10);
 assert.ok(earlyAddon>earlyCore);
 m.round=10;assert.ok(layerValue(m,ps,'yanShip',10)>layerValue(m,ps,addon,10));
 assert.deepEqual(phaseLayerWeights({...m,round:6}),{core:1,addon:1.2});
 m.dispose();
});
