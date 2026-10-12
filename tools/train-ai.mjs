#!/usr/bin/env node
// Four AI only; legal game resources, full combat, draw optimization on.
import fs from 'node:fs';
import {BOT_POLICY} from '../server/match/botPolicy.js';
import {Match} from '../server/match/Match.js';
import {VirtualScheduler} from '../server/match/scheduler.js';
import {attachAudit} from '../server/match/audit.js';
import {getData} from '../server/data.js';
import {defenseMetrics} from './ai-training-score.mjs';
const opt={};for(let i=2;i<process.argv.length;i+=2)opt[process.argv[i].slice(2)]=process.argv[i+1];
const policies={mature:{...BOT_POLICY,positionEngineWeight:0.7,positionTargetCredit:0.5,positionEngineMinRound:5,positionEngineCoreOnly:true},conservative:{...BOT_POLICY,positionEngineWeight:0.7,positionTargetCredit:0.5},targeted:{...BOT_POLICY,positionEngineWeight:1.4,positionTargetCredit:0.5,supportBondWeight:{skillfulShip:1.1,arcaneShip:1.1}},previous:BOT_POLICY,support:{...BOT_POLICY,positionEngineWeight:1.4,positionTargetCredit:0.5},synergy:{...BOT_POLICY,positionEngineWeight:1.8,positionTargetCredit:0.5,supportBondWeight:{skillfulShip:1.25,arcaneShip:1.2}},anchors:{...BOT_POLICY,positionEngineWeight:1.4,positionTargetCredit:0.5,supportBondWeight:{skillfulShip:1.15,arcaneShip:1.15},coreBandBonus:6},trained:BOT_POLICY,phase:{bandLpWeight:0.65,coreLayerWeight:0.45,coreLayerCap:90,coreLayerValueMul:1.35,phaseAware:true},moderate:{bandLpWeight:0.65,coreLayerWeight:0.45,coreLayerCap:90,coreLayerValueMul:1.35},baseline:{bandLpWeight:1.3,coreLayerWeight:0.3,coreLayerCap:45,coreLayerValueMul:1},balanced:{bandLpWeight:0.2,coreLayerWeight:0.6,coreLayerCap:120,coreLayerValueMul:1.8},layered:{bandLpWeight:0.1,coreLayerWeight:0.9,coreLayerCap:150,coreLayerValueMul:2.4},cautious:{bandLpWeight:0.35,coreLayerWeight:0.6,coreLayerCap:120,coreLayerValueMul:1.5}};
const policy=opt['policy-file'] ? JSON.parse(fs.readFileSync(opt['policy-file'],'utf8')) : policies[opt.policy || 'trained'];if(!policy)throw new Error('Unknown policy');
const data=getData({log:{info(){},warn(){},error(){}}});
const results=[];
for(const difficulty of (opt.difficulty || 'HARD,ABYSS').split(',')) for(let seed=Number(opt.seed || 3101);seed<Number(opt.seed || 3101)+Number(opt.seeds || 2);seed++){
 const scheduler=new VirtualScheduler(),errors=[],rounds=[];let summary;let bossRehearsals=0;
 const m=new Match({mode:'coop',difficulty,seed,data,scheduler,botPolicy:policy,drawOptimization:true,aiOperatorBuff:false,humanOperatorBuff:false,aiRound34Nerf:false,freeOperatorPick:false,botRehearsal:3,
  seats:Array.from({length:4},(_,seat)=>({seat,playerId:`ai_${seat}`,name:`AI${seat}`,isBot:true,connected:true})),
  log:{info(){},warn:(...x)=>{const message=x.join(' ');if(/rehearsal failed/.test(message))errors.push(message);},error:(...x)=>errors.push(x.join(' '))},send:()=>true,broadcast(){},onEnd:s=>summary=s});
 const buildBattle=m.newBattle.bind(m);m.newBattle=opts=>{if(opts.fieldId?.startsWith('boss-rehearse:'))bossRehearsals++;return buildBattle(opts);};
 const forced=(opt.bands || '').split(',').filter(Boolean);
 if(forced.length){
  const pick=m.scheduleBandBot.bind(m);
  m.scheduleBandBot=()=>{
   const ps=m.players.get(m.draftTurn());
   const id=forced[((seed-Number(opt.seed || 3101))*4+ps.seat)%forced.length];
   if(!m.gd.bandIds().includes(id) || m.bandTaken(id,ps.playerId)) return pick();
   m.later(0,()=>{if(m.phase==='BAND_DRAFT'&&m.draftTurn()===ps.playerId)m._applyBand(ps,id,{dedupe:true});});
  };
 }
 const settle=m.settle.bind(m);m.settle=(plan,result)=>{
  const players=Object.fromEntries(m.order.map(ps=>{const r=m.lastResults.get(ps.playerId);return [ps.playerId,{aliveBefore:ps.alive,lp:ps.lp,shopLevel:ps.shop.level,deployCount:ps.deployCount,roster:[...ps.board.values()].filter(p=>p.kind==='chess').map(p=>({id:p.id,items:(p.items||[]).map(x=>x.id)})),leaks:r?(r.leaked || []).filter(l=>l.counted!==false).length:null,total:r?.total || 0,band:ps.bandId,core:ps._botCore?.id,activeBonds:Object.fromEntries(Object.entries(ps.bonds).filter(([,b])=>b.active).map(([id,b])=>[id,{count:b.count,tier:b.tier,layers:b.layers}])),layers:{...ps.layers},positionEngines:[...ps.board.values()].filter(p=>p.kind==='chess' && (m.gd.chess(p.id)?.garrisonIds || []).some(id=>m.gd.garrison(id)?.effectKey==='SERVER_ADD_BOND_POSITION')).map(p=>({id:p.id,name:m.gd.chess(p.id).name})),smallBonds:Object.fromEntries(['skillfulShip','arcaneShip'].map(id=>[id,{active:ps.bonds[id]?.active || false,layers:ps.layers[id] || 0}]))}];}));
  rounds.push({round:m.round,players});return settle(plan,result);
 };
 const audit=attachAudit(m,{invariants:true});const start=Date.now();m.start();scheduler.runUntil(()=>!!summary,{maxSteps:5e6});
 if(!summary)errors.push(`stuck ${m.phase} R${m.round}`);
 const result={seed,difficulty,policy:opt.label || opt.policy || 'trained',stageId:m.stageId,parameters:policy,ms:Date.now()-start,victory:summary?.victory,roundsPassed:summary?.roundsPassed,
  bossRehearsals,finishReason:summary?.reason,aliveAtEnd:m.alivePlayers().length,teamLpAtEnd:m.teamLp,bossPoolAtEnd:m.bossPool?{hp:m.bossPool.hp,maxHp:m.bossPool.maxHp}:null,
  bands:Object.fromEntries(m.order.map(ps=>[ps.playerId,ps.bandId])),rounds,metrics:defenseMetrics(rounds,{normalRounds:m.gd.bossRound-1,roundsPassed:summary?.roundsPassed || 0,victory:summary?.victory}),
  errors,matchErrors:m.errorCount,simErrors:m.simErrorLog.size,metaErrors:m.dispatcher.errors,schedulerErrors:scheduler.errors,violations:audit.violations};
 results.push(result);m.dispose();console.error(JSON.stringify({seed,difficulty,policy:result.policy,ms:result.ms,metrics:result.metrics,bands:result.bands}));
}
const report={protocol:{players:4,bots:4,humans:0,drawOptimization:true,botRehearsal:3,statBoosts:false,aiOperatorBuff:false,humanOperatorBuff:false,aiRound34Nerf:false,freeOperatorPick:false,policy,forcedBands:(opt.bands || '').split(',').filter(Boolean),objective:'fixed-horizon per-round own-field leaks, before ally assistance; progression only a small secondary bonus'},results};
if(opt.output)fs.writeFileSync(opt.output,JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report));
if(results.some(r=>r.errors.length || r.matchErrors || r.simErrors || r.metaErrors || r.schedulerErrors.length || r.violations.length))process.exitCode=1;
