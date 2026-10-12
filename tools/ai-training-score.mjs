// Fixed horizon prevents an eliminated bot improving its average by skipping hard rounds.
export function defenseMetrics(rounds, {normalRounds=13,players=4,roundsPassed=0,victory=false}={}) {
 let totalLeaks=0,missing=0,perfect=0,rateSum=0,defense=0;
 for(let round=1;round<=normalRounds;round++) for(let seat=0;seat<players;seat++) {
  const row=rounds.find(r=>r.round===round)?.players?.[`ai_${seat}`];
  if(!row || !row.aliveBefore || !Number.isFinite(row.leaks)) {missing++;defense-=350;continue;}
  const leaks=row.leaks,total=Math.max(1,row.total || 0);
  totalLeaks+=leaks;rateSum+=Math.min(1,leaks/total);
  if(leaks===0)perfect++;
  defense+=100-25*leaks-100*Math.min(1,leaks/total);
 }
 const slots=normalRounds*players;
 const defenseScore=defense/slots;
 return {score:defenseScore+Math.min(normalRounds,roundsPassed)*0.2+(victory?5:0),defenseScore,totalLeaks,missing,perfect,perfectRate:perfect/slots,meanLeakRate:rateSum/slots,meanLeaksPerObservedRound:totalLeaks/Math.max(1,slots-missing)};
}
