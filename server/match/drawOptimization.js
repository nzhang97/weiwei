// Relative weights multiply remaining-copy weights; ties share a rank.
const MULTIPLIERS = [3, 2.5, 2, 1.5];
export function chessDrawWeight(gd, layers, enabled) {
  if (!enabled) return undefined;
  const eligible=Object.entries(layers || {}).filter(([id,n])=>gd.bond(id) && !gd.bond(id).noStack && Number.isFinite(n) && n>0);
  const levels=[...new Set(eligible.map(([,n])=>n))].sort((a,b)=>b-a);
  const weights=new Map(eligible.map(([id,n])=>[id,MULTIPLIERS[levels.indexOf(n)] || 1]));
  return id => Math.max(1,...(gd.chess(id)?.bonds || []).map(b=>weights.get(b) || 1));
}
