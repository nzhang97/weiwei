#!/usr/bin/env node
// Bounded, shrunk band-defense estimates; never use holdout data for fitting.
import fs from 'node:fs';
import {defenseMetrics} from './ai-training-score.mjs';
const inputs=process.argv.slice(2);if(!inputs.length)throw new Error('Pass calibration/diversity report paths');
const samples=[];
for(const file of inputs)for(const result of JSON.parse(fs.readFileSync(file,'utf8')).results)for(const [id,band] of Object.entries(result.bands)){
 const rows=result.rounds.map(r=>({round:r.round,players:{ai_0:r.players[id]}}));
 samples.push({difficulty:result.difficulty,band,score:defenseMetrics(rows,{players:1}).defenseScore});
}
const bias={},estimates=[];
for(const difficulty of ['HARD','ABYSS']){
 const rows=samples.filter(r=>r.difficulty===difficulty);const mean=rows.reduce((n,r)=>n+r.score,0)/rows.length;
 bias[difficulty]={};
 for(const band of [...new Set(rows.map(r=>r.band))]){
  const records=rows.filter(r=>r.band===band),avg=records.reduce((n,r)=>n+r.score,0)/records.length;
  const weight=Math.max(-15,Math.min(15,(avg-mean)*0.15*records.length/(records.length+8)));
  bias[difficulty][band]=Number(weight.toFixed(3));estimates.push({difficulty,band,samples:records.length,score:avg,bias:weight});
 }
}
const policy={bandLpWeight:0.65,coreLayerWeight:0.45,coreLayerCap:90,coreLayerValueMul:1.35,phaseAware:true,bandDefenseBias:bias};
fs.writeFileSync(new URL('../server/match/botPolicy.js',import.meta.url),'// Four-AI calibration; per-band defense estimates are bounded and shrunk toward zero.\nexport const BOT_POLICY = Object.freeze('+JSON.stringify(policy,null,2)+');\n');
console.log(JSON.stringify({policy,inputs,sampleCount:samples.length,estimates}));
