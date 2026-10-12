import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BOT_POLICY} from '../../server/match/botPolicy.js';
import {makeMatch} from './harness.js';

test('validated ABYSS co-op preset is isolated from HARD, solo and explicit experiment controls',()=>{
 const cases=[
  [{mode:'coop',difficulty:'ABYSS'},1.35,3],
  [{mode:'coop',difficulty:'HARD'},1,0],
  [{mode:'solo',difficulty:'ABYSS'},1,0],
  [{mode:'coop',difficulty:'ABYSS',botPolicy:{...BOT_POLICY,byDifficulty:undefined}},1,0],
  [{mode:'coop',difficulty:'ABYSS',botPolicy:BOT_POLICY},1.35,3]
 ];
 for(const [options,wave,reserve] of cases){
  const h=makeMatch({humans:1,bots:0,fake:true,seed:7501,...options});const m=h.m;
  assert.equal(m.botPolicy.waveFitWeight ?? 1,wave);
  assert.equal(m.botPolicy.upgradeReserveCoins ?? 0,reserve);
  assert.equal(m.botPolicy.coreLayerValueMul,1.35);
  for(const name of ['aiOperatorBuff','humanOperatorBuff','aiRound34Nerf','freeOperatorPick'])assert.ok(!m[name]);
  m.dispose();
 }
});
