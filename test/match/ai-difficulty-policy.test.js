import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BOT_POLICY,SOLO_POLICY} from '../../server/match/botPolicy.js';
import {makeMatch} from './harness.js';

test('validated ABYSS co-op preset is isolated from HARD and explicit experiment controls; solo ABYSS uses SOLO_POLICY',()=>{
 const cases=[
  [{mode:'coop',difficulty:'ABYSS'},1.35,3],
  [{mode:'coop',difficulty:'HARD'},1,0],
  [{mode:'solo',difficulty:'ABYSS'},1.35,3,2.4],
  [{mode:'solo',difficulty:'HARD'},1,0],
  [{mode:'coop',difficulty:'ABYSS',botPolicy:{...BOT_POLICY,byDifficulty:undefined}},1,0],
  [{mode:'coop',difficulty:'ABYSS',botPolicy:BOT_POLICY},1.35,3]
 ];
 for(const [options,wave,reserve,layerMul=1.35] of cases){
  const h=makeMatch({humans:1,bots:0,fake:true,seed:7501,...options});const m=h.m;
  assert.equal(m.botPolicy.waveFitWeight ?? 1,wave);
  assert.equal(m.botPolicy.upgradeReserveCoins ?? 0,reserve);
  assert.equal(m.botPolicy.coreLayerValueMul,layerMul);
  for(const name of ['aiOperatorBuff','humanOperatorBuff','aiRound34Nerf','freeOperatorPick'])assert.ok(!m[name]);
  m.dispose();
 }
 assert.equal(SOLO_POLICY.ABYSS.coreLayerWeight,0.9);
 assert.deepEqual({...SOLO_POLICY.ABYSS.hiddenLayerDrive},{from:9,mul:1.8,addonAsCore:true,finalBonus:150});
 assert.deepEqual({...SOLO_POLICY.ABYSS.battleLayerYield},{scale:1,cap:40,recurringCap:40,buyCap:40});
 assert.equal(BOT_POLICY.byDifficulty.ABYSS.battleLayerYield,undefined,'co-op ABYSS unchanged');
 assert.equal(BOT_POLICY.byDifficulty.ABYSS.hiddenLayerDrive,undefined,'co-op ABYSS unchanged');
});
