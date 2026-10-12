// shared/summonRange.js — where a tactician's placeable summons may go (server PlayerState and client gameLogic).
//
// PRTS 战术家 trait "可以在攻击范围内选择一次战术点来召唤援军": a summon of a tactician owner (伺夜's 狼群,
// 缪尔赛思's 流形 …; data/chess.json subProfessionId 'tactician') may only be deployed on a deployable tile inside
// the owner's attack range as it stands on the board (its tile and facing). Other owners' summons are unrestricted.
import { attackRangeGrid } from './loadoutRecord.js';

/** Whether summons of this (chess) record are confined to its attack range. */
export function summonRangeLimited(ownerRec) {
  return !!ownerRec && ownerRec.subProfessionId === 'tactician';
}

// [dRow, dCol] of a facing-RIGHT range offset for facing `dir` — same mapping as server/sim/dir.js rotateOffset
function rot(dr, dc, dir) {
  switch (dir === -1 ? 'LEFT' : dir === 1 ? 'RIGHT' : String(dir || 'RIGHT').toUpperCase()) {
    case 'UP': return [dc, 0 - dr];
    case 'LEFT': return [0 - dr, 0 - dc];
    case 'DOWN': return [0 - dc, dr];
    default: return [dr, dc];
  }
}

/**
 * Absolute "r,c" tile keys of the owner's attack range (its own tile excluded: a summon cannot share it).
 * @param {object} ownerRec chess record (loadout-resolved when available)
 * @param {number} r owner row  @param {number} c owner col  @param {string|number} dir owner facing
 * @returns {Set<string>}
 */
export function summonRangeKeys(ownerRec, r, c, dir) {
  const out = new Set();
  const grid = attackRangeGrid(ownerRec) || [[0, 0]];
  for (const cell of grid) {
    if (!Array.isArray(cell) || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) continue;
    const [ar, ac] = rot(cell[0], cell[1], dir);
    if (ar === 0 && ac === 0) continue;
    out.add(`${r + ar},${c + ac}`);
  }
  return out;
}

/** True when a summon of `ownerRec` (standing at r0,c0 facing dir) may be put on (r, c). */
export function summonTileAllowed(ownerRec, r0, c0, dir, r, c) {
  if (!summonRangeLimited(ownerRec)) return true;
  return summonRangeKeys(ownerRec, r0, c0, dir).has(`${r},${c}`);
}
