import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeMatch,give,checkInvariants} from './harness.js';

test('至简 at 远见 150 layers is displayed and purchased for zero coins; 149 layers still costs one',()=>{
 const h=makeMatch({mode:'solo',difficulty:'HARD',seed:150}).start();h.toPrep(1);
 const m=h.m,ps=h.ps('p_0');
 give(m,ps,'chess_char_2_02_a','hand');give(m,ps,'chess_char_5_21_a','hand');
 assert.ok(ps.bonds.visiShip.active);
 const slot={kind:'chess',id:'chess_char_3_13_a',basePrice:3,frozen:true,sold:false};ps.shop.slots[0]=slot;
 ps.addLayers('visiShip',80);
 assert.equal(ps.priceOf(slot),1,'至简 is not a 远见 member; the 80-layer reduction does not apply');
 const visi={kind:'chess',id:'chess_char_4_04_a',basePrice:3};
 assert.equal(ps.priceOf(visi),2);
 ps.addLayers('visiShip',69);assert.equal(ps.priceOf(slot),1);
 ps.addLayers('visiShip',1);assert.equal(ps.priceOf(slot),0);
 assert.equal(ps.priceOf(visi),2,'150 replaces the 80-layer discount');
 assert.equal(ps.privateView().shop.slots[0].price,0,'frozen slot updates in the client view');
 ps.funds=0;const before=ps.round.spent;
 assert.deepEqual(m.handle('p_0',{t:'g.buy',slot:0}),{ok:true});
 assert.equal(ps.funds,0);assert.equal(ps.round.spent,before);
 assert.ok(ps.allChess().some(c=>c.id==='chess_char_3_13_a'));
 assert.equal(slot.sold,true);
 assert.notEqual(m.handle('p_0',{t:'g.buy',slot:0}).ok,true);
 assert.equal(ps.priceOf({kind:'chess',id:'chess_char_1_02_a',basePrice:0}),0);
 // A milestone discount is permanent, even when no 远见 members remain deployed or in hand.
 for(const piece of ps.allChess().filter(c=>m.gd.chess(c.id).bonds.includes('visiShip')))assert.equal(ps.sell(piece.uid).ok,true);
 ps.recompute();assert.ok(!ps.bonds.visiShip.active);
 assert.equal(ps.priceOf({...slot,sold:false}),0);
 checkInvariants(m);m.dispose();
});
