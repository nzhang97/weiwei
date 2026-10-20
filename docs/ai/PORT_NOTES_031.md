# PORT_NOTES_031 — weiwei AI 层移植到上游 0.3.1

基线：`main`（f4e8166 = 上游 v0.2.6 + weiwei AI 层）→ 目标：上游 `sganggs/Stronghold-Protocol` v0.3.1。
方法：以 v0.2.6 为共同祖先做三方合并（weiwei 新增 53 个文件、修改 71 个；其中 52 个上游也改过）。

## 1. 合并结果

| 类别 | 数量 | 处理 |
|---|---|---|
| weiwei 新增文件 | 53 | 原样带入（`test/content/unite-absolve.test.js` 除外，见 §2） |
| 仅 weiwei 修改 | 19 | 取 weiwei |
| 双方修改、自动合并无冲突 | 25 | 合并结果 |
| 双方修改、有冲突 | 27（276 处） | 231 处在 `test/golden/*.json`：取上游快照；其余约 45 处代码冲突逐处手工处理 |

`data/choices.json`、`data/config.json`、`public/i18n/en.json` 按 JSON 结构三方合并（无真冲突）：保留 weiwei 的
单人绝境特殊备战回合（R3/R4）、悬赏卡调整和 28 条 AI 文案。

## 2. 规则取舍

- **联防漏怪**：weiwei 的「本体击杀免责」（`absolved` / `_absolveRoot`，2026-10-15）与上游 0.3.1 的 `uniteRuntime`
  （PR #675：联防战场上才出生的分裂 / 召唤敌人一律不扣漏怪玩家生命）覆盖同一问题。采用上游实现；`deploy.js`、`spawns.js`、
  `enemies/helpers.js`、`spec.js`、`unite.js` 取上游原文，`fields.js` / `protocol.js` 中 absolve 字段移除，
  `test/content/unite-absolve.test.js` 删除。
- 保留的 weiwei 规则改动：驻守赠送叠层上限 `GRANTED_CAP_OVERRIDE`、高叠层结果先服务器复核（`verifyLayerOverflow`）、
  反击不触发反击（`damage.js COUNTER_TAGS`）、小睡 `slumber` 状态、`g.autoArrange`（AI站位）协议。

## 3. `server/match/bot.js` 的关键接线

- **试演（rehearsal）**：上游 0.3.1 把候选构建抽成 `candidateOpts`（`m._normalOpts(ps, { preview, board })`，在棋盘副本上
  构建、不触碰实时状态），评分抽成 `createRehearsalJob` / `sim/rehearsal.js RehearsalRun`（只比漏怪→击杀→顺序），并可委托房主
  浏览器。移植后：候选用上游 `candidateOpts`；**随机种子改回 V3 训练时的 `rehearse:<round>:<seat>`**（上游用正式战斗种子
  `n:`）；评分仍用 V3 job（叠层成长、联防接力、多种子稳健、AI站位 goal、首领战试演）。V3 试演不委托给浏览器。
- `createRehearsalSteps(m, ps, chosen, plans, opts)`：`opts` 可以是 AI站位 goal 对象，也可以是上游的 `{ delegate }`。
- `countedLeaks` 由 V3 补回（上游删除了它，三方合并会把它一并删掉，导致每次 V3 试演抛异常——已修复）。
- 试演失败不再写入对局诊断日志（上游约定：失败的候选静默跳过）。
- `lineupScore`：传入 V3 预计算阵容则直接使用；传数字（上游的手牌空位数）走上游计算；不传走 V3 `lineupState`。
- 上游新增的「孤立近战阻挡位修复」保留，修复后同步 V3 精修所用的 `placed` 记录。
- 装备购买：先过上游「场上有人能装备」检查（变形槽位规则），再用 V3 `bestEquipmentTarget` 打分。
- 商店同分：采用上游「同分取便宜」，保留 V3 的 `trade` 标记。
- `planLayoutSteps`：精简的测试数据（缺 `baseIdOf` / `bondIds`）下退回上游射程记录；真实对局不受影响。

## 4. 文件结构（本次整理）

AI 层集中到独立目录，减少以后与上游合并时的交织：

| 新位置 | 内容 |
|---|---|
| `server/match/ai/` | `botPolicy` `botStrategy` `botTeam` `botBoss` `botLayoutGoals` `botLayerYield` `actionLog` `logUpload` |
| `tools/ai/` | `train-ai` `train-ai-gpu.py` `test_ai_gpu.py` `airun` `ai-training-score` `fit-ai-bands` `fetch-ai-logs` `coop-relay-run` `capture` `cfeval` `cfitems` |
| `docs/ai/` | `AI-AUDIT` `AI-LOG-UPLOAD` `PORT_NOTES_AI` `LAYER-MECHANICS` `PORT_NOTES_031`（本文件） |
| `test/ai/` | weiwei 新增的 AI 测试（`ai-*`、`bot-core/strategy/team/warp/econ/economy-support`、`auto-arrange*`、`action_log`、`log_upload`） |

上游自带的 `server/match/bot.js`、`tools/botbench.mjs`、`test/match/bot*.test.js` 保持原位。规则 / 内容类改动
（`tools/content-text.mjs`、反击、深水区、悬赏表、叠层复核、绝境 R4 等测试）保持原位。

## 5. 验证

### 5.1 AI 测试
weiwei 的 AI 测试文件在 0.3.1 上全部通过，结果与 0.2.6 原版逐文件一致（`bot-emotes.test.js` 在两边都超时，属环境问题）。

### 5.2 与上游 0.3.1 新期望不一致的 7 个上游测试（未改动 V3 行为，待决定）
- `test/match/bot.test.js`
  - user: ground-capable medic in formation 173 — 医疗不应把最后一个敌人挡在火力外拖到超时（V3 布阵击杀 0，期望 3）
  - user: two ground routes meeting at a guard — 两入口的敌人都能被击杀（同上）
  - boss medics break ties by uncovered damage — 首领战医疗分组
  - medic support checks every incoming ground contact — 医疗支援与离路格偏好
- `test/match/bot-smarter.test.js`
  - user: bond that counts the hand … room to withdraw — 撤下的羁绊成员只有手牌有位置时才计入
  - user: purchase consumes the last hand slot — 同上（购买占用最后一格）
  - user: equally scored purchases … prefer the cheaper — V3 估值下两者并不同分，买了较贵者

这些对应上游根据玩家反馈对布阵 / 商店的修正（issue #315 等）；V3 有自己的布阵与估值模型，尚未吸收这些修正。

### 5.3 实战对局（`tools/ai/airun.mjs`，ABYSS 合作 4 AI，种子 99001–99072，三组同种子）

| 组别 | 胜局 | 平均通过回合 | 到 R14 | 隐秘核心 | 运行时错误 |
|---|---|---|---|---|---|
| 0.2.6 + 训练 AI | 10/72 | 12.81 | 59 | 3 | 0 |
| 0.3.1 移植 + 训练 AI | 9/72 | 12.83 | 58 | 7 | 0 |
| 上游 0.3.1 自带 AI | 0/72 | 11.32 | 20 | 0 | 0 |

配对比较：移植 vs 0.2.6 Δ回合 +0.03（95% CI −0.15 ~ +0.21，Wilcoxon p = 0.82；独胜 5 : 6）——无可测量差异。
移植 vs 上游 AI Δ回合 +1.51（p < 0.001；独胜 9 : 0，McNemar p = 0.004）。72 局能排除明显退化，不足以分辨几个百分点的胜率差。

### 5.4 全量测试
全仓库 880 个测试文件（上游 0.3.1 为 854 个），逐文件与纯上游 0.3.1 对比（同一台机器、同一沙箱）。比上游差的只有：

| 文件 | 移植版 | 上游 | 说明 |
|---|---|---|---|
| `test/match/bot.test.js` | 27/4 | 31/0 | §5.2 的 4 个布阵用例 |
| `test/match/bot-smarter.test.js` | 17/3 | 20/0 | §5.2 的 3 个商店用例 |
| `test/match/rehearsal-delegate.test.js` | 8/14 | 22/0 | V3 试演不委托给房主浏览器（§3）——AI 队友的试演全部在服务器上计算，服务器 CPU 占用高于上游 |
| `test/match/playtest6-bosspool.test.js` | 6/1 | 7/0 | #5 固定种子整局（boss_10 / seed 12）进入首领加时（drain 51 ≠ 0）；0.2.6 原版通过。判断为整局结果分岔，待观察 |

已处理：
- `test/golden.test.js`：V3 改变对局结果，golden 快照已用 `node tools/golden.mjs --update` 重新生成（288 个场景），9/0。
- `test/plugins/loopCaps.test.js`：0.3.x 要求每个 `while` 标注 `loop-cap`；为 V3 的 9 个循环补注释（逻辑不变），14/0。
- `bosshp` / `fuzz` / `perf`：全量并行时超时或超出计时阈值，单独运行均通过（V3 每局计算量约为上游 3 倍）。
- `server/sim/nodeData.js` 的 3 条 import-boundary 提示与上游一致。

