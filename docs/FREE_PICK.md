# 每轮自选干员（可选功能，默认关闭）

## 开启方式
- **启动器**：勾选「每轮自选干员（不超过商店等级，未用次数保留）」后启动（或重启）服务器。
- **命令行**：启动服务器前设置环境变量 `SP_FREE_PICK=1`（也接受 `on` / `true` / `yes`）。

开关在服务器启动时读取，对这台服务器上的所有房间生效；修改后需要重启服务器。

## 规则
- 每个备战回合开始时，每名**真人玩家**的自选次数 +1；没用掉的次数保留到之后的回合，**不设上限**。
- 每次自选可以免费获得 1 名干员。可选范围是本局公共牌池里**阶级不超过自己当前商店等级**、**未被 ban**、**还有剩余库存**的干员（不含自选编队的 DIY 槽位，也不能直接选精英形态）。
- 选中的干员和商店购买一样，从公共牌池扣 1 份库存；凑齐三份会照常合成精英，「获得干员时」类效果照常触发；卖出时库存退回牌池。
- 和购买一样，只能在备战阶段、点「准备」之前使用；整备区满时不能自选。
- AI 队友不使用这个功能。

## 界面
功能开启时，商店栏的冻结 / 刷新按钮旁会出现「自选 ×N」按钮。点开后按阶级列出当前可选的干员，点击头像即可领取。

## 实现位置
- 服务端：`server/match/player/economy.js`（`freePick` / `freePickCandidates`）、`server/match/player/round.js`（每回合 +1）、
  `server/match/player/views.js`（`m.private.shop.freePicks` / `freePickCands`）、`server/lobby.js`（读取 `SP_FREE_PICK`）、
  `server/match/match/intents.js` 与 `shared/protocol.js`（消息 `g.freePick { chessId }`）、`shared/constants.js`（错误码 `NO_PICKS`）。
- 客户端：`public/js/ui/freePick.js`、`public/js/ui/shopBar.js`、`public/js/ui/gameActions.js`、`public/css/screens/game-shop.css`。
- 启动器：`启动器.cmd`（复选框 → `SP_FREE_PICK=1`）。
- 测试：`test/match/free-pick.test.js`、`test/ui/free-pick-ui.test.js`；`test/match/fuzz.test.js` 中一半的对局开启此功能。
