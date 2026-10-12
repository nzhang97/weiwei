# AI 队友优化与实现核查

核查日期：2026-10-09。目标：四人同盟模拟、终极难度，关闭额外增益和第 3/4 回合 AI 削弱，提高通关机会。

## 对照结果

采用真实战斗引擎，四个席位均由 AI 驱动；这可重复测量队友策略，但不能直接代表一名真人带三名 AI 的胜率。原版基线保留本地已有的房间、启动器和可选增益/削弱功能；这些选项在测试中均未启用。

| 样本 | 原版通关 | 修改版通关 | 原版平均通过回合 | 修改版平均通过回合 |
|---|---:|---:|---:|---:|
| 最终落盘版本验证，种子 501–516 | 0/16 | 2/16 | 9.6875 | 11.0000 |

最终验证出现了通关样本，且平均多通过 1.3125 回合；样本不足以证明稳定的胜率提升幅度，12.5% 只是这批样本的观测值。修改版在种子 505、512 通关，仍有较明显的中后期失败问题。

这组种子首次用于候选版本冻结后的验证，第一次结果为 1/16、平均 11.1875 回合；随后代码审查修正了备用阵容的同步部署和已售出候选的过滤，重新跑完同组得到上表。没有据此调整评分参数。调整过程中某版本在 301–308 为 1/8，在另一组 401–416 为 0/16；这些中间结果不与最终样本混合统计。

最终验证双方共 32 局均无规则检查、状态不变量、战斗或整备效果错误。原版完成 9508 次规则检查与 779 次状态不变量检查；修改版完成 11943 次规则检查与 861 次状态不变量检查。通过回合数采用 `Match` 的 `roundsPassed`，不等同于失败所在回合；隐秘核心失败不推翻最终攻势的通关，沿用游戏已有定义。

复现命令（在项目根目录，Node 24.21.0）：

```text
node tools/matchrun.mjs --mode coop --difficulty ABYSS --players 4 --seed 501 --seeds 16 --rehearsal 3 --check --json
```

基线与修改版分别运行同一命令。没有使用 `--lp`、`--layers`、额外金币或修改敌方数值。相同种子固定初始条件；策略改变会改变后续抽牌/刷新消耗，不能理解为双方整局见到完全相同的商店。

## AI 修改

实现主要位于 `server/match/bot.js` 与新增的 `server/match/botStrategy.js`。

- **开局策略与机变**：同时考虑初始 LP、前期赠品、持续收入、叠层、阵容可获得性及公开的队友策略；避开已被选走的策略。低 LP 时降低额外悬赏敌人的优先级，叠层卡按实际可受益盟约评分。
- **阵容与招募**：按当前预览的敌方护甲、法抗、空中比例、密度和通道数量评估。盟约按真实人数、精锐、整备区计数与当前层数计算；高层盟约的上场受益者会提高阵容价值。试阵同时比较一个替换干员的方案和站位变体。
- **经济与买卖**：终极第三回合适当前置升级，减少长期堆积一阶干员；保留有效的整备区叠层/经济干员与合成对子；考虑获得/出售特质的净收益。钱袋等消耗品收益会在本回合继续投入招募。牌池耗尽的商品不会卡住购买循环；买不起的第三张合成牌可冻结留到下回合。
- **装备**：按物理/法术输出、阻挡、生存、攻速、专属盟约和装备组合选择携带者；有明确收益时替换弱装备，避免等价装备反复替换。晋升和变换类装备会保护已有精锐，牺牲招募类装备只考虑不承担当前阵容功能的后备干员。
- **叠层**：区分获得时、整备开始、整备结束、首次刷新和按刷新次数累计的效果，考虑投资人重复触发、每回合上限、999 层上限、盟约是否激活、前后相邻及同行站位。战斗试阵允许模拟中的真实叠层，但不会将试阵奖励写回实际玩家。
- **站位**：保留每条路线上的敌方类型、数量、防御、法抗、出怪间隔和悬赏敌人，应用波次属性覆盖及倍率。按阻挡存活能力、群攻、对空和朝向分配覆盖；主要静态盟约、层数和装备属性参与输出与生存估算，不再只看裸属性。

所有购买、出售、移动、使用装备和准备动作仍走玩家使用的校验入口。行动数、刷新数和试阵数有上限；整备与试阵保持可分片执行，避免整场试阵占用一个服务器回调。

## 说明与实际实现不一致

| 项目 | 原说明或原 AI 假设 | 实际规则与证据 | 处理 |
|---|---|---|---|
| 随机移除阵容 | 玩法指南写“禁用盟约及其干员” | `server/match/pool.js` 只移除所有所属盟约均在抽取集合/模式禁用集合中的干员；`bondsMeta.js` 仅阻止模式静态禁用盟约激活。跨盟约干员或装备仍可能激活抽中的盟约 | 修正 `docs/PLAYING.md`，与开局界面现有提示对齐 |
| 授予的开技能叠层特质 | `garrison_72_a/b` 写每场至多 7/14 层 | `garrisons/battle.js` 的 `GRANTED_CAP_OVERRIDE` 对授予的 `garrison_95_a/b` 使用 12/24；已有战斗测试逐次触发至上限验证 | 修正授予者描述为 12/24。没有改变战斗上限；原始被授予记录的黑板仍保留直接持有时的 7/14 |
| 炎佑属性 | 炎盟约描述写攻击/生命“为”炎干员总和的 30% | `tokens.js::spawnYanyou` 是模板攻击 600、生命 12000，再加总和的 30%；`bonds_core.test.js` 已验证加法 | 修正盟约及关联效果文案为基础属性“增加”30%，没有调整属性 |
| 试阵与实际作战 | 原试阵关闭叠层且未带团队策略/整备区上下文 | 实际普通作战开启叠层，内容处理器读取团队策略（含 Touch）和整备区。原试阵可能错误比较依赖叠层或支援的阵容 | 补齐只读上下文、现有召唤物和隔离的战斗叠层；测试每次暂停及试阵结束后真实状态一致 |
| 路线预览与实际敌人 | 原路径模型合并不同类型敌人，且未完整识别原生飞行、属性覆盖和个人悬赏 | `Battle.spawnEnemy` 先应用模板覆盖再应用波次倍率；悬赏按玩家独立添加 | 与此顺序对齐，修复全飞行波次凭空增加地面路线的估算 |
| 上场评估与整备区计数 | 原评估把撤下的干员从虚拟阵容中完全移除 | 远见、奇迹、投资人属于 `BOARD_AND_DECK`，撤到整备区仍计数 | 虚拟阵容同步移入整备区，避免错误地为保盟约占用场上位置 |

文案修正在 `tools/content-text.mjs` 集中维护，由 `tools/build-data.mjs` 调用，避免下一次生成数据覆盖修正。仅修改描述字段，没有改变数据黑板、数值、波次或战斗伤害实现。

以下差异属于已明确记录的本项目规则，未当作新漏洞修改：多轮悬赏改为两场；最终攻势后隐秘核心失败仍算通关；领袖单次伤害达到 300000 整次作废；盟约上限 999。源码有这些规则及相应验证，本次没有为提高 AI 成绩修改它们。

## 验证与限制

新增针对策略、敌方类型与数量变化、层数收益、整备区计数、投资人、刷新上限、装备分配/替换、资金消耗品、冻结合成牌、试阵状态隔离和描述一致性的测试；同时运行原有经济、合成、盟约、棋盘、朝向、牌池、全局实战、实时切片和内容效果回归。相关回归共 303 项通过，0 失败；长局回归采用 `MATCH_SEEDS=3`。代码审查后的针对性回归 47 项通过，写回后的策略与说明验证 22 项通过；胜率验证另用上表无增益/削弱的真实对照。

本次核查覆盖与 AI 决策密切相关的整备、盟约、装备、波次和试阵路径，并非全量干员技能、敌方技能、所有文本的逐条认证。

策略评分和路线评分仍是近似模型。完整技能循环、临时易伤/控制、场上动态光环和特殊装备的条件触发由试阵进一步校验；通常只有三个候选，不能保证搜索到最优解。最终攻势的配对协同、专门的领袖阵容和跨回合长线规划仍是后续最值得改进的部分。没有更改干员技能/模组选项的选择机制，也没有给 AI 读取队友私有商店或整备区的能力。


## 第二阶段：八轮策略联动试验与叠层校验修复

日期：2026-10-09。目标：四人合作、终极难度，关闭额外增益和第 3/4 回合 AI 削弱，尝试提高通关率。

结论：本轮没有证明通关率提高。完整联动方案与后续收敛候选均未跑赢基线，因此 D:\Wei 保留第一阶段已经部署的 AI 策略，不写入本轮未经胜率验证的估值/换阵调整。主项目仅合入合法高叠层结果的校验修复及其回归测试。

这里的基线是本轮开始时的版本，与前文第一阶段的“原版”不同。

| 版本 | 校准组通关 | 校准组平均通过回合 | 复测组通关 | 复测组平均通过回合 |
|---|---:|---:|---:|---:|
| 本轮基线 | 0/12 | 11.1667 | 2/24 | 11.0417 |
| 第一轮：策略收益全面接入 | 0/12 | 10.8333 | 未运行 | — |
| 第二轮：调整开局策略权重 | 0/12 | 10.2500 | 未运行 | — |
| 第三轮：降低重复奖励，购物中激活盟约 | 0/12 | 11.3333 | 未运行 | — |
| 第四轮：买卖、刷新和冻结联动 | 0/12 | 11.3333 | 1/24 | 10.8750 |
| 第五轮：满整备区换阵保护 | 0/12 | 11.3333 | 1/24 | 10.9167 |
| 第六轮：技能期输出和范围估值 | 0/12 | 11.1667 | 0/24 | 10.8333 |
| 第七轮：删除重复招募奖励，校正加算 | 0/12 | 11.0000 | 0/24 | 11.0000 |
| 第八轮：撤回技能投影，保留机制联动 | 0/12 | 11.2500 | 1/24 | 10.9167 |
| 收敛修复候选（未采用） | 0/12 | 11.0833 | 1/24 | 10.9167 |

校准组为种子 601–612；复测组为 801–824。复测组在第四轮后已被查看，后续结果不能称为独立盲测。每个版本使用真实战斗引擎、四个 AI 席位和三次候选试阵；没有增益、削弱、额外金币或 LP。相同种子固定初始条件，策略改变后的商店随机消耗仍可能不同。四 AI 对照也不能直接代表真人带三 AI 的胜率。基线在 804、824 通关，收敛候选仅在 804 通关；因此没有把退步方案作为胜率提升发布。

八轮试验覆盖：

- 初始策略与干员、盟约、精锐数量、不同等阶的联动。
- 买入、出售、保留对子、阶段升级、留资与刷新叠层的相互取舍。
- 华法琳、阿米娅、罗素、Touch、坎诺特、贾维、绮良、潘格尼尼、玛恩纳、凯瑟琳、佩佩、铃兰、巫恋、松桐等策略的实际触发条件和累计计数。
- 装备携带者、复制/变换时机、邻接与站位收益。
- 技能期间攻击范围、目标数与输出覆盖时间的近似模型。该模型没有通过实战对照，已撤回。

发现但未写入主项目的 AI 修复候选包括：识别赠品池与替换效果的目标盟约；不重复计算 Touch 的互斥形态；娜仁图亚替换萨尔贡六人效果后不再估算原攻击加成；画卷核对实际目标；换阵时保护高阶对子、精锐、装备携带者及有效经济/叠层干员。完整候选虽通过功能测试，通关率仍未达到验收要求，保留在任务工作区供后续研究。

本轮实际写回的实现一致性修复：

服务器原先把“60 + 4 × 回合”当作客户端单场叠层的硬校验上限，战斗机制却没有这个每场限制。在合作困难种子 101 的第 13 回合，真实战斗合法获得谢拉格 148 层，超过粗略上限 112，但没有超过实际总上限 999，因此被误判为异常。该样本已保存为回归用例。

现在超过粗略估计的结果必须先由服务器按同一战斗规格完整复算，再结算真实收益。即使常规复核关闭，这项复算也强制执行。超过剩余 999 层容量、禁用叠层或非法盟约的上报仍被拒绝；伪造 500 层会由服务器结果纠正。没有增加实际叠层上限，没有改变战斗数值。

最终针对该修复的回归 54 项通过、0 失败，长局使用 MATCH_SEEDS=3。覆盖真实 148 层样本、伪造高层数、客户端与服务端结果一致性、多人完整对局、实时切片、层数上限以及原有可选增益/削弱开关。实验方案也曾通过 264 项回归，收敛候选通过 299 项回归；这些功能通过不等于胜率改善。表格中各组实战的战斗、整备、规则和状态检查错误均为 0。

源码与数据：

- 主项目 AI 文件与本轮开始时逐字节一致。叠层校验修复位于 server/match/fields.js 与 server/match/Match.js。
- 第八轮完整联动方案：任务工作区 work/band-experiment-v8。各轮源码快照：work/band-v1-source 至 work/band-v7-source。
- 收敛 AI 修复候选：work/ai-mechanism-candidate。
- 逐局对照：work/band-*.json。另测全量保留待换下干员的候选为 1/24、平均 11.0417；最终收敛候选改为按保留价值保护干员，仍未通过验收。第七轮修正属性加算前为 0/12、平均 11.0833，表格采用修正后结果。

复现对照：

```text
node tools/matchrun.mjs --mode coop --difficulty ABYSS --players 4 --seed 801 --seeds 24 --rehearsal 3 --check --json
```

尚未解决：终极难度稳定通关率、关底构筑与配合、准确的技能/部署时机价值，以及更长线的资源规划。本轮并非所有干员、技能和描述的全量认证。


## 核心盟约与初始策略匹配试验（2026-10-09）

按四人终极、关闭额外增益/削弱进行五轮核心优先试验。策略绑定、不同成员的高阶门槛、过渡留牌、及时激活、当前商店可达性、战斗叠层和维多利亚首件装备参与同一套决策。敌方类型、数量、路线、对空与阻挡约束及真实战斗试阵仍保留。

校准组 601–612：基线 0/12、平均 11.1667 回合；五轮依次为 1/12（9.6667）、0/12（10.7500）、0/12（10.7500）、0/12（9.6667）、1/12（10.8333）。

第五版冻结后的独立组 1001–1032：基线 **1/32**、平均 **10.46875** 回合，候选 **0/32**、平均 **10.21875** 回合。同种子推进回合比较为 9 好、11 平、12 差。高阶核心在第 6 回合后存活阵容中的出现比例由 20/539（3.71%）提高到 42/482（8.71%）；此为重复阵容回合观测，不是独立胜率样本。未将该候选替换为默认 AI。

本次实际写回：阵容估值带入当前策略；娜仁图亚替换六萨尔贡效果时不再虚算普通攻击叠加，邻近装备分享由真实试阵验证。游戏本身的效果及数值没有改变。53 项相关回归通过；基线胜局种子 1023 复跑仍通关。32 个独立基线开局均未选择娜仁图亚，此修正不改变这批基线的估值分支。

核心候选的策略回归 42 项、完整对局等检查 26 项通过（有重复）；各组实战引擎、整备、规则和状态检查错误为 0。完整实验源码在任务工作区 work/core-v5-source，逐轮快照为 work/core-v1-source 至 core-v4-source，逐局记录为 work/core-*.json。仍未证明终极通关率提高；四 AI 测试不直接代表真人带三 AI。


## 核心优先 AI 设为默认（2026-10-09）

按用户明确要求，将上一轮第五版核心优先方案设为默认 AI，并在该方案上继续优化。此前 32 局未提高通关率的结果仍保留作为历史记录；它不再阻止启用用户指定的核心构筑方向。当前默认包含初始策略匹配、核心成型规划、过渡留牌、及时激活、战斗叠层和维多利亚首次装备估值。后续迭代以该版本为基线，不退回小合约主导的原版。


## 核心优先：绝境调优并应用至终极（2026-10-09）

在已启用的核心优先版本上进行了三步迭代：真实试阵防守持平时优先有效永久叠层；已激活但尚未成型的核心按缺失成员所需商店等级提前升级；保存候选自身的盟约状态，修正换阵后刚激活核心被旧阵容状态低估的问题。新增提前升级分支最多领先常规曲线一级、至少持有六名干员（受部署上限限制），升级后保留至少四金币。此前按敌方类型、数量与路线选人、布阵及装备分配的流程保留。新规则同时用于 HARD 和 ABYSS。

| 对照 | 本轮核心基线 | 最终版本 | 平均通过回合（基线→最终） |
|---|---:|---:|---:|
| 绝境复测 1501–1524 | 9/24 | 9/24 | 12.5833→12.5833 |
| 终极复测 1401–1424 | 0/24 | 0/24 | 10.0000→10.0000 |

绝境校准 1301–1312：基线 3/12（平均 12.7500），第一步和第二步均 4/12（平均 12.9167）。第二步冻结后首次使用两组复测种子；第三步是查看结果后发现的候选状态修正，复用这些种子后各局的胜负和通过回合与第二步一致（绝境 1514 中间战斗记录有变化），因此最终版不称为独立盲测。绝境新增三个胜局也失去三个原胜局。第六回合起高阶核心出现比例绝境 135/636→128/616、终极 36/353→32/358，均为重复玩家回合观测。

四人合作、四 AI、额外增益和第三/四回合削弱关闭，真实战斗和三次试阵；没有 LP/金币/层数覆盖。所有对照的战斗、整备效果、规则与状态错误为 0。最终回归 203 项通过、0 失败（MATCH_SEEDS=3），保留高叠层复算与描述一致性检查。

按用户要求保留并继续应用核心优先决策，未退回小合约主导版本；这轮没有证明通关率或成型比例提升。终极中后期的输出、覆盖、核心成员质量及最终攻势配合仍是限制。源码快照在任务工作区 work/core-hard-v3-source，写回前备份 work/core-optimized-deployment-backup，逐局与回归记录见 outputs/核心优先*。


## 经济卡与核心外援联动（2026-10-09）

在上一节核心优先默认版上新增：远见/奇迹第二名不同成员的边际经济价值；已有可负担搭档时先保留手中第一名成员；出售场上/整备区成员的激活损失检查；永久折扣与已结算收益去重；免费刷新独立的有限次数预算；已激活经济盟约的战斗叠层估值。

阵容及购买评估增加成对外援搜索，每个场上小盟约最多取一对候选，按真实增益的受益成员、已有层数、敌方类型和路线评分，并保留已激活核心的首档。这样可以接受两名一起换上才能成立的配合。经济成员可以在整备区参与激活，但带上场条件的叠层特质仍不算后备收益。

绝境校准 1701–1712：基线 7/12（13.0833 回合），第一版 6/12（13.0000），第二版 6/12（13.0833）。代码冻结后的新种子复测如下，四 AI 合作、三次试阵、无额外增益/削弱与数值覆盖。

| 独立复测 | 基线 | 最终版 | 平均通过回合（基线→最终） |
|---|---:|---:|---:|
| 绝境 1801–1824 | 13/24 | 15/24 | 13.0833→13.2500 |
| 终极 1901–1924 | 0/24 | 1/24 | 10.4583→10.6667 |

绝境新增五个胜局、失去三个原胜局，终极新增通关种子 1911。绝境远见激活玩家回合 49/1158→101/1159、奇迹 35/1158→73/1159、远见返现 24→86；终极相应为 24/865→50/889、12/865→36/889、38→62。参与率是重复玩家回合观测，返现为 24 局四席合计，不能替代通关率。免费刷新总使用量绝境 267→261、终极 101→114；不能全部归因于奇迹。

最终版本 236 项回归通过、0 失败（MATCH_SEEDS=3），所有批量实战引擎/规则/状态错误为 0。保留高叠层复算、描述一致性与实时切片检查。样本显示正向变化，但不能证明稳定提升；仍有局部退步，且本组未达到奇迹百层现金奖励、远见永久折扣或激活投资人。没有根据这组独立复测继续调整参数。

两个 AI 源文件、新增 test/match/bot-economy-support.test.js 与本记录写回主项目。源码快照 work/economy-v2-source；写回前备份 work/economy-support-deployment-backup；逐局、指标及回归记录见任务工作区 outputs/经济外援* 与《经济卡与核心外援联动报告.txt》。


## 三 AI 分阶段联防与后期真人席位（2026-10-09）

本轮基线为 139e428484ebb9fd9fd8c434db50da9a05db9d1d。测试改为四人合作：三个真正 AI 席位、一个固定的后期真人代理；绝境 HARD 与终极 ABYSS，三次普通试阵，额外增益和第三/四回合削弱全部关闭。核心盟约优先、经济卡及小盟约外援联动继续使用上一版规则。

实际联防规则已按 server/match/unite.js 核对：仅普通战斗零计数漏怪的存活玩家有资格，最多两名助手；选择先比较上场人数（含倒地干员）、激活盟约、站立人数，再按席位稳定排序。两名助手的迎敌先后还比较激活盟约总层数。干员继承自己的普通战斗结束血量比例、技力、持续技能及倒地状态；联防不再获得战斗叠层，残余敌人向原漏怪玩家扣 LP，每轮上限 10。Boss 回合合并团队 LP，不走普通联防。第二个隐藏 Boss 必须自然满足游戏条件，不能把普通通关当作双 Boss 通关。

实际写入的方案：

- 三个 AI 选完初始策略后，按实际策略的阶段适配度分配 R1–4、R5–8、R9–13 的主要防守责任；队友死亡后不突然全部改计划。这是决策偏好，不保证每阶段一定有人完美防守。
- 核心未成立时适度减少与队友公开策略、AI 核心计划的争抢；已经激活或积累层数的核心保持稳定，继续匹配经济卡及外援。
- 普通战斗试阵完美时，再用自己的剩余状态、当回合公开敌人的最多 12 个样本和真实单人联防路线试阵。保留敌人类型、强化属性、干员朝向与倒地重部署，试阵不发放金币或叠层，不修改实战资源。
- 分阶段估值只在普通防守足够好时比较剩余战力与救援能力。额外提前升级必须有上一回合健康且完美防守的 AI 队友、至少六名自有干员，并留下至少四金币；不能假定真人会兜底。原有正常升级曲线保留，避免过度保守损失整体战力。
- 新协作规则只用于三 AI 加真人的 HARD/ABYSS 房间；Boss 回合不使用普通联防加分。服务器仍按原来的切片预算计算试阵。

真人代理优先选择可成型的娜仁图亚/佩佩萨尔贡、哈洛德维多利亚、杜遥夜炎或休露丝谢拉格方向，使用固定基线购买、装备及阵容决策，并在合法资金允许时较早升级商店。它代表偏后期投资的固定操作风格，不是真人实测，也不是已证明的 Boss 输出最优解。两版对照使用同一基线代理代码；没有赠送 LP、金币、装备、层数或强制进入隐藏关。

五轮校准均使用每难度 2101–2108：v1 为固定席位分工；v2 增加成长窗口但限制正常升级；v3 增加真实联防试阵；v4 根据实际初始策略分配阶段并恢复策略选择的基础质量；v5 去掉额外的普通升级限制，保留有条件的提前投资。

| 校准版本 | 绝境团队胜局 | 绝境真人存活胜局 | 终极团队胜局 | 终极真人存活胜局 |
|---|---:|---:|---:|---:|
| base | 4/8 | 4/8 | 1/8 | 0/8 |
| v1 | 5/8 | 3/8 | 0/8 | 0/8 |
| v2 | 5/8 | 3/8 | 0/8 | 0/8 |
| v3 | 4/8 | 4/8 | 0/8 | 0/8 |
| v4 | 4/8 | 4/8 | 0/8 | 0/8 |
| v5 | 7/8 | 5/8 | 1/8 | 0/8 |

中间 v3.1 在增加健康队友检查后做过较早的 16 种子复测，未作为最终版本：绝境 2201–2216 团队胜局 7/16→4/16、真人存活胜局 2/16→4/16、AI 互助减损 180→223 LP；终极 2301–2316 团队胜局 1/16→1/16、真人存活胜局均 0/16、AI 互助减损 125→129 LP。该取舍促使后续恢复正常成长曲线，没有隐去团队退步结果。

v5 冻结决策后的新种子复核（没有再按本组结果调参）：

| 新种子复核 | 团队胜局 | 真人存活胜局 | 平均通过回合 | AI 互助减损 LP | 真人联防减损 LP |
|---|---:|---:|---:|---:|---:|
| 绝境 2401–2412 | 2/12→4/12 | 2/12→3/12 | 12→12.25 | 179→181 | 157→146 |
| 终极 2501–2512 | 0/12→1/12 | 0/12→1/12 | 10.4167→10.3333 | 121→124 | 84→89 |

HARD 新增团队胜局：2403、2411；失去原胜局：无。

ABYSS 新增团队胜局：2506；失去原胜局：无。

每个已观测普通回合至少有一个 AI 完美防守的次数 / 观测回合数，依次为前、中、后期：

HARD：43/48→43/48，34/48→32/48，27/51→28/51。

ABYSS：45/48→45/48，19/47→21/47，7/41→8/38。

“团队胜局”允许真人已被淘汰；“真人存活胜局”要求结束时真人仍存活。减损仅统计结算后仍存活的接收者，按 min(10, 自己普通战斗计数漏怪数) 减实际 LP 损失；AI 互助还要求全部联防助手都为真实 AI。早期统计曾受淘汰 LP 截断影响，现已统一排除淘汰者，并使用累计 lpLost 的差值记录实际损失。减损总量受存活时长及原本漏怪量影响，不可单独替代通关率；覆盖率也属于重复回合观测。

全部 208 局已记录对照的引擎、调度、整备与状态审计错误为 0。最终广泛回归 248 项通过、0 失败，MATCH_SEEDS=3，包含客户端完整合作对局、切片一致性、联防倒地重部署、核心与经济外援、高叠层校验及描述一致性。最终另有 9 项协作定向测试通过。最后的 contentInfo.kind 元数据修正不参与当前战斗计算：终极新种子组与广泛回归在该修正前运行，定向测试已检查最终字段。

这组样本支持继续使用分阶段方案，但不能证明稳定提高真实玩家胜率。终极平均推进回合仍有局部退步。所有本轮样本均未自然进入隐藏 Boss，第二 Boss 的后期阵容与团队输出仍未验证；最多 12 敌人的单助手试阵也不等于真实漏怪预测或两助手联合搜索。本轮没有改动战斗数值，也不宣称完成所有技能描述的全量认证。

逐局摘要、全部迭代汇总、指标口径、原始记录校验值和最终源码校验值保存在 [coop-relay-2026-10-09.json](benchmarks/coop-relay-2026-10-09.json)。完整原始记录保留在任务工作区 work/relay-*.json。

复现：先另建基线检出目录（例如 ../weiwei-relay-baseline，指向上述基线提交），在当前版本执行以下命令。两组必须将 --human-root 指向同一个基线目录，保持真人代理固定；--root 指向被测版本。

```text
node tools/coop-relay-run.mjs --root ../weiwei-relay-baseline --human-root ../weiwei-relay-baseline --difficulty HARD --seed 2401 --seeds 12
node tools/coop-relay-run.mjs --root . --human-root ../weiwei-relay-baseline --difficulty HARD --seed 2401 --seeds 12
node tools/coop-relay-run.mjs --root ../weiwei-relay-baseline --human-root ../weiwei-relay-baseline --difficulty ABYSS --seed 2501 --seeds 12
node tools/coop-relay-run.mjs --root . --human-root ../weiwei-relay-baseline --difficulty ABYSS --seed 2501 --seeds 12
```


## 2026-10-10：绝境盟约研究与本地 GPU 评分训练

本轮实验固定四 AI、零真人、HARD 绝境模式，只开启抽卡优化。额外强化、第三/四回合削弱、免费自选全部关闭。战斗仍由 Node 游戏引擎在 CPU 上模拟；GPU 只拟合初始策略评分，不能直接把现有逐事件战斗搬到显卡，也不宣称缩短整场模拟时间。

小盟约不能按层数一概估价：精准三人扩大受益范围；灵巧 40 层扩大邻接范围；奥术需要法术伤害成员施加弱化，联防同目标仅取最强奥术实例。远见、奇迹和投资人的人数计算包含整备区，但临时区不算。核心通常需要三名不同干员激活，六人进入上档（阿戈尔上档五人，炎另有九人档）。相同干员重复卡不能凑普通人数；助力上档另按名字或精锐状态区分。调和对已有真实场上成员的核心加一计数。

通用叠层要与站位、时点一起考虑：断崖在休整结束给自身和身后一格的已激活盟约各加层，空弦在下一次进入休整时给自身和身前一格加层。双方共享盟约可各得到一次。号角按最高层已激活盟约的不同阶在场干员数给层；波登可也指向最高层已激活盟约。过早让小盟约领先会影响这些通用引擎的归属，并改变优化抽卡权重。塞雷娅/白面鸮复制特质按复制者自身的位置和盟约结算；当前规划仍是保守启发式，复杂复制链不等于完整整备演算。

新增可实验的 AI 参数包括小盟约战斗增长估计、拟上场阵容的邻接叠层、概率达到 100% 后的边际衰减和实际层数门槛。第一组 168 局复验虽减少漏怪但增加缺席回合，第二组 112 局强化核心与防守的候选也未通过独立种子复验；二者未设为默认。完整记录：`benchmarks/ai-hard-layers-2026-10-10.json` 和 `benchmarks/ai-hard-core-guard-2026-10-10.json`。

本机 RTX 4070 已实测通过 GPU 单步梯度和拟合结果核对。`tools/train-ai-gpu.py` 直接使用已安装的 NVIDIA CUDA Driver 与 PTX；无需 Python 第三方包或下载模型。初始数据为 580 场绝境、2320 条玩家记录，按整局种子划分，避免同一随机种子的不同候选版本跨越训练/留出集。默认 counts 目标与现有固定回合防守评分成仿射对应：每只漏怪 25、漏怪比例 100、阵亡缺席相对完美防守的成本 450，推进轮数不作为训练目标。拟合设备端权重后，仅导出样本充分策略的有界初始评分调整；游戏运行时无需显卡。留出预测误差不能代替对局验证，脚本不会自动部署。

在项目根目录复现 GPU 数值核对、评分训练和实战样本：

```text
python tools/train-ai-gpu.py --self-test
python tools/test_ai_gpu.py
python tools/train-ai-gpu.py --input docs/benchmarks/ai600-training-2026-10-10.json --input docs/benchmarks/ai-hard-layers-2026-10-10.json --input docs/benchmarks/ai-hard-core-guard-2026-10-10.json --base-policy docs/benchmarks/ai-gpu-control-2026-10-10.json --output .cache/ai-gpu-policy.json
node tools/train-ai.mjs --difficulty HARD --policy-file .cache/ai-gpu-policy.json --seed 8801 --seeds 8 --output .cache/ai-gpu-check.json
```

训练器与原始基线/模型参数保存在 `tools/train-ai-gpu.py`、`benchmarks/ai-gpu-control-2026-10-10.json`、`benchmarks/ai-gpu-count-policy-2026-10-10.json`、`benchmarks/ai-gpu-count-model-2026-10-10.json`。显卡训练接口依据 [NVIDIA CUDA Driver API](https://docs.nvidia.com/cuda/cuda-programming-guide/03-advanced/driver-api.html)。


GPU 独立新种子实战验证完成：ratio 初版 32 对种子（64 局）平均观测玩家回合漏怪 3.198→2.927，缺席玩家回合 47→70，胜局 22→24；默认 counts 版另一组 32 对种子（64 局）漏怪 3.294→3.046，缺席回合 12→22，胜局 27→26。两版均未通过“缺席不增加”的门槛，因此均不部署。最后一组 counts 评分改善不能推断普遍胜率改善。所有新增绝境模拟共 408 局，加上先前 728 局合计 1136 局；这些研究均为四 AI，不能直接保证真人带三 AI 的表现。完整结果为 `benchmarks/ai-hard-gpu-summary-2026-10-10.json`、`benchmarks/ai-gpu-confirmation-2026-10-10.json` 和 `benchmarks/ai-gpu-count-confirmation-2026-10-10.json`。当前绝境默认仍为研究前策略，终极合作模式保留先前已验证的独立参数。


## 2026-10-10：转为最高难度终极（ABYSS）训练

训练环境按用户要求改为最高难度 ABYSS：四 AI、零真人，仅开启抽卡优化。额外数值强化、第三/四回合削弱、免费自选全部关闭。先完成的 HARD 224 场结果另存于 `benchmarks/ai-clearance-2026-10-10.json`，其候选未部署。

新增 ABYSS 352 场：四策略各 24 场初筛（种子 10101–10124），候选与现有 ABYSS 策略各 64 场独立复验（10201–10264），再各 64 场确认（10401–10464）。基线包含原有 ABYSS 专用参数，避免把根策略误当作现行最高难度基线。初筛现有策略 9/24，首领判断候选 8/24，两种 GPU 初始评分候选均 5/24。最终战候选只影响 AI 判断：首领权重 2 倍、最终战阵容适配权重 1.5 倍，没有改变真实敌人或干员属性。

首轮独立复验通关 15/64→18/64，但追加确认 9/64→8/64；两组普通回合漏怪与缺席回合分别完全相同。提升未稳定复现，候选未设为默认。两轮验证中现有策略合计 24/128，候选 26/128，不能据此宣称稳定通关。现有策略的失败有 76/104 场发生在普通回合全队淘汰，说明仅调最终战无法解决主要瓶颈，后续研究应优先改善普通回合存活及协防。352 场均无规则或模拟错误。

GPU 训练使用本地 RTX 4070 和 428 场历史 ABYSS 数据、1712 条玩家记录，训练目标为失败局指示值加 0.2 倍固定回合防守损失。增加 `--difficulty ABYSS`，按整局种子分割训练与留出数据。模型留出误差下降不代表实战胜率提升，本轮 GPU 策略没有被部署。回归检查 186 项、Python 4 项及显卡数值校验全部通过。

完整对局与审计：`benchmarks/ai-abyss-clearance-2026-10-10.json`；基线及最终战候选分别为 `benchmarks/ai-abyss-clearance-control-2026-10-10.json`、`benchmarks/ai-abyss-clearance-selected-2026-10-10.json`；GPU 模型及策略为 `benchmarks/ai-abyss-gpu-victory-model-2026-10-10.json`、`benchmarks/ai-abyss-gpu-victory-policy-2026-10-10.json`。

复现时使用相同种子对照并写入不同结果文件：

```text
python tools/train-ai-gpu.py --difficulty ABYSS --objective victory --bias-scale 40 --bias-cap 5 --input docs/benchmarks/ai728-training-2026-10-10.json --base-policy docs/benchmarks/ai-abyss-clearance-control-2026-10-10.json --output .cache/ai-abyss-gpu.json
node tools/train-ai.mjs --difficulty ABYSS --policy-file docs/benchmarks/ai-abyss-clearance-control-2026-10-10.json --seed 10401 --seeds 64 --output .cache/ai-abyss-control.json
node tools/train-ai.mjs --difficulty ABYSS --policy-file docs/benchmarks/ai-abyss-clearance-selected-2026-10-10.json --seed 10401 --seeds 64 --output .cache/ai-abyss-selected.json
```


## 2026-10-10: ABYSS >40% research, ongoing

Protocol: four AI, no human, ABYSS, draw optimization only. All operator buffs, round-3/4 debuffs and free selected recruitment disabled. Victory is the selection priority; fixed-horizon leakage and eliminated player-rounds remain explicit secondary metrics. No game combat stats, funds or pool rules are changed by policy experiments.

Seven studies completed 1,536 games so far; independent validation wins (candidate/control, 64 games each): survival 11/13; roster search 23/11; growth 20/23; placement refinement 22/21; skillful aura 9/20; stat-based unit power 20/15; public core diversification 23/19. Fresh calibration/validation seeds are used for every study. Calibration wins are never evidence of stable held-out performance. No candidate has reached the >40% acceptance target, and no new production preset has been adopted.

The selected research baseline has bounded extra roster rehearsals, exact owned-piece restoration, small-bond growth and projected formation value. Optional attack power, public-board core competition, placement refinement and active-bond unit power are planning estimates only. A separate boss rehearsal module remains unconnected pending the current frozen validation. It uses private copies of boss HP and team LP and conservative public partner snapshots, with no teammate hands, shops, funds or selected loadouts.

Reports: `benchmarks/ai-abyss-survival-2026-10-10.json`, `ai-abyss-roster-2026-10-10.json`, `ai-abyss-growth-2026-10-10.json`, `ai-abyss-layout-2026-10-10.json`, `ai-abyss-aura-2026-10-10.json`, `ai-abyss-skill-2026-10-10.json`, `ai-abyss-pool-2026-10-10.json`. All seven studies reported zero rule/engine errors. Current regression suite: 196 passed, zero failed. RTX 4070 proposal regression failed its seed-held-out baseline (MSE .23130 versus .22926); its proposals were not used. Acceptance requires a frozen candidate above 40% in at least two new-seed batches, with aggregate 95% Wilson lower bound above 40%.

### 2026-10-10: training round stopped; provisional best candidate applied

At the user's request, the ongoing >40% goal was paused and the retained research champion was applied to `BOT_POLICY.byDifficulty.ABYSS`. This affects cooperative AI decisions, including real-player teams. HARD and solo retain their previous presets. The applied preset adds bounded owned-roster rehearsal, projected formation/layer estimates, combat-power evaluation, public-board core competition and boss rehearsal (4 plans, 90 simulated seconds); it does not enable any stat boost or free operator choice.

Eleven studies completed 2,320 audited full games. Two stopped calibration studies finished another 77 individual simulations; they did not complete independent validation and were not adopted. The selected frozen policy won 25/64 in seeds 19201-19264 and 12/64 in seeds 21201-21264 (identical policy used as the combined-study control): pooled 37/128 = 28.90625%, Wilson 95% interval 21.7584%-37.2833%. The stable >40% target is not achieved. The later model and combined proposals did not improve independent win rates; unfinished lab options remain outside the production preset.

Validation after applying the preset: 197 tests passed, 0 failed; an actual Match constructor with one human and three AI loaded the exact saved policy with draw optimization enabled and all stat boosts/free picks disabled. The idle service was reloaded and health/LAN HTTP checks passed. Full results and policy: `docs/benchmarks/ai-abyss-round-2026-10-10.json` and `ai-abyss-round-policy-2026-10-10.json`.

## 2026-10-11：失败模式诊断、AI 技能/模组配置与 V1（终极 · 4 AI）

协议：同盟终极，4 名 AI，抽卡优化开启，干员增益 / 第 3–4 回合削弱 / 免费自选关闭，试阵 3。

- 诊断（基线 256 局，种子 40001–40256，86 胜）：45% 的局在第 14 回合前全队淘汰；第 13 回合后存活 0/1/2/3/4 人时通关率为 0/16/61/83/100%。漏怪峰值出现在敌人血量倍率跳升的第 7（k 4→7）和第 12 回合；联防平时挽回约一半漏怪，第 7–9 回合仅 11–20%。
- V1（写入 `botPolicy.js` 的 ABYSS 预设）：叙拉古核心偏好 −40（部署后攻速加成在后期长战斗中大部分时间失效）；歌利亚策略优先（`bandDefenseBias.ABYSS.band_sarkazb = 25`）；AI 席位使用 `botLoadout` 技能/模组配置（`PlayerState.setLoadout(…, { bot: true })`，与真人相同的 `checkLoadout` 校验）。配置表由真实战斗截取 + 反事实重放得出（`tools/capture.mjs`、`tools/cfeval.mjs`；重放与真实结果逐场一致），仅保留分半复现且显著的 5 项：松果 S0、艾丝黛尔 S0、远牙 S0、琳琅诗怀雅 S2、隐现（精锐）不装备模组；V1 期间另截取的 3783 场战斗再次确认这 5 项，未发现新的显著项。
- 独立验证（全新种子 60001–60256、70001–70352，逐种子配对）：基线 189/608（31.1%，95% CI 27.5–34.9%），V1 223/608（36.7%，32.9–40.6%），McNemar 116:82，p=0.019；平均通过回合 +0.46（p<1e-9）。验证 2 的最后 96 局为看到部分结果后追加，p 值略偏乐观。40% 目标未达到。
- 否定方向（校准种子 40001–40096）：提前/推迟升级（C2 显著更差）、四 AI 接力、叙拉古估值按回合窗口（`battleWindowByRound`，默认关）、核心偏好按存活率设置、领袖试阵加长、每候选 2 种子的稳健试阵（`robustRehearsalSeeds`，默认关）、装备再分配（最优移动与 25 次换种子的噪声相当）。
- 注意：代码中 `extraRehearsalPlans` ≤5、`rehearsalRosterCandidates` ≤4 有硬上限；Match 合并策略时最后展开根级，根级已有的键（如 `bandDefenseBias`）不能通过难度预设覆盖。
- 回归（部分完成）：直接运行 220 个测试文件，203 个通过（2689 项断言）。对其余文件做了原始代码对照：fuzz / playtest6_summons / simServe / pathing-blockable / playtest4 / playtest5-ui 6 个文件在原始代码上失败项相同（原有问题或 CRLF 环境问题），fullmatch-coop 两边均通过；data / local-extract / client-static 在两边都超时。playtest6-limits、board3d-extract、emotes、windows-launcher 4 个文件在修改版上超时，原始代码一侧未跑完，**未评估**——其中 playtest6-limits 与对局逻辑相关，建议在本机用 `npm test` 补跑。
- 详细报告与数据：`D:\wei\_ai_lab\AI_改进研究报告.md`。


## 2026-10-12 — V2（终极难度：白板队友保护、老鲤偏好；召唤物范围修复）

写回内容（原文件备份在 `D:\wei\_ai_lab\backup_v2\`）：

- **伺夜 / 缪尔赛思（战术家）召唤物范围**：召唤物只能部署在召唤者当前朝向的攻击范围内的可部署地块（`shared/summonRange.js`；服务端 `PlayerState._legal` / `summonTileOk`，召唤者转向后超出范围的召唤物退回手牌堆；客户端 `gameLogic.canPlace` 同步；机器人放置时只考虑合法地块）。测试：`test/match/tactician_summon_range.test.js`（服务端与客户端逐格一致）。对胜率无可测影响（4 AI，360 局配对 143 vs 138，p=0.44）。
- **老鲤阵营偏好**（`bandDefenseBias.ABYSS.band_lmlee = 30`）：随机分配阵营实验（720 局）中老鲤排名第一；全新种子配对确认 4 AI 胜率 268/720 → 301/720（不一致对 77:110，p=0.019）。
- **白板队友保护**（`blankProtect`、`blankDefenseWeight = 40`）：仅当有真人队友自第 2 回合起场上没有任何干员时生效，所有 AI 承担联防职责，并按白板实际漏怪数排练联防份额。3 AI + 25 血白板环境的折叠筛选（720 局）：白板活过第 13 回合 +2.4 个百分点（p=0.01），R1–R13 掉血 −0.22（p=0.014）。基数很低（约 1.7%）：中期（R7–R9）每个 AI 零漏怪概率仅 14–34%，而白板只有在两名 AI 都零漏怪时才几乎不掉血。
- **经济参数**（`econSweep`、`bankCoins`、`greyBank`、`cannotInterest`、`positionLayerWeight`、`investActivationValue`、`levelSpareMargin`、`forceBands`）：已加入代码，**默认关闭**。`econSweep` 在筛选中 rp +0.16（p=0.002），确认实验 +2.9 个百分点（p=0.17），尚未达到写入预设的标准。
- 未采用（在全新种子上未复现或有害）：`publicCoreCompetitionWeight 0.8`、`upgradeReserveCoins 0`、更快的升级曲线、`investActivationValue`。

回归：bot-core / bot-economy-support / bot-strategy / bot-team / bot / gameLogic / summons 相关测试全部通过；`test/match/playtest6_summons.test.js` 的 3 项失败与修改前相同。

## 2026-10-12 - V3（从真人对局学习；3 AI + 白板环境）

来源：两局提交到 `logs/ai_training/` 的真人对局（贾维卡 2 级叠拉普兰德、变形者集群+维多利亚，均终局 R15 胜利），加上 3 AI + 1 个不操作的 25 血白板队友环境的夜间筛选。改动前备份在 `D:\wei\_ai_lab\backup_v3\`。

写入 `byDifficulty.ABYSS`：

- **有真人队友时不偏好歌利亚**（`humanTeamBandBias.band_sarkazb = 0`，`humanTeamBandLpWeight = 0.3`）：歌利亚 45 血只保自己。筛选（8 因子折叠设计，1080 局）白板平均阵亡回合 +0.33（p=0.004）；单独 A/B（720 局配对）+0.31（p<0.001），活过 R13 +2.1 个百分点（p=0.016）。4 AI 对局不受影响（只在有真人队友时生效）。
- **站位多一轮整体调整**（`layoutRefinementPasses = 2`）：折叠设计 +0.25（p=0.026），A/B +0.12（p=0.03）。代价：每局 AI 计算量约 +20%。
- **最后几块钱换经济道具**（`econSweep`）：白板环境下单独无显著效果，之前 4 AI 筛选略正，保留。
- **变形同构体配对**（`morphPairing`，新）：变形同构体等手里有可配对装备（维式重锤系列等）时才装，装在没有该盟约的主力上，配对装备随后跟上；手里有闲置变形同构体时会买 1 块钱的维式重锤。
- **阵营套路**（`bandPolicy`，只在 AI 自己选到该阵营时生效）：贾维 R1–R7 卡 2 级、R8 起放开，保留拉普兰德，德克萨斯/普罗旺斯刷新引擎可买可卖（强制一个 AI 选贾维的对照中团队胜率 14.7%→18.6%，p=0.10）；变形者集群偏向维多利亚（无显著效果）。

全新种子确认（98001–98720，各 720 局，配对）：

| 环境 | V2 | V3 | p |
|---|---|---|---|
| 3 AI + 白板：白板活过 R13 | 2.4% | 5.4% | <0.001 |
| 3 AI + 白板：白板平均阵亡回合 | 8.64 | 9.20 | <0.001 |
| 3 AI + 白板：团队胜率 | 30.0% | 32.8% | 0.19 |
| 4 AI：胜率 | 43.5% | 45.4% | 0.33 |

未采用：空弦/断崖站位加权（`positionLayerWeight 4` + `formationGrowthWeight 0.05`，白板略负 p=0.14；AI 的空弦已有 81% 时间前方是激活盟约干员）；强制 3 个 AI 都走罗素/杜遥夜/贾维（团队胜率 31%→6%）。仓库默认配置已复现测试对局（4/4 逐回合一致）。


## 2026-10-12 — V3 移植到上游 0.2.5（docs/PORT_NOTES_AI.md）

V3 决策层（botPolicy.js / botStrategy.js / botTeam.js / botBoss.js 与 bot.js 中的 V3 部分）已移植到上游 0.2.5 的 bot.js 之上：
上游的新规则兼容（高台 placeClass、突变细胞、手牌上限、自选/DIY、个人抉择、AI 托管、表情、bondPlan / refreshValue /
冻结 / 护甲适配等）全部保留，V3 作为其上的策略层生效。行为上与 V3 原版不同、需在胜率验证中关注的点：

- 选策略：V3 的 bandScore softmax 只在 `byDifficulty.ABYSS`（合作·绝境，V3 调参与验证的环境）开启（`bandScoring: true`）；
  其它难度与单人沿用上游的起始 LP 加权抽取（上游测试要求其多样性）。上游的禁用盟约排除与队友软预留（× 0.25）对两者都生效。
  单座合作房间里老鲤的早期无资金惩罚改为 −9（原 V3 −30；仅单人 −30）。
- 核心：context().focus 取 V3 的 corePlan（无核心计划时退回上游 bondPlan.focus）；上游 bondPlan 提供 second 与 keeper 计算。
- 刷新：V3 的付费刷新预算 8（`prepRefreshes: 8`，上游 MAX_REFRESHES 16）与上游的“满场购买须胜过刷新期望”（refreshValue / BUY_FULL_MIN）
  同时生效；V3 的刷新引擎价值改名为 strategyRefreshValue。
- 满场购买：上游的板凳预算（BENCH_BUDGET 6，`benchBudget` 可调）现在也限制 V3 的引擎 / 交易 / 对子购买。
- 估值：上游护甲适配（armorFit）与 V3 waveFit 同时计入 unitBase / buyScore（可能部分重复计入防御因素）。
- 装备：突变细胞、信标、拟态物质、博士投影等按上游 itemTarget；普通装备按 V3 bestEquipmentTarget（可替换已装备道具）。
- 运行时间：3 AI + 白板 ABYSS 一局约 45–140 s（上游 AI 约 17–40 s），主要在 V3 的多次 arrange / 排练。

验证状态：移植后只做了 6 局冒烟（3 AI + 白板，ABYSS，种子 98001–98006，无错误）；胜率配对比较尚未进行。
