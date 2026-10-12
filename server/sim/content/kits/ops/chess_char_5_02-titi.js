// server/sim/content/kits/ops/chess_char_5_02-titi.js — 缇缇 (char_4056_titi) kit, tier 5.
// Conventions of the tier-5 kits: ../shared/tier5.js; kit contract and rules: ../README.md.
// The fork's kit (test/content/titi-original.test.js, PRTS skill notes / native titi_s_2): S2 pulses every 0.1 s and
// refreshes a 0.3 s 沉睡 on the enemies of the surrounding 3x3 grid (by their centre) around her and the ward — only the
// first application is an entry; the ward and she take 小睡 (`slumber`, buffs.js STATUS: invulnerable, disarmed, its own
// status distinct from 沉睡 so `hitSleep` cannot bypass it); cleansing 小睡 keeps the aura and S2's forced disarm. Her
// trait garrison_125 counts every sleep application (garrisons/battle.js), so it climbs to its 24 / 48 cap quickly.

import { COLS } from '../../../constants.js';
import { hasHp } from '../../../damage.js';
import {
  AURA_IV, AURA_DUR, num, on, talent, mods, dist, inFaction, isOp, selectedId, lazySkills, whileOn,
} from '../shared/tier5.js';

const isSargonMinos = (u) => inFaction(u, 'sargonShip', ['sargon', 'minos']);

/** Enemy not moving along its route (blocked, stunned, rooted, waiting…). */
const isStill = (e) => !!(e.blockedBy || !e.moving || e.s.flags.stun || e.s.flags.noMove || !(e.s.moveSpeed > 0));

export default {
  // ---------------------------------------------------------------------------------------------------------------
  // 缇缇 — S3 旧日绽放 (25 s): ATK +, 2 targets, sleeps non-sleeping targets; during the skill every enemy waking up (or
  // knocked out asleep) takes arts damage growing with the sleep time (linear min_atk_scale → max_atk_scale over `sleep` s,
  // PRTS 备注) and sends the highest-aggro enemy within range_radius to sleep; other allies in range fall asleep (小睡)
  // instead of dying. T1 凝固的时光: can attack sleeping enemies, +15 % ATK arts vs non-moving
  // enemies, sleeping enemies take 30 % ATK arts/s. T2 勇气的报偿: Sargon/Minos ops above 50 % HP get +20 ASPD.
  // S1 缓蚀 (duration): ATK +, attack@prob chance per attack to sleep the target attack@sleep s.
  // S2: independent doze and sleep auras; cleanse does not remove an aura. PRTS / native titi_s_2: 0.1 s / 0.3 s.
  chess_char_5_02_a: (bb, chess, def) => {
    const t0 = talent(chess, 0), t1 = talent(chess, 1);
    const sid = selectedId(chess, def);
    const hitSleep = num(bb['attack@sleep'], num(bb.sleep, 5));
    const minS = num(bb.min_atk_scale, 1), maxS = num(bb.max_atk_scale, minS);
    const chainSleep = num(bb.sleep, hitSleep), radius = num(bb.range_radius, 1.5), chainN = Math.max(1, num(bb.max_target, 1));
    const auraInterval = 0.1, auraSleep = 0.3, transferInterval = 0.034;
    // S2 封护: "第一天赋效果提升至N倍" while it runs
    const t0Scale = (unit) => (sid === 'skchr_titi_2' && unit.skill?.active ? num(bb.talent_scale, 1) : 1);
    const applyDoze = (battle, unit, a) => {
      if (!battle.applyStatus(a, 'slumber', { source: unit })) return;
      const b = a.findBuff('slumber');
      if (b) (b.data.titiSources ??= new Set()).add(unit);
    };
    const removeDoze = (battle, unit, a) => {
      const b = a.findBuff('slumber');
      if (b?.data.titiSources?.delete(unit) && !b.data.titiSources.size) battle.removeBuff(a, b);
    };
    const pulseWard = (battle, unit, a) => {
      // Native x-4 is the surrounding 3x3 grid, using the enemy's centre, not its hit area.
      for (const e of battle.enemies) {
        if (!on(e) || e.hidden || Math.abs(Math.round(e.x) - a.tileC) > 1 || Math.abs(Math.round(e.y) - a.tileR) > 1) continue;
        battle.applyStatus(e, 'sleep', { duration: auraSleep, source: unit });
      }
    };
    return {
      skills: lazySkills({
        skchr_titi_1: () => ({
          kind: 'duration', mods: mods({ atkPct: num(bb.atk) }),
          attack: {
            onHit({ battle, unit, target }) {
              if (!target || !target.alive || !battle.rng.chance(num(bb['attack@prob']))) return;
              battle.applyStatus(target, 'sleep', { duration: num(bb['attack@sleep']), source: unit });
            },
          },
        }),
        skchr_titi_2: () => ({
          kind: 'duration', mods: mods({ atkPct: num(bb.atk) }),
          flags: { disarm: true },
          attack: { noAttack: true },
          onStart({ battle, unit }) {
            const pick = battle.alliesInGrid(unit).filter((a) => a !== unit && isOp(a) && a.hp > 0)
              .sort((a, b) => a.hpRatio - b.hpRatio || a.id - b.id)[0] ?? null;
            unit.mem.titiWard = pick ? [unit, pick] : [unit];
            for (const a of unit.mem.titiWard) {
              applyDoze(battle, unit, a);
              battle.addBuff(a, {
                key: `titi:aura:${unit.id}`, source: unit, interval: auraInterval,
                onTick: ({ unit: carrier, buff }) => {
                  pulseWard(battle, unit, carrier);
                  if (!on(unit) || !unit.skill?.active) battle.removeBuff(carrier, buff);
                },
              });
              pulseWard(battle, unit, a);
            }
            battle.fx('sleepGuard', { x: unit.x, y: unit.y, id: unit.id });
          },
          onEnd({ battle, unit }) {
            for (const a of unit.mem.titiWard || []) {
              removeDoze(battle, unit, a);
            }
            unit.mem.titiWard = null;
          },
        }),
      }),
      trait: { hitSleep: true }, // 凝固的时光 (a): she targets and damages sleeping enemies (沉睡 = 无敌 for everyone else)
      skill: {
        kind: 'duration',
        mods: mods({ atkPct: num(bb.atk) }),
        attack: {
          maxTargets: Math.max(1, num(bb['attack@max_target'], 2)),
          onHit({ battle, unit, target }) {
            if (!target || target.kind !== 'enemy' || !target.alive || target.s.flags.sleep) return;
            battle.applyStatus(target, 'sleep', { duration: hitSleep, source: unit });
          },
        },
        onEnd({ battle, unit }) {
          for (const a of battle.allyUnits) {
            const b = a.findBuff('titi:allySleep');
            if (b && b.data.src === unit) {
              battle.removeBuff(a, b);
              removeDoze(battle, unit, a);
            }
          }
        },
      },
      talents: [
        { install(battle, unit) { // 凝固的时光 — (a) is the `hitSleep` trait above
          // (b) +extra_atk_scale arts vs non-moving enemies
          battle.on('damaged', (c) => {
            if (c.source !== unit || !c.dmg || !['phys', 'arts', 'true'].includes(c.type) || c.dmg.tags.includes('dot')) return;
            const e = c.target;
            if (e.side !== 'enemy' || !hasHp(e) || !isStill(e)) return;
            battle.dealDamage(unit, e, { amount: unit.s.atk * num(t0.extra_atk_scale) * t0Scale(unit), type: 'arts', canDodge: false, ignoreSleep: true, tags: ['talent', 'dot', 'titiStill'] });
          }, { owner: unit });
          // Every enemy owns its detection phase, reset by either skill mode transition.
          const nextDream = new Map();
          const resetDream = () => {
            nextDream.clear();
            if (on(unit)) for (const e of battle.enemies) if (e.alive) nextDream.set(e, battle.time + 0.5);
          };
          battle.on('deploy', ({ unit: a }) => {
            if (a === unit) resetDream();
            else if (a.kind === 'enemy' && on(unit)) nextDream.set(a, battle.time + 0.5);
          }, { owner: unit });
          for (const event of ['skillStart', 'skillEnd']) battle.on(event, ({ unit: a }) => { if (a === unit) resetDream(); }, { owner: unit });
          battle.on('tick', () => {
            if (!on(unit)) { nextDream.clear(); return; }
            for (const e of battle.enemies) {
              if (!e.alive) { nextDream.delete(e); continue; }
              const next = nextDream.get(e) ?? battle.time + 0.5;
              if (battle.time + 1e-9 < next) { nextDream.set(e, next); continue; }
              nextDream.set(e, next + 1);
              const concealed = e.s.flags.stealth && !e.s.flags.reveal && !e.blockedBy;
              if (e.s.flags.sleep && !e.hidden && !concealed && !e.s.flags.untargetable) {
                const amount = unit.s.atk * num(t0.damage_atk_scale) * t0Scale(unit);
                battle.dealDamage(unit, e, { amount, type: 'arts', canDodge: false, ignoreSleep: true, tags: ['talent', 'dot', 'titiDream'] });
              }
            }
          }, { owner: unit });
        } },
        { install(battle, unit) { // 勇气的报偿: 精力充沛
          whileOn(battle, unit, AURA_IV, () => {
            for (const a of battle.allies()) {
              if (isOp(a) && isSargonMinos(a) && a.hpRatio > num(t1.hp_ratio, 0.5)) battle.addBuff(a, { key: 'titi:vigor', duration: AURA_DUR, mods: { aspd: num(t1.attack_speed) } });
            }
          });
        } },
      ],
      install(battle, unit) {
        if (sid && sid !== 'skchr_titi_3') return;
        const asleep = new Map();
        let transferAcc = 0;
        const sleepOthers = (from) => {
          const cands = battle.enemiesInRadius(from.x, from.y, radius).filter((o) => o !== from && hasHp(o) && !o.def.immune?.has('sleep') && !o.mem?.candleOwner)
            .sort((a, b) => Number(!!a.s.flags.sleep) - Number(!!b.s.flags.sleep) || (b.s.taunt || 0) - (a.s.taunt || 0) || dist(a, from) - dist(b, from) || a.spawnSeq - b.spawnSeq);
          let n = 0;
          for (const o of cands) {
            if (n >= chainN) break;
            if (battle.applyStatus(o, 'sleep', { duration: chainSleep, source: unit })) n++;
          }
        };
        const settle = (e, started) => {
          const scale = minS + (maxS - minS) * Math.min(1, (battle.time - started) / 5);
          // Death / departure still transfers sleep, but cannot deal the final DoT.
          if (on(unit) && hasHp(e)) battle.dealDamage(unit, e, { amount: unit.s.atk * scale, type: 'arts', isSkill: true, canDodge: false, ignoreSleep: true, tags: ['skill', 'dot', 'titiWake'] });
          battle.fx('wake', { x: e.x, y: e.y, id: e.id, scale: Math.round(scale * 100) / 100 });
          sleepOthers(e);
        };
        battle.on('skillStart', ({ unit: a }) => {
          if (a !== unit) return;
          asleep.clear();
          transferAcc = 0;
        }, { owner: unit });
        battle.on('tick', ({ dt }) => {
          if (!unit.skill?.active || !on(unit)) return;
          transferAcc += dt;
          if (transferAcc < transferInterval - 1e-9) return;
          transferAcc %= transferInterval;
          // Snapshot first: a transfer cannot arm another target in the same check.
          const sleeping = battle.enemies.filter((e) => e.alive && (e.s.flags.sleep || e.s.flags.slumber));
          for (const [e, started] of [...asleep]) {
            if (!asleep.has(e)) continue; // A previous burst may already have killed and settled this target.
            if (e.alive && (e.s.flags.sleep || e.s.flags.slumber)) continue;
            asleep.delete(e);
            settle(e, started);
          }
          for (const e of sleeping) if (e.alive && !asleep.has(e)) asleep.set(e, battle.time);
        }, { owner: unit });
        battle.on('skillEnd', ({ unit: a }) => {
          if (a !== unit) return;
          const pending = [...asleep];
          asleep.clear();
          // skillEnd runs after ATK modifiers are removed; final bursts use the normal ATK.
          for (const [e, started] of pending) settle(e, started);
        }, { owner: unit });
        battle.on('kill', (c) => {
          const v = c.victim;
          if (v.side !== 'enemy' || !asleep.has(v)) return;
          const started = asleep.get(v);
          asleep.delete(v);
          if (unit.skill?.active && on(unit)) settle(v, started);
        }, { owner: unit });
        // S3: other allies in range fall asleep instead of dying, until healed to full or the skill ends
        battle.on('fatal', (c) => {
          const a = c.unit;
          if (c.prevented || a.side !== 'ally' || a === unit) return;
          const guard = a.findBuff('titi:allySleep');
          if (guard && a.s.flags.slumber) { if (guard.data.src === unit) c.prevented = true; return; }
          if (!isOp(a) || !unit.skill?.active || !on(unit) || !unit.rangeKeySet?.has(a.tileR * COLS + a.tileC)) return;
          c.prevented = true;
          applyDoze(battle, unit, a);
          battle.addBuff(a, {
            key: 'titi:allySleep', data: { src: unit },
            onTick: ({ unit: x, buff }) => {
              if (!x.s.flags.slumber || x.hp >= x.s.maxHp - 1e-6) {
                battle.removeBuff(x, buff);
                removeDoze(battle, unit, x);
              }
            },
          });
          battle.fx('sleepGuard', { x: a.x, y: a.y, id: a.id });
        }, { owner: unit, priority: -4000 });
      },
    };
  },
};
