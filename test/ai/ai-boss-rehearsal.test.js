import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give } from '../match/harness.js';
import { publicBossInput, bossPlanValue } from '../../server/match/ai/botBoss.js';
import { legalTiles, positionClass, tileKey } from '../../server/match/board.js';
import { createRehearsalSteps } from '../../server/match/bot.js';
import { relayRole } from '../../server/match/ai/botTeam.js';

test('boss score favors actual pool depletion and penalizes life lost before it', () => {
  assert.ok(bossPlanValue({hp:0,maxHp:100},1,30,180) > bossPlanValue({hp:1,maxHp:100},30,30,1));
  assert.ok(bossPlanValue({hp:30,maxHp:100},30,30,180) > bossPlanValue({hp:30,maxHp:100},1,30,180));
});

test('four AI phase coverage is opt-in, follows actual opening strategies and remains stable', () => {
  const h=makeMatch({humans:0,bots:4,difficulty:'ABYSS',fake:true});const m=h.m;
  assert.ok(m.order.every(p=>relayRole(m,p)===null));
  m.botPolicy={...m.botPolicy,fourAiRelay:true};
  const [a,b,c,d]=m.order;a.bandId='band_bldsk';b.bandId='band_amedic';c.bandId='band_orchid';d.bandId='band_narant';
  const roles=m.order.map(p=>relayRole(m,p));assert.deepEqual(roles,['anchor','opening','bridge','anchor']);
  b.alive=false;m.order.reverse();assert.equal(relayRole(m,a),'anchor');assert.equal(relayRole(m,c),'bridge');
  m.difficulty='NORMAL';assert.equal(relayRole(m,a),null);m.dispose();
});

test('partner snapshot reads deployed public state with no private hand, shop, funds or loadout', () => {
  const h=makeMatch({humans:2,fake:true}).start();h.toPrep(1);const m=h.m,ps=m.order[1];
  const c=Object.values(m.gd.raw.chess).find(c=>!c.isGolden&&c.tier===1);const p=give(m,ps,c.chessId);
  ps.board.set('10,3',p);ps.recompute();
  const clone={playerId:ps.playerId,seat:ps.seat,board:ps.board,bonds:ps.bonds,bandId:ps.bandId,effects:ps.effects,deviceOverrides:ps.deviceOverrides,
    get hand(){throw Error('private hand');},get shop(){throw Error('private shop');},get funds(){throw Error('private funds');},get loadout(){throw Error('private loadout');}};
  const before=JSON.stringify({board:[...ps.board],bonds:ps.bonds});const input=publicBossInput(m,clone,'R',40);
  assert.equal(input.side,'R');assert.equal(input.colOffset,8);assert.equal(input.lpForBoss,40);assert.equal(input.units[0].uid,p.uid);
  assert.equal(input.contentInfo.handChess,0);input.bonds.probe={layers:999};assert.equal(JSON.stringify({board:[...ps.board],bonds:ps.bonds}),before);m.dispose();
});

test('boss rehearsals restore every live inventory at every yield and use isolated HP and LP', () => {
  const h=makeMatch({humans:2,fake:true}).start();h.toPrep(1);const m=h.m,ps=m.order[0],partner=m.order[1];
  const wave=m.wave;m.wave=null;m.round=m.gd.bossRound;m.bossWaves=[{players:[partner.playerId,ps.playerId],wave}];
  m.botRehearsal=3;m.botPolicy={...m.botPolicy,bossRehearsalPlans:50,bossRehearsalLossWeight:30};
  const c=Object.values(m.gd.raw.chess).find(c=>!c.isGolden&&c.tier===1);const piece=give(m,ps,c.chessId);
  const plans=legalTiles(ps.deployMap(),positionClass(c)).slice(0,9).map(([r,c])=>new Map([[piece.uid,tileKey(r,c)]]));assert.equal(plans.length,9);
  const actualPool={hp:4321,maxHp:4321};m.bossPool=actualPool;m.teamLp=99;
  const snapshot=()=>JSON.stringify({players:m.order.map(p=>({board:[...p.board],hand:p.hand,temp:p.temp,lp:p.lp,funds:p.funds,layers:p.layers})),uid:m.uidSeq,pool:m.pool.snapshot(),boss:m.bossPool,team:m.teamLp});
  const before=snapshot();const opts=[];
  m.newBattle=o=>{
    const index=opts.length;opts.push(o);const callbacks=new Map();
    return {finished:false,time:0,on(name,fn){callbacks.set(name,fn);},forceEnd(){this.finished=true;},step(){
      o.sharedBoss.damage(ps.playerId,o.sharedBoss.maxHp*(index===0?.1:index===1?.7:.8));
      if(index>1)callbacks.get('lpLoss')?.({amount:1e6});this.finished=true;this.time=1;
    }};
  };
  m.botPolicy.bossRehearsalPlans=0;const disabled=createRehearsalSteps(m,ps,[piece],plans).next();assert.equal(disabled.done,true);assert.equal(disabled.value,null);assert.equal(opts.length,0);
  m.botPolicy.bossRehearsalPlans=50;const gen=createRehearsalSteps(m,ps,[piece],plans);let step;
  do{step=gen.next();assert.equal(snapshot(),before);}while(!step.done);
  assert.equal(opts.length,8);for(const o of opts){assert.notEqual(o.sharedBoss,actualPool);assert.equal(o.kind,'boss');assert.equal(o.flags.layerGainsEnabled,false);assert.equal(o.players.find(p=>p.playerId===ps.playerId).side,'R');}
  assert.equal(step.value.run(0),false);assert.equal(snapshot(),before);let slices=1;while(!step.value.run(0)){assert.equal(snapshot(),before);assert.ok(++slices<10);}assert.equal(step.value.best,plans[1]);assert.equal(snapshot(),before);assert.equal(step.value.done,true);m.dispose();
});
