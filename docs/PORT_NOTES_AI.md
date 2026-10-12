# PORT_NOTES_AI — V3 AI teammate logic on upstream 0.2.5

Target tree: `v025_port_src` (upstream 0.2.5 + the already-ported action log / room options). Sources: the fork's V3
(`ai_ours/ours/…`), the common ancestor `ai_ours/base/server/match/bot.js`, and `airun_experiment_latest.mjs`.

## 1. How bot.js was merged

`server/match/bot.js` was split into its 112 top-level declarations (functions / constants) for each of base, V3 and
upstream, then rebuilt in upstream's order:

| class | count | handling |
|---|---|---|
| unchanged in both | 27 | upstream text |
| changed only upstream | 10 | upstream (runSteps, LEVEL_TARGET, chessRec, isHealer, isBlocker, roles, rangeTiles, unitOf, supportSpot, resolveTemp) |
| changed only V3 | 8 | V3 (TIER_POWER, power, Layout, planLayout, countedLeaks, createRehearsalSteps, lineupGain, arrangeSteps) |
| new upstream | 43 | all kept (bondPlan, refreshValue, maybeFreeze, armorFit / effDps / crowdOf, bountyScore / tacticScore, itemTarget / cellTarget / useArt, makeHandRoom, freeHandSlot, rememberOwned / unseen, fundsReserve, diyOpensAt, DIY_PIECE_BONUS, …) |
| new V3 | 32 | all kept, inserted after their V3 predecessor (econ sweep, overlay, refresh flip, support swap, waveFit, botUnitRecord, …) |
| changed in both | 26 | hand-merged, below |
| deleted | traitsOf & its 3 regexes (V3 replaced them by botStrategy values; upstream only used them in unitBase / buyScore), focusBond (upstream replaced it by bondPlan, V3 by corePlan — see context) |

Every V3 block uses the player's data view (`ps.gd`, upstream's 自选 records) instead of `m.gd` where it has `ps`, and
`pol(m)` = `m.botPolicy || BOT_POLICY` instead of `m.botPolicy` (stub matches and old callers have no policy).

## 2. Conflict areas — what was kept and why

| area | upstream mechanism (kept) | V3 layer (wired on top) | decision |
|---|---|---|---|
| band pick (botPickBand) | inactive-bond bands weigh 0; living teammates' strategy bonds soft-reserved × SOFT_BAND_RESERVE; one rng draw | bandScore softmax (humanTeamBandBias / humanTeamBandLpWeight, bandDefenseBias, bandTemperature), forceBands, taken-band filter | V3 softmax replaces the starting-LP weight **only when `botPolicy.bandScoring === true`**, which is set in `byDifficulty.ABYSS` (the co-op table it was tuned/validated on). Upstream's exclusions multiply both. Reason: upstream's `bot.test.js` requires 老鲤 to stay drawable in a one-seat NORMAL co-op room (V3's softmax gave 0/60). Also V3's no-teammate 老鲤 penalty (−30) now applies in solo only (one-seat co-op: −9). |
| 机变 cards (botPickCard) | bountyScore (expected payout − expected LP loss via bountyKillChance), tacticScore, canUseItem −8 | item card by bestEquipmentTarget; low-LP bounty penalty; 盟誓 add-layer card by layerValue (+ teammates for team cards) | items: V3 score + upstream −8; bounties: upstream score − V3 low-LP penalty; tactic: `v3TacticScore` for `global_special_choice_bond_addlayer` cards, upstream tacticScore for all others. |
| core / focus bond planning (context) | bondPlan: focus + second, teammate main-core avoidance, keeperBases, copyCounts, pairs | corePlan (opening strategy, distinct members, layers, shop access, relay value, publicCoreCompetition, corePreference, extraCoreTargets) | `ctx.focus` = corePlan's core, falling back to bondPlan.focus; `ctx.second` = bondPlan.second (or bondPlan.focus when it differs from the V3 focus); keeper/copies/pairs from upstream with the merged plan. `botPolicy.corePlanFocus: false` reverts to upstream's focus. tacticScore / bondPlan (exported, tested) unchanged. |
| bond value (bondValue) | `second` bonus, committed-core penalty | phase recruitment weights (coreRecruitWeights / addonRecruitWeight), focus ×2.2 / +18 | V3 weights + upstream second / committed terms. |
| unit / piece value (unitBase, pieceValue) | chessRec with ps; armour fit (ARMOR_WEIGHT · armorFit) | projected unit power (botUnitRecord), combatPowerWeight, waveFit × botWaveWeight, recurringValue | both. Signature is V3's `unitBase(m, ps, piece, ctx, projection)`. **Risk:** armorFit and waveFit both see DEF/RES. |
| lineup (lineupScore, chooseLineup) | dedupe of identical pieces, deterministic tie-break, value map; FOCUS_MEMBER per focus member | lineupState projection, policy tier weights, core-target bonus, combatBondValue, lane-aware role penalties, bestSupportSwap pair search | V3 lineupScore (its focus-member term replaces upstream FOCUS_MEMBER — same idea, counted to the core target); upstream chooseLineup search + V3 support-pair step. A memo reuses chooseLineup's result while its inputs are unchanged (cost only; identical outcomes on the 6 smoke seeds before/after). |
| buy score (buyScore) | merge values from ctx.copies / keepers / MAX_PAIRS, armour fit, DIY bonus, −18 high-tier teammate-faction penalty | combat power, waveFit, recurring / gain traits, economy recruits, chessBonus, stackRefreshValue, poolAwareMerges | upstream merge values × `mergeFinishWeight` / `mergeProgressWeight`; V3 additions; teammate penalty kept (`teammateTierPenalty`, default 18). |
| refresh valuation & buy loop (buyLoopSteps) | fundsReserve (坎诺特), mergesOnly fill pass, keepFresh shed, full-hand merge shed, full hand refuses every buy, non-keeper pair clutter rule, BUY_FULL_MIN, buy-vs-refresh (refreshValue: merge-hit odds), lineup memo | pool-left check, bondOnlyBuy, forceRefreshes, engine / trade buys, separate paid/free budgets, refresh engines (botStrategy refreshValue → imported as `strategyRefreshValue`), econSweep, cannotInterest, refreshFlip, core-threshold re-arrange | all upstream gates first, V3 decisions inside them. Paid refresh needs `funds ≥ cost + max(1 or 2, reserve)` or an engine gain ≥ 1.5 × cost. Full-board threshold `fullBoardBuyMin` (default BUY_FULL_MIN). New: upstream's bench budget also caps V3's non-merge full-board buys (`benchBudget`, default BENCH_BUDGET 6) — upstream's bench test failed without it (bench 8). Refresh cap: `prepRefreshes: 8` in BOT_POLICY (V3's validated value; upstream MAX_REFRESHES 16 when the knob is absent). |
| bench (sellWeakestHand, sellJunk) | handOnly / keepFresh / 突变细胞 carriers kept, ctx.copies, pairLive +150, BENCH_BUDGET | holdBases, benchValue engines | both; sellJunk budget `benchBudget ?? BENCH_BUDGET`. |
| level-up (levelUp) | exported; diyOpensAt; fundsReserve | levelCap / levelCapUnlock playbooks, levelTargets, coreUpgradeWanted, relayUpgradeWanted, ABYSS R3 board-ready 4, levelSpareMargin, upgradeReserveCoins | both. |
| field model (fieldModel) | ps.gd, armour table (`armor`, `dps` cache) | own bounty enemies (withBounties), wave overrides, per-route threat, FLY detection, bossLeaderWeight | auto-merged; cache key stays upstream's format and only adds the player + bounties when the player has bounties (upstream `facing.test.js` injects a synthetic `_botPath` with the upstream key). |
| placement (planLayoutSteps) | rangeRec (loadout range grid), placeClass / 高台 preference, self-range road preference, summon within / without range | combatRecord (projected bond stats), 驰骋 aura (planSkillfulAura), positional garrisons keep facing, formationGrowth, layoutRefinementPasses | V3 record with upstream's deployed range grid; candidates scored with formationGrowth; the refinement passes reuse each piece's placeClass tiles and never move a piece pinned by a 高台 / road preference or a summon-range constraint. |
| plan application (applyPlanSteps, placeTokensSteps) | refused-tile retry, SUMMON_TRIES | V3 lifts unchosen board chess first; V3 `summonTileOk` filter | auto-merged applyPlanSteps; placeTokensSteps = upstream (V3's summonTileOk does not exist upstream; upstream's within/without in planLayoutSteps covers it). |
| items (equipItems, takeOffers) | itemTarget by effect (突变细胞, 信标, 拟态物质, 博士投影, bond items, most-bond recruit), useArt (画卷, 教鞭, 神秘顾客) | bestEquipmentTarget (role, signatures, combos, replacement), most-valuable-first order, training offers | Arts → upstream useArt; the effect keys upstream's itemTarget handles (ITEM_TARGET_KEYS) and non-EQUIP items → itemTarget; other equipment → V3 bestEquipmentTarget with replaceUid. bestEquipmentTarget never replaces a 突变细胞 (upstream rule "a bot never destroys the cell"; without it `feedback1-meta #4` failed). takeOffers = V3 (its `training` source branch is inert upstream). |
| prep routine | autoPickPersonalChoice at start/end, MAX_REFRESHES, maybeFreeze, freeHandSlot, rememberOwned | withOverlay (bandPolicy playbooks for the whole prep), cashBank, ABYSS R3 level, extra arrange/equip passes, econSweep, shop freeze sync | V3 Inner functions with all upstream calls added. |

## 3. API adaptations

- `Match` constructor (server/match/Match.js): `this.botPolicy = { ...BOT_POLICY, ...(!this.isSolo ? (opts.botPolicy || BOT_POLICY).byDifficulty?.[this.difficulty] : {}), ...(opts.botPolicy || {}) }` — after `drawOptimization`, before the players are built; uses `isSolo` / the resolved `difficulty` (the fork used `mode === 'coop'` / `opts.difficulty`).
- Bot loadout: `PlayerState` constructor — `else if (this.isBot && m.botPolicy && m.botPolicy.botLoadout) this.setLoadout(m.botPolicy.botLoadout, undefined, { bot: true })`; `player/basics.js setLoadout(loadout, ops = undefined, { bot = false } = {})` (upstream added the `ops` parameter; 潜能 / 练度 stay unchanged for bots).
- `test/match/harness.js`: `makeMatch` forwards `botPolicy` (the V3 tests pass policy overrides).
- Helper modules: `m.gd.` → `(ps?.gd || m.gd).` inside every function with a `ps` parameter (61 in botStrategy, 4 botTeam, 5 botBoss); `m.botPolicy.` → `(m.botPolicy || BOT_POLICY).`.
- botStrategy.traitValue returns 0 early when the piece has no garrison of the asked events (cost; same values).
- Name clash: upstream `refreshValue(m, ps, ctx)` (merge odds) vs V3 `botStrategy.refreshValue(m, ps)` (engine gain) → the latter imported as `strategyRefreshValue`.
- All BOT_POLICY ids (bands, bonds, chess incl. botLoadout / chessBonus / holdBases) exist in the 0.2.5 data with the same operators (拉普兰德 chess_char_2_16_a, 荒芜拉普兰德 6_18, …).
- tools/airun.mjs = `airun_experiment_latest.mjs` + optional policy import (runs on an upstream tree with upstream's AI) + header note for `--blank`. Other tools copied unchanged; import graph checked, `coop-relay-run.mjs` (1 seed) and `capture.mjs` (1 seed) ran without errors.

## 4. Tests

Ported (all pass): ai-boss-rehearsal.test.js, ai-clearance.test.js, ai-difficulty-policy.test.js, ai-hard-layers.test.js, ai-roster-search.test.js, ai-support-training.test.js, ai-training.test.js, ai600-rules.test.js, bot-core.test.js, bot-economy-support.test.js, bot-strategy.test.js, bot-team.test.js, bot_econ.test.js.

Not ported:
- rules upstream implements differently (task list): bounty-initial, bounty-wiki, dobermann-bounty, layer-verification, minimalist-vision-price, tactician_summon_range, titi-original (test/content), windows-launcher (test/).
- the fork's `bot.test.js` was not ported: upstream's own `bot.test.js` stays. Its only fork-specific test, "band pick: without allies, both solo and one-seat co-op avoid withholding early funds (老鲤)", contradicts upstream's "in co-op it may take it" test; upstream's wins (see band pick above).

Run as `node --test --test-isolation=none <file>`, ≤ 4 node processes, BelowNormal priority. Before = the extracted target
tree unchanged; after = the port. test/match: 120 files after (107 before + 13 ported). Files not listed: pass in both.

| file | before (pre-change tree) | after (port) |
|---|---|---|
| ai-boss-rehearsal.test.js | n/a (new file) | pass (0.4 s) |
| ai-clearance.test.js | n/a (new file) | pass (0.4 s) |
| ai-difficulty-policy.test.js | n/a (new file) | pass (0.4 s) |
| ai-hard-layers.test.js | n/a (new file) | pass (0.4 s) |
| ai-picks-last.test.js | pass (11.5 s) | pass (2.4 s) |
| ai-roster-search.test.js | n/a (new file) | pass (0.5 s) |
| ai-support-training.test.js | n/a (new file) | pass (0.4 s) |
| ai-training.test.js | n/a (new file) | pass (0.4 s) |
| ai600-rules.test.js | n/a (new file) | pass (0.5 s) |
| bot-core.test.js | n/a (new file) | pass (0.6 s) |
| bot-economy-support.test.js | n/a (new file) | pass (0.6 s) |
| bot-emotes.test.js | timeout (900.0 s) | timeout 900 s (spawnSync child process; same on pre) |
| bot-smarter.test.js | pass (62.5 s) | pass (110.3 s) |
| bot-strategy.test.js | n/a (new file) | pass (0.5 s) |
| bot-team.test.js | n/a (new file) | pass (0.4 s) |
| bot.test.js | pass (25.0 s) | pass (27.9 s) |
| bot_econ.test.js | n/a (new file) | pass (0.5 s) |
| fullmatch-coop.test.js | timeout (900.2 s) | 20 seeds: timeout 900 s (pre 612 s pass); 12 seeds: pass 503 s; 4 seeds: pass 300 s (pre 224 s) |
| fullmatch-coop2.test.js | pass (207.5 s) | pass 375 s (20 seeds, alone) |
| fullmatch-coop3.test.js | pass (581.3 s) | pass 439 s (20 seeds, alone) |
| fullmatch.test.js | FAIL(None) (439.9 s) | FAIL(1) determinism (both trees, MATCH_SEEDS=4: 7/8 pass, same test fails on pre) |
| fuzz.test.js | FAIL(2) (0.5 s) | FAIL(2) (0.4 s) |
| playtest6-limits.test.js | timeout (900.1 s) | timeout 900 s (spawnSync child process; same on pre) |
| simServe.test.js | FAIL(1) (0.7 s) | FAIL(1) (0.5 s) |

Other files: 96 more pass before and after. Notes:
- No file that passed before fails an assertion after. One new timeout: fullmatch-coop at 20 seeds (below).
- fuzz (`g.freeOperatorPick` field), simServe (403 in the sandbox), fullmatch determinism (the summaries of two identical runs differ — same failure on the unchanged tree) fail identically before the change.
- bot-emotes / playtest6-limits spawn a child node process (spawnSync) — they hang in this sandbox on both trees (the same limit that makes the default test isolation hang).
- fullmatch-coop (3 configurations × 20 full matches): 612 s on the unchanged tree run alone, > 900 s with V3 (the 15-min cap); with MATCH_SEEDS=12 it passes in 503 s, with 4 seeds in 300 s (unchanged tree 224 s). So this timeout is V3's extra prep cost, not the sandbox.
- realtime.test.js is timing-dependent here: it failed on BOTH trees in repeated runs (`RATE 操作过于频繁` from the human-client rate limiter) and passed on the port in the final full run.
- Regressions found while porting, all fixed: bench cap (bot.test.js), 老鲤 one-seat co-op draw (bot.test.js), field-model cache key (facing.test.js), 突变细胞 replacement (feedback1-meta #4), prep cost guard 359 ms > 300 ms under load (bot-smarter; now ≈ 50–110 ms of CPU per late-round bot prep alone, upstream's comment says 7–35 ms).

## 5. Smoke runs (tools/airun.mjs, ABYSS co-op, 3 AI + idle human seat 3 with 25 LP: `--from 98001 --count 6 --blank 3 --blankLp 25 --difficulty ABYSS`)

Ported V3 (final code):

| seed | win | rounds passed | end | errors | simErrors | blank alive at R13 | s/game | bands (seat 0–3; seat 3 = blank) |
|---|---|---|---|---|---|---|---|---|
| 98001 | False | 13 | defeat | 0 | 0 | False | 80.3 | amedic, lmlee, dusk, bldsk |
| 98002 | False | 13 | defeat | 0 | 0 | False | 108.9 | dusk, narant, amedic, bldsk |
| 98003 | False | 11 | eliminated | 0 | 0 | None | 52.5 | lmlee, orchid, amedic, bldsk |
| 98004 | False | 13 | defeat | 0 | 0 | False | 69.5 | amedic, bldsk, harold, amiya |
| 98005 | True | 14 | victory | 0 | 0 | True | 135.7 | dusk, amedic, narant, bldsk |
| 98006 | False | 10 | eliminated | 0 | 0 | None | 49.9 | orchid, dusk, amedic, bldsk |

Upstream AI (the unchanged tree with the same airun.mjs; it has no botPolicy.js, so its own AI runs):

| seed | win | rounds passed | end | errors | simErrors | blank alive at R13 | s/game | bands (seat 0–3; seat 3 = blank) |
|---|---|---|---|---|---|---|---|---|
| 98001 | False | 13 | defeat | 0 | 0 | False | 21.9 | lmlee, sarkazb, orchid, bldsk |
| 98002 | False | 11 | eliminated | 0 | 0 | None | 22.0 | malkie, mlyss, doberm, bldsk |
| 98003 | False | 11 | eliminated | 0 | 0 | None | 17.1 | clementia, ermengard, cannot, bldsk |
| 98004 | False | 11 | eliminated | 0 | 0 | None | 21.5 | ioleta, orchid, malkie, bldsk |
| 98005 | False | 11 | eliminated | 0 | 0 | None | 40.0 | vodfox, dusk, amedic, bldsk |
| 98006 | False | 9 | eliminated | 0 | 0 | None | 24.0 | sarkazb, ioleta, damaztic, bldsk |

4-AI ABYSS, V3, seeds 98001–98002: no errors (both defeat, 13 rounds passed, 79 / 85 s per game).
Both runs complete with 0 errors and 0 sim errors. 6 games are a smoke test only — no win-rate conclusion (V3 1/6 wins and blank alive at R13 1/6; upstream 0/6, 0/6 — not significant).

## 6. Known risks for the win-rate validation

1. Behaviour is not V3-identical: upstream's mechanisms now gate V3 (BUY_FULL_MIN and buy-vs-refresh, bench budget on full-board buys, full hand refuses merges, keepers / non-keeper pair clutter rule, freeze, armour fit, 18-point teammate high-tier penalty, DIY bonus, bondPlan second bond, upstream item targets for special items). The V3 validation numbers (blank alive past R13 2.4 % → 5.4 %) need to be re-measured on 0.2.5.
2. Double counting of DEF/RES (armorFit + waveFit) in unit and buy values.
3. `prepRefreshes: 8` keeps V3's paid-refresh cap; upstream's own design uses 16 with its refresh-vs-buy rule. Worth an A/B.
4. V3 band softmax only in ABYSS co-op (`bandScoring`); HARD / NORMAL use upstream's draw — `bandDefenseBias.HARD` is now unused unless `bandScoring` is set.
5. Rules changed between 0.1.0 and 0.2.5 (hand limits, 高台, 突变细胞, DIY, personal choices, bounty durations, …) shift the tuned constants (bandDefenseBias, corePreference, band playbooks for 贾维 / 变形者集群); the playbooks' chess ids still exist but were tuned on the old rules.
6. Runtime: a 3 AI + blank ABYSS game takes ≈ 50–136 s with V3 vs ≈ 17–40 s with upstream's AI on this desktop (V3 arranges up to four times per prep, more rehearsal plans in ABYSS). Plan validation batches on the remote hosts.
7. Paired comparison: run the same tools/airun.mjs on the unchanged 0.2.5 tree (upstream AI) and on the port with identical seeds; note `--policy` overrides do nothing on the upstream tree.
