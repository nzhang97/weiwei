import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Unit } from '../server/sim/units.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { buildDeployMap, fieldTile, canPlace } from '../server/match/board.js';
import { deployMap } from '../public/js/ui/gameLogic.js';
import { makeMatch, give, chessOfTier } from './match/harness.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

const data = getData();
const approx = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} ≈ ${b}`);
function match(enabled, ai = true) {
  return new Match({mode:'coop', difficulty:'NORMAL', humanOperatorBuff:enabled, aiOperatorBuff:ai, data,
    seats:[{seat:0,playerId:'human',name:'Human',isBot:false,connected:true},
      {seat:1,playerId:'bot',name:'AI',isBot:true,connected:true}],
    scheduler:new VirtualScheduler(),send(){},broadcast(){},onEnd(){} });
}

test('human boost follows every round, survives replicas, and remains distinct from AI and autoplay', () => {
  const m=match(true), off=match(false, false);
  try {
    for (const owner of [m,off]) for (const p of owner.order) p.board.set('9,4',p.newPiece('chess','chess_char_1_01_a'));
    m.players.get('human').autoplay=true;
    for (let round=1; round<=18; round++) {
      m.round=round; off.round=round;
      const mul=1+Math.max(10,160-round*10)/100;
      assert.equal(m.players.get('human').battleInput().humanOperatorBuffMul,mul);
      assert.equal(m.players.get('bot').battleInput().humanOperatorBuffMul,1);
      assert.equal(m.players.get('human').battleInput().aiOperatorBuff,false);
      assert.equal(off.players.get('human').battleInput().humanOperatorBuffMul,1);
      for (const kind of ['normal','unite','boss','hidden']) {
        const specFor=owner=>buildBattleSpec({kind,round,players:owner.order.map((p,i)=>p.battleInput({side:i?'R':'L',colOffset:kind==='unite'?i*8:0})),seed:12,stageId:m.stageId,content:'none',timeLimit:10});
        const spec=specFor(m);
        const b=createBattleFromSpec(spec,data), replica=createBattleFromSpec(JSON.parse(JSON.stringify(spec)),data), plain=createBattleFromSpec(specFor(off),data);
        for (const battle of [b,replica,plain]) battle.start();
        for (const [id,factor] of [['human',mul],['bot',2]]) {
          const u=b.allyUnits.find(u=>u.ownerId===id), original=plain.allyUnits.find(u=>u.ownerId===id);
          const mirror=replica.allyUnits.find(u=>u.ownerId===id);
          for (const key of ['atk','def','maxHp']) {approx(u.s[key],original.s[key]*factor); approx(u.s[key],mirror.s[key]);}
          const before={...u.s}; b.kill(u); b.redeploy(u,{free:true});
          for (const key of ['atk','def','maxHp']) approx(u.s[key],before[key]);
        }
      }
    }
  } finally {m.dispose();off.dispose();}
});

test('human multiplier follows all dynamic buffs and preserves HP ratio; excludes tokens, devices and enemies', () => {
  const make=(mul,kind='op',side='ally')=>new Unit({id:1,side,kind,humanOperatorBuffMul:mul,base:{maxHp:1000,atk:100,def:80,res:20,aspd:100}});
  const a=make(1), b=make(2.5);
  for (const u of [a,b]) {
    u.buffs.push({key:'equipment',stacks:1,mods:{atkFlat:40,defFlat:20,hpFlat:200,atkPct:.5,defPct:.25,hpPct:.4}});
    u.buffs.push({key:'skill',stacks:1,mods:{atkPct:.7,atkMul:1.3,defMul:1.5,hpMul:1.2}});
    u.markDirty();
  }
  b.alive=true;b.hp=b.s.maxHp/2;
  for (let i=0;i<3;i++) {
    for (const key of ['atk','def','maxHp']) approx(b.s[key],a.s[key]*2.5);
    approx(b.hpRatio,.5); assert.equal(b.s.aspd,a.s.aspd);assert.equal(b.s.res,a.s.res);
    for (const u of [a,b]) { if(i===0) u.buffs.push({key:'later',stacks:1,mods:{atkPct:1,hpMul:1.5,defFlat:100}}); else u.buffs.pop();u.markDirty(); }
  }
  for (const [kind,side] of [['token','ally'],['device','ally'],['enemy','enemy']]) assert.deepEqual(make(2.5,kind,side).s,make(1,kind,side).s);
});

// (deep-water deployment: upstream v0.2.5 rules — server/match/board.js, water platforms included; not re-tested here)
test('human room option defaults off, is host-only, resets ready and locks at match start', async () => {
  const srv=await startServer({port:0,quiet:true}), clients=[];
  try {
    const url=`ws://127.0.0.1:${srv.port}/ws`;
    const host=await TestClient.connect(url), guest=await TestClient.connect(url);clients.push(host,guest);
    const h=await host.hello('Host');await guest.hello('Guest');
    await host.request({t:'room.create',mode:'coop',difficulty:'NORMAL'});
    const state=await host.waitFor('room.state');assert.equal(state.humanOperatorBuff,false);
    await guest.request({t:'room.join',code:state.code});
    assert.equal((await guest.request({t:'room.setHumanOperatorBuff',enabled:true})).code,ERR.NOT_HOST);
    await guest.request({t:'room.ready',ready:true});
    assert.equal((await host.request({t:'room.setHumanOperatorBuff',enabled:true})).t,'ok');
    const changed=await guest.waitFor('room.state',s=>s.humanOperatorBuff===true);
    assert.equal(changed.seats.find(s=>s&&s.playerId!==h.playerId).ready,false);
    assert.equal(changed.aiOperatorBuff,false);
    await guest.request({t:'room.ready',ready:true});await host.request({t:'room.start'});
    const room=srv.lobby.getRoom(state.code);assert.equal(room.match.humanOperatorBuff,true);
    assert.equal((await host.request({t:'room.setHumanOperatorBuff',enabled:false})).code,ERR.ROOM_STARTED);
    await host.request({t:'room.leave'});await guest.request({t:'room.leave'});
    await host.request({t:'room.create',mode:'solo',difficulty:'NORMAL'});
    assert.equal((await host.request({t:'room.setHumanOperatorBuff',enabled:true})).t,'ok');
    assert.equal((await host.request({t:'room.start'})).t,'ok');
  } finally {for(const c of clients)c.ws.terminate();await srv.close();}
});
