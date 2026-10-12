import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DATA,makeMatch,giveItem,checkInvariants} from './harness.js';
import {botPrepBegin} from '../../server/match/bot.js';
import {PHASE} from '../../shared/constants.js';
import {FakeBattle} from './fakeBattle.js';
import {bountySpawns} from '../../server/match/waves.js';
const ART='chess_item_6_03_m';

function setup(mode='solo') {
 const h=makeMatch({mode,difficulty:'HARD',humans:1,bots:0,fake:true,seed:887}).start();
 h.toPrep(1);h.ps('p_0').bandId='band_doberm';h.toPrep(2);return h;
}
function use(h,art) {return h.m.handle('p_0',{t:'g.art',itemUid:art.uid,row:10,col:5});}

test('杜宾 generated 教鞭 offers three distinct training choices and applies the selected card only',()=>{
 for(const mode of ['solo','coop']) {
  const h=setup(mode),ps=h.ps('p_0');
  const arts=[...ps.hand,...ps.temp].filter(p=>p?.id===ART);
  assert.equal(arts.length,1);
  assert.deepEqual(use(h,arts[0]),{ok:true});
  assert.equal(ps.find(arts[0].uid),null);
  const offer=ps.privateView().shop.rewardOffer;
  assert.equal(offer.source,'training');assert.equal(offer.slots.length,3);
  assert.equal(new Set(offer.slots.map(s=>s.id)).size,3);
  assert.ok(offer.slots.every(s=>s.kind==='bounty' && /战术特训/.test(s.name) && s.desc));
  assert.equal(ps.bounties.length,0);checkInvariants(h.m);
  assert.notEqual(h.m.handle('p_0',{t:'g.reward',idx:3}).ok,true);
  assert.deepEqual(h.m.handle('p_0',{t:'g.reward',idx:1}),{ok:true});
  assert.equal(ps.bounties.length,1);assert.equal(ps.bounties[0].card.effectId,offer.slots[1].id);
  assert.equal(ps.bounties[0].card.payout,'perfect');
  assert.notEqual(h.m.handle('p_0',{t:'g.reward',idx:1}).ok,true);
  h.m.dispose();
 }
});

test('ordinary two-battle bounty and 教鞭 training coexist; use multiple 教鞭 without losing queued rewards',()=>{
 const h=setup('coop'),ps=h.ps('p_0');
 const ordinary=DATA.choices.cards.bounty.find(c=>c.effectId==='enemyeffect_14_6');
 h.m.addBounty(ps,ordinary);
 const ids=[];
 for(let i=0;i<2;i++) {
  const art=giveItem(h.m,ps,ART);assert.deepEqual(use(h,art),{ok:true});
  ids.push(ps.offers[0].slots[0].id);
 }
 assert.equal(ps.offers.filter(o=>o.source==='training').length,2);
 for(let i=0;i<2;i++)assert.deepEqual(h.m.handle('p_0',{t:'g.reward',idx:0}),{ok:true});
 assert.equal(ps.bounties.length,3);
 const wave={routes:[{motion:'WALK',end:[13,4]},{motion:'FLY',end:[13,4]}],spawns:[],actions:[]};
 const spawns=bountySpawns(h.m.gd,2,wave,ps.bounties,'p_0');
 assert.equal(spawns.filter(s=>s.bounty).reduce((n,s)=>n+s.count,0),1);
 assert.ok(spawns.filter(s=>s.bounty).every(s=>s.bounty.coins===3));
 assert.ok(ps.bounties.filter(b=>ids.includes(b.card.effectId)).every(b=>b.card.payout==='perfect'));
 h.m.dispose();
});

test('unselected 教鞭 safely resolves at prep end and generated enemy enters the same upcoming battle',()=>{
 const h=setup(),ps=h.ps('p_0');const art=giveItem(h.m,ps,ART);assert.deepEqual(use(h,art),{ok:true});
 const expected=ps.offers[0].slots[0].id;
 assert.ok(h.drive(()=>h.m.phase===PHASE.PREP && h.m.round===3));
 const f=FakeBattle.instances.find(b=>b.round===2 && b.kind==='normal');
 assert.ok(f.spawns.some(s=>s.tag==='bounty' && s.enemyKey===DATA.choices.cards.bounty.find(c=>c.effectId===expected).enemyKey));
 assert.equal(ps.offers.filter(o=>o.source==='training').length,0);
 h.m.dispose();
});

test('multi-round A2 training continues with independent two-battle ordinary bounty',()=>{
 const h=setup(),ps=h.ps('p_0');
 const c=DATA.choices.cards.bounty.find(c=>c.effectId==='enemyeffect_2');
 assert.ok(c && c.rounds===99 && c.count===2 && c.coin===2);
 const id=h.m.addBounty(ps,c);
 assert.ok(h.drive(()=>h.m.phase===PHASE.PREP && h.m.round===5));
 const fields=FakeBattle.instances.filter(b=>b.kind==='normal' && b.spawns.some(s=>s.mods?.bountyId===id));
 assert.deepEqual(fields.map(f=>f.round),[2,3,4]);
 assert.ok(fields.every(f=>f.spawns.filter(s=>s.mods?.bountyId===id).reduce((n,s)=>n+s.count,0)===2));
 assert.ok(ps.bounties.some(b=>b.id===id));h.m.dispose();
});

test('AI resolves 教鞭 without treating the training card as an operator or selling a hand slot',()=>{
 const h=setup(),ps=h.ps('p_0');const art=giveItem(h.m,ps,ART);assert.deepEqual(use(h,art),{ok:true});
 const offered=ps.offers[0].slots.map(s=>s.id);
 botPrepBegin(h.m,ps);
 assert.ok(ps.bounties.some(b=>offered.includes(b.card.effectId)));
 assert.equal(ps.offers.filter(o=>o.source==='training').length,0);
 checkInvariants(h.m);h.m.dispose();
});
