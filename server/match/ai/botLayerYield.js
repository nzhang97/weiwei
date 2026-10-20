// server/match/ai/botLayerYield.js — empirical IN_BATTLE layer yield per deployed operator and battle (botPolicy.battleLayerYield).
// Source: solo ABYSS layer ledger (tools/ai/airun.mjs --ledger on), seeds 450001–450020, 40 forced strategies, 800 games,
// draw optimisation off: layers each operator's 特质 added in normal battles R1–R13 on real fields (rehearsals excluded),
// by bond, divided by (battles deployed + 5) (shrunk toward 0). The gains land only on active bonds, so the entries
// already reflect how often the target bond was active while the operator fought. Regenerate after content changes.
export const BATTLE_LAYER_YIELD = Object.freeze({
 "chess_char_2_01_a": {
  "lateranoShip": 0.53,
  "preciShip": 2.03
 },
 "chess_char_2_01_b": {
  "lateranoShip": 2.21,
  "preciShip": 4.07
 },
 "chess_char_2_06_a": {
  "sargonShip": 4.86
 },
 "chess_char_2_06_b": {
  "sargonShip": 9.38
 },
 "chess_char_2_07_a": {
  "egirShip": 0.85
 },
 "chess_char_2_07_b": {
  "egirShip": 2.68
 },
 "chess_char_2_09_a": {
  "raidShip": 1.98
 },
 "chess_char_2_12_a": {
  "indomShip": 0.42,
  "kazimierzShip": 1.71
 },
 "chess_char_2_12_b": {
  "indomShip": 2.0,
  "kazimierzShip": 4.47,
  "preciShip": 0.32
 },
 "chess_char_3_05_a": {
  "egirShip": 0.27,
  "raidShip": 1.55,
  "steadShip": 1.62
 },
 "chess_char_3_05_b": {
  "egirShip": 3.23,
  "raidShip": 5.65,
  "steadShip": 3.6
 },
 "chess_char_3_06_a": {
  "sargonShip": 4.88
 },
 "chess_char_3_06_b": {
  "sargonShip": 10.79
 },
 "chess_char_3_09_a": {
  "arcaneShip": 2.36,
  "egirShip": 0.68
 },
 "chess_char_3_09_b": {
  "arcaneShip": 4.33,
  "egirShip": 1.0
 },
 "chess_char_3_12_a": {
  "kazimierzShip": 5.9,
  "raidShip": 5.59
 },
 "chess_char_3_12_b": {
  "kazimierzShip": 13.64,
  "raidShip": 15.32
 },
 "chess_char_3_14_a": {
  "kjeragShip": 1.69,
  "preciShip": 0.21
 },
 "chess_char_3_14_b": {
  "kjeragShip": 4.44
 },
 "chess_char_3_19_a": {
  "miraShip": 1.45,
  "siracusaShip": 3.02
 },
 "chess_char_3_19_b": {
  "miraShip": 4.2,
  "siracusaShip": 10.8
 },
 "chess_char_3_20_a": {
  "preciShip": 0.24
 },
 "chess_char_4_02_a": {
  "lateranoShip": 0.49
 },
 "chess_char_4_02_b": {
  "lateranoShip": 1.87
 },
 "chess_char_4_07_a": {
  "indomShip": 0.7,
  "victoriaShip": 1.75,
  "visiShip": 1.25
 },
 "chess_char_4_07_b": {
  "indomShip": 2.82,
  "victoriaShip": 3.29,
  "visiShip": 3.29
 },
 "chess_char_4_13_a": {
  "preciShip": 0.28
 },
 "chess_char_4_13_b": {
  "kazimierzShip": 0.28,
  "preciShip": 0.76
 },
 "chess_char_4_14_b": {
  "preciShip": 1.05
 },
 "chess_char_4_16_a": {
  "preciShip": 0.62
 },
 "chess_char_4_17_a": {
  "preciShip": 0.24
 },
 "chess_char_4_20_a": {
  "kazimierzShip": 0.89,
  "preciShip": 1.24
 },
 "chess_char_4_20_b": {
  "kazimierzShip": 3.13,
  "preciShip": 2.78
 },
 "chess_char_4_22_a": {
  "kjeragShip": 2.72
 },
 "chess_char_4_22_b": {
  "kjeragShip": 2.0
 },
 "chess_char_4_23_a": {
  "sargonShip": 10.35
 },
 "chess_char_4_23_b": {
  "sargonShip": 20.47
 },
 "chess_char_5_01_a": {
  "lateranoShip": 6.77,
  "visiShip": 2.55
 },
 "chess_char_5_01_b": {
  "lateranoShip": 19.76,
  "visiShip": 4.59
 },
 "chess_char_5_02_a": {
  "preciShip": 13.26,
  "sargonShip": 12.73
 },
 "chess_char_5_07_a": {
  "raidShip": 16.3
 },
 "chess_char_5_07_b": {
  "raidShip": 24.0
 },
 "chess_char_5_13_a": {
  "egirShip": 5.85,
  "indomShip": 6.1
 },
 "chess_char_5_13_b": {
  "egirShip": 10.0,
  "indomShip": 1.54
 },
 "chess_char_5_19_b": {
  "kazimierzShip": 0.8
 },
 "chess_char_6_01_a": {
  "preciShip": 0.2
 },
 "chess_char_6_09_a": {
  "lateranoShip": 1.13,
  "preciShip": 4.17,
  "raidShip": 0.43,
  "sargonShip": 1.3,
  "skillfulShip": 0.43,
  "visiShip": 0.78
 },
 "chess_char_6_18_a": {
  "siracusaShip": 16.9
 },
 "chess_char_6_19_a": {
  "kazimierzShip": 3.42,
  "kjeragShip": 5.38,
  "swiftShip": 5.94
 },
 "chess_char_6_20_a": {
  "kazimierzShip": 0.27,
  "sargonShip": 0.55,
  "steadShip": 0.27
 }
});
