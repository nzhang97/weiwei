import test from 'node:test';
import assert from 'node:assert/strict';
import {makeMatch} from './harness.js';
import {botWaveWeight,fieldModel} from '../../server/match/bot.js';

test('boss recruitment weight is final-round only; defaults and normal preparation remain unchanged',t=>{
 const h=makeMatch({mode:'solo',difficulty:'HARD',fake:true,seed:9001}).start();h.toPrep(1);const m=h.m;t.after(()=>m.dispose());
 assert.equal(botWaveWeight(m),1);m.botPolicy={...m.botPolicy,bossWaveFitWeight:1.5};assert.equal(botWaveWeight(m),1);
 m.round=m.gd.bossRound;assert.equal(botWaveWeight(m),1.5);
 m.botPolicy.waveFitWeight=1.1;assert.ok(Math.abs(botWaveWeight(m)-1.65)<1e-9);
 for(const key of ['aiOperatorBuff','humanOperatorBuff','aiRound34Nerf','freeOperatorPick'])assert.ok(!m[key]);
});

test('leader priority changes only boss route planning, without changing enemy HP or ordinary spawns',t=>{
 const h=makeMatch({mode:'solo',difficulty:'HARD',fake:true,seed:9002}).start();h.toPrep(1);const m=h.m,ps=h.ps('p_0');t.after(()=>m.dispose());
 const enemyKey=m.wave.spawns[0].enemyKey;
 const wave={templateId:'test-boss',routes:[{start:[2,0],end:[2,4],motion:'GROUND'}],spawns:[{enemyKey,count:1,tag:'boss',routeIndex:0},{enemyKey,count:2,routeIndex:0}],overrides:{}};
 m.wave=null;m.round=m.gd.bossRound;m.bossGroupOf=()=>({wave,side:'L'});
 delete m._botPath;const before=structuredClone(fieldModel(m,ps).routes);assert.ok(before.some(r=>r.dwell>0));
 m.botPolicy.bossLeaderWeight=2;delete m._botPath;const after=fieldModel(m,ps).routes;
 const oldBoss=before.find(r=>r.dwell>0),newBoss=after.find(r=>r.dwell>0);
 assert.equal(newBoss.n,oldBoss.n*2);assert.equal(newBoss.hp,oldBoss.hp);
 assert.deepEqual(after.filter(r=>!r.dwell),before.filter(r=>!r.dwell));assert.equal(wave.spawns[0].count,1);
});
