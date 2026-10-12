import test from 'node:test';
import assert from 'node:assert/strict';
import {makeMatch} from './harness.js';
import {battleLayerValue,usefulLayerAmount,layerValue} from '../../server/match/botStrategy.js';
import {formationGrowth} from '../../server/match/bot.js';

test('small combat bonds receive bounded growth only when deployed and activated',t=>{
 const h=makeMatch({mode:'solo',fake:true,seed:8101}).start();h.toPrep(3);const m=h.m,ps=h.ps('p_0');t.after(()=>m.dispose());
 const c=Object.values(m.gd.raw.chess).find(c=>!c.isGolden && c.garrisonIds?.some(id=>{const g=m.gd.garrison(id);return g?.effectKey==='act1autochess_gar_event_selfkillenemy' && g.bbStr?.bond_id?.includes('steadShip');}));
 assert.ok(c);const piece={kind:'chess',id:c.chessId,uid:900};
 const state={bonds:{steadShip:{active:true,count:2,layers:0}}};
 m.botPolicy.battleAddonLayers=false;assert.equal(battleLayerValue(m,ps,piece,state),0);
 m.botPolicy.battleAddonLayers=true;assert.ok(battleLayerValue(m,ps,piece,state)>0);assert.ok(battleLayerValue(m,ps,piece,state)<=8);
 assert.equal(battleLayerValue(m,ps,piece,{...state,bench:true}),0);
 assert.equal(battleLayerValue(m,ps,piece,{bonds:{steadShip:{active:false,count:1}}}),0);
});

test('probability saturation and real milestones guide investment without changing persistent layers',t=>{
 const h=makeMatch({mode:'solo',fake:true,seed:8102}).start();h.toPrep(3);const m=h.m,ps=h.ps('p_0');t.after(()=>m.dispose());
 ps.layers.indomShip=210;assert.equal(usefulLayerAmount(m,ps,'indomShip',10),0);
 ps.layers.swiftShip=300;assert.equal(usefulLayerAmount(m,ps,'swiftShip',10),0);
 ps.layers.skillfulShip=38;assert.equal(usefulLayerAmount(m,ps,'skillfulShip',2),3);
 ps.layers.skillfulShip=40;assert.equal(usefulLayerAmount(m,ps,'skillfulShip',2),2);
 ps.layers.visiShip=148;assert.equal(usefulLayerAmount(m,ps,'visiShip',2),3);
 m.round=m.gd.bossRound;assert.equal(usefulLayerAmount(m,ps,'visiShip',2),2);
 assert.equal(ps.layers.visiShip,148);assert.equal(usefulLayerAmount(m,ps,'soloShip',10),0);
});

test('positional growth uses projected activation and equipment membership, and prep-start has no future at final round',t=>{
 const h=makeMatch({mode:'solo',fake:true,seed:8103}).start();h.toPrep(3);const m=h.m,ps=h.ps('p_0');t.after(()=>m.dispose());
 const source=Object.values(m.gd.raw.chess).find(c=>c.name==='断崖'&&!c.isGolden);
 const target=Object.values(m.gd.raw.chess).find(c=>c.visible&&!c.isGolden&&c.bonds.includes('yanShip'));
 const entries=[{piece:{id:source.chessId,kind:'chess',uid:901},r:2,c:2,dir:'RIGHT'},{piece:{id:target.chessId,kind:'chess',uid:902},r:2,c:1,dir:'RIGHT'}];
 const bonds={yanShip:{active:true,count:3,layers:0}};const state={board:new Map(entries.map((e,i)=>[String(i),e.piece])),hand:[],bonds};
 m.botPolicy.projectedFormation=true;m.botPolicy.formationGrowthWeight=1;
 assert.ok(formationGrowth(m,ps,entries,state)>0);
 assert.equal(formationGrowth(m,ps,entries,{...state,bonds:{yanShip:{active:false,count:1}}}),0);
 const neutral=Object.values(m.gd.raw.chess).find(c=>c.visible&&!c.isGolden&&!c.bonds.includes('yanShip'));
 const adaptor=Object.values(m.gd.raw.items).find(it=>it.canGiveBond);
 const grant=Object.values(m.gd.raw.items).find(it=>it.giveBondId==='yanShip'&&!it.canGiveBond);
 assert.ok(adaptor&&grant);
 entries[1].piece.id=neutral.chessId;entries[1].piece.items=[{id:adaptor.id},{id:grant.id}];
 assert.ok(formationGrowth(m,ps,entries,state)>0,'equipment-granted core is counted');
 entries[1].piece.items=[];assert.equal(formationGrowth(m,ps,entries,state),0);
 entries[1].piece.id=target.chessId;

 const arco=Object.values(m.gd.raw.chess).find(c=>c.name==='空弦'&&!c.isGolden);entries[0].piece.id=arco.chessId;
 // 空弦 grants to the front rather than behind.
 entries[1].c=3;
 assert.ok(formationGrowth(m,ps,entries,state)>0);
 m.round=m.gd.bossRound;assert.equal(formationGrowth(m,ps,entries,state),0);
});
