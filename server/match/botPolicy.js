// Cooperative AI policy. ABYSS uses the provisional best candidate from the 2026-10-10 training round.
// Independent frozen validation: 37 wins / 128 games; stable >40% target not reached.
// 2026-10-11 V1 (validated on fresh seeds; docs/AI-AUDIT.md): ABYSS core preference against 叙拉古 (its deploy-time
// ASPD buff lapses in long late battles), Goliath strategy priority, and a counterfactually selected skill/module
// loadout for AI seats (same legality check as a human's loadout).
// 2026-10-12 V2 (docs/AI-AUDIT.md): 老鲤 strategy preference (forced-strategy study + fresh-seed A/B, 4-AI 268→301/720,
// p=0.019); blankProtect: with an idle human teammate (no operator on its board from round 2) every AI takes relay duty
// and rehearses its unite share (3 AI + idle 25-LP teammate screen: survival past R13 +2.4 pp, p=0.01). The economy
// knobs (econSweep, greyBank, …) exist in bot.js but stay off until a fresh-seed confirmation passes.
// 2026-10-12 V3 (docs/AI-AUDIT.md): with a human teammate the AIs no longer favour 歌利亚 (humanTeamBandBias /
// humanTeamBandLpWeight), one extra layout refinement pass, last-coin economy sweep, 变形同构体 waits for and pairs
// with its partner item (morphPairing), and band playbooks learned from submitted human matches (贾维: hold level 2
// to round 8, keep 拉普兰德, flip refresh engines; 变形者集群: 维多利亚). Fresh seeds 98001-98720, 3 AI + idle 25-LP
// teammate: teammate alive after R13 2.4% -> 5.4% (p<0.001), mean death round 8.64 -> 9.20; 4-AI 43.5% -> 45.4% (n.s.).
// 2026-10-12 port to upstream 0.2.5 (docs/PORT_NOTES_AI.md): prepRefreshes 8 keeps V3's validated paid-refresh budget
// (upstream's own cap is MAX_REFRESHES 16); bandScoring (V3 band softmax) is on only in the tuned ABYSS co-op table —
// elsewhere upstream's starting-LP band draw (test/match/bot.test.js expects its variety).
export const BOT_POLICY = Object.freeze({
  "bandLpWeight": 0.65,
  "coreLayerWeight": 0.45,
  "coreLayerCap": 90,
  "coreLayerValueMul": 1.35,
  "phaseAware": true,
  "bandDefenseBias": {
    "HARD": {
      "band_sciurus": -0.819,
      "band_orchid": -0.919,
      "band_bldsk": -0.903,
      "band_narant": -1.594,
      "band_sarkazb": 1.331,
      "band_amedic": 0.722,
      "band_mberry": -0.787,
      "band_makiri": 0.474,
      "band_dusk": 0.301,
      "band_harold": -0.114,
      "band_pepe": -0.782,
      "band_doberm": -0.259,
      "band_paganini": 1.42,
      "band_mlyss": 0.839,
      "band_duyaoy": 1.422
    },
    "ABYSS": {
      "band_orchid": -0.774,
      "band_amedic": -2.569,
      "band_bldsk": 1.137,
      "band_narant": -0.845,
      "band_clementia": -0.752,
      "band_dusk": 0.96,
      "band_sarkazb": 25,
      "band_harold": 0.055,
      "band_pepe": -0.805,
      "band_doberm": -1.271,
      "band_sciurus": 0.14,
      "band_paganini": 1.907,
      "band_mlyss": -0.166,
      "band_duyaoy": 1.923,
      "band_lmlee": 30
    }
  },
  "prepRefreshes": 8,
  "byDifficulty": {
    "ABYSS": {
      "bandScoring": true,
      "upgradeReserveCoins": 3,
      "upgradeReserveUntilRound": 7,
      "waveFitWeight": 1.35,
      "rolePenaltyWeight": 1.15,
      "mergeProgressWeight": 0.75,
      "coreActivationWeight": 0.7,
      "extraRehearsalPlans": 5,
      "rehearsalRosterCandidates": 4,
      "battleAddonLayers": true,
      "projectedFormation": true,
      "layerMilestones": true,
      "supportBondWeight": {
        "skillfulShip": 1.6,
        "arcaneShip": 1.6
      },
      "combatPowerWeight": 0.7,
      "skillPowerWeight": 0,
      "publicCoreCompetitionWeight": 1.4,
      "bossRehearsalPlans": 4,
      "bossRehearsalSeconds": 90,
      "corePreference": {
        "siracusaShip": -40
      },
      "blankProtect": true,
      "blankDefenseWeight": 40,
      "layoutRefinementPasses": 2,
      "econSweep": true,
      "humanTeamBandBias": {
        "band_sarkazb": 0
      },
      "humanTeamBandLpWeight": 0.3,
      "morphPairing": true,
      "bandPolicy": {
        "band_chiave": {
          "levelCap": [
            2,
            2,
            2,
            2,
            2,
            2,
            2,
            2,
            null
          ],
          "forceRefreshes": 0,
          "corePreference": {
            "siracusaShip": 40
          },
          "chessBonus": {
            "chess_char_2_16_a": 15,
            "chess_char_3_19_a": 12,
            "chess_char_3_18_a": 12,
            "chess_char_6_18_a": 20
          },
          "refreshFlip": true,
          "econSweep": true,
          "stackRefreshValue": 1.0,
          "holdBases": [
            "chess_char_2_16_a"
          ]
        },
        "band_damaztic": {
          "morphPairing": true,
          "corePreference": {
            "victoriaShip": 40
          },
          "positionLayerWeight": 4
        }
      },
      "botLoadout": {
        "chess_char_3_10_a": {
          "skill": 0
        },
        "chess_char_1_12_a": {
          "skill": 0
        },
        "chess_char_4_20_a": {
          "skill": 0
        },
        "chess_char_3_04_a": {
          "skill": 2
        },
        "chess_char_1_01_a": {
          "module": "none"
        }
      }
    }
  }
}
);

/**
 * 独立模拟 (solo) presets by difficulty (Match applies byDifficulty only in co-op). ABYSS, validated 2026-10-13 with draw
 * optimisation off (docs/AI-AUDIT.md): the co-op ABYSS table (incl. its band playbooks) plus the stronger core-layer
 * valuation — screening 12000 games: rounds passed +0.45 vs the bare defaults (p=3e-26); fresh-seed validation 2420
 * paired games: the layer valuation +0.05 rounds (p=0.006), +4 layers at R14 (p=0.005). Per-band core preferences from
 * the screening did not hold up (−0.07 rounds, p<0.001) and are not used. The strategy pick stays upstream's
 * starting-LP draw (bandScoring off): the solo studies forced the strategy per game, so the co-op band scoring was
 * not evaluated for solo. hiddenLayerDrive (2026-10-14, botStrategy.hiddenDrive): from R9 layers on active bonds are
 * worth 1.8× (add-ons like cores) while Σ active ≤ 350, and the R14 lineup over 350 scores +150 — fresh seeds 2400
 * paired games: 隐秘核心 eligibility 123 → 156 (McNemar 76:43, p=0.003), R14 layers +6.8 (p=0.0007), rounds and R14 wins
 * unchanged; a ×4 drive from R6 cost R14 wins (18 → 10) and is not used. battleLayerYield (2026-10-14): the measured
 * per-battle 特质 layer yield (botLayerYield.js) values layer-engine operators (缇缇, 瑕光, 史尔特尔, 圣约送葬人 …) in
 * buys and lineups — screening 4800 + fresh-seed validation 2400 paired games: Σ > 350 at R14 167 → 287 and 203 → 273
 * (McNemar 146:26, 115:45), R14 layers +38 / +28; R14 wins pooled 43:43, rounds +0.10 / −0.02 (n.s.).
 */
export const SOLO_POLICY = Object.freeze({
  ABYSS: Object.freeze({ ...BOT_POLICY.byDifficulty.ABYSS, coreLayerWeight: 0.9, coreLayerCap: 150, coreLayerValueMul: 2.4, bandScoring: false,
    hiddenLayerDrive: Object.freeze({ from: 9, mul: 1.8, addonAsCore: true, finalBonus: 150 }),
    battleLayerYield: Object.freeze({ scale: 1, cap: 40, recurringCap: 40, buyCap: 40 }) }),
});
