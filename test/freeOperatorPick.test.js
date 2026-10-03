import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, checkInvariants } from './match/harness.js';
import { ERR, PHASE } from '../shared/constants.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

function setup() {
  const h=makeMatch({mode:'coop',humans:2,bots:1}).start();h.toPrep(1);h.m.freeOperatorPick=true;
  return h;
}
const request=(h,id,pid='p_0')=>h.m.handle(pid,{t:'g.freeOperatorPick',chessId:id});
test('free pick is per human and per round, charges no funds, and preserves pool accounting',()=>{
  const h=setup();try {
    const ps=h.ps('p_0'), other=h.ps('p_1'), bot=h.m.order.find(p=>p.isBot);
    const id=ps.freeOperatorPickOptions()[0], funds=ps.funds, left=h.m.pool.left(id);
    assert.ok(id);assert.deepEqual(request(h,id),{ok:true});
    assert.equal(ps.funds,funds);assert.equal(h.m.pool.left(id),left-1);
    assert.equal(ps.privateView().freeOperatorPick.used,true);
    assert.ok(request(h,id).error);assert.equal(h.m.pool.left(id),left-1);
    assert.equal(other.privateView().freeOperatorPick.used,false);
    assert.deepEqual(request(h,other.freeOperatorPickOptions()[0],'p_1'),{ok:true});
    assert.ok(request(h,id,bot.playerId).error);
    ps.ready=true;ps.ready=false;ps.shop.level=2;
    assert.ok(request(h,id).error,'unready and level-up cannot refresh use');
    ps.startRound(2);assert.equal(ps.privateView().freeOperatorPick.used,false);
    assert.deepEqual(request(h,ps.freeOperatorPickOptions()[0]),{ok:true});checkInvariants(h.m);
  }finally{h.m.dispose();}
});
test('reject disabled, wrong phase, ready, high-tier, elite, hidden, banned and exhausted targets without consuming use',()=>{
  const h=setup();try {
    const ps=h.ps('p_0'), valid=ps.freeOperatorPickOptions()[0];
    h.m.freeOperatorPick=false;assert.ok(request(h,valid).error);h.m.freeOperatorPick=true;
    h.m.phase=PHASE.COMBAT;assert.equal(request(h,valid).error,ERR.WRONG_PHASE);h.m.phase=PHASE.PREP;
    ps.ready=true;assert.equal(request(h,valid).error,ERR.WRONG_PHASE);ps.ready=false;
    const ids=Object.keys(h.m.gd.raw.chess);
    const rejects=[ids.find(id=>h.m.gd.chess(id).tier>ps.shop.level),ids.find(id=>h.m.gd.chess(id).isGolden),
      ids.find(id=>h.m.gd.chess(id).isHidden),'chess_invalid',...h.m.pool.banned];
    for(const id of rejects.filter(Boolean))assert.ok(request(h,id).error,id);
    const entry=h.m.pool.entries.get(valid);const held=entry.left;entry.left=0;
    assert.ok(request(h,valid).error);entry.left=held;
    assert.equal(ps.privateView().freeOperatorPick.used,false);
    ps.shop.level=2;const tier2=ps.freeOperatorPickOptions().find(id=>h.m.gd.tierOf(id)===2);
    assert.ok(tier2);assert.deepEqual(request(h,tier2),{ok:true});checkInvariants(h.m);
  }finally{h.m.dispose();}
});
test('full hand failure retains use, while a free choice completing a merge succeeds with full hand',()=>{
  const h=setup();try {
    const ps=h.ps('p_0');ps.hand.fill(null);
    const id=ps.freeOperatorPickOptions().find(id=>h.m.gd.mergeCount(id)===3);
    // The default normal operator merge requires three copies.
    assert.ok(id);give(h.m,ps,id);give(h.m,ps,id);
    for (const itemId of Object.values(h.m.gd.shopItemsByTier).flat()) { if(!ps.hand.some(p=>p==null)) break; giveItem(h.m,ps,itemId); }
    const other=ps.freeOperatorPickOptions().find(x=>x!==id);
    assert.equal(request(h,other).error,ERR.HAND_FULL);
    assert.equal(ps.privateView().freeOperatorPick.used,false);
    assert.deepEqual(request(h,id),{ok:true});
    assert.ok([...ps.hand,...ps.board.values()].some(p=>p&&h.m.gd.chess(p.id)?.isGolden));checkInvariants(h.m);
  }finally{h.m.dispose();}
});
test('room toggle is off by default, host-only, synchronized, resets ready and locks after start',async()=>{
  const srv=await startServer({port:0,quiet:true});const clients=[];
  try {
    const host=await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`),guest=await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);clients.push(host,guest);
    await host.hello('Host');await guest.hello('Guest');await host.request({t:'room.create',mode:'coop',difficulty:'NORMAL'});
    const state=await host.waitFor('room.state');assert.equal(state.freeOperatorPick,false);
    await guest.request({t:'room.join',code:state.code});assert.equal((await guest.request({t:'room.setFreeOperatorPick',enabled:true})).code,ERR.NOT_HOST);
    await guest.request({t:'room.ready',ready:true});await host.request({t:'room.setFreeOperatorPick',enabled:true});
    const next=await guest.waitFor('room.state',s=>s.freeOperatorPick===true);assert.equal(next.seats.filter(Boolean).filter(s=>s.ready).length,0);
    await guest.request({t:'room.ready',ready:true});await host.request({t:'room.start'});
    assert.equal(srv.lobby.getRoom(state.code).match.freeOperatorPick,true);
    assert.equal((await host.request({t:'room.setFreeOperatorPick',enabled:false})).code,ERR.ROOM_STARTED);
  }finally{for(const c of clients)c.ws.terminate();await srv.close();}
});




