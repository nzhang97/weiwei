# 提交给AI学习：多设备上传到 GitHub

结算页的 **提交给AI学习** 会把本局的全部操作与每回合局面保存到运行服务器那台电脑的 `logs/ai_training/`。
为了让任何设备上打的对局都能汇总起来给 AI 学习，服务器还可以把提交的记录上传到私有仓库
`nzhang97/weiwei` 的 **`ai-logs` 分支**（只放对局记录，与 `main` 上的代码历史完全分开）。

## 在一台新设备上开启上传（一次性）

1. 拉取最新代码：`git pull`，然后 `npm install`（如未安装过）。
2. 在 GitHub 生成令牌：Settings → Developer settings → Personal access tokens → **Fine-grained tokens** →
   Generate new token。Repository access 只选 `nzhang97/weiwei`，Permissions → **Contents: Read and write**。
3. 在仓库根目录新建文件 `.env`（已被 `.gitignore` 忽略，不会被提交），内容：

   ```
   AI_LOG_GITHUB_TOKEN=github_pat_xxxxxxxx
   # 可选：在文件名里标记是哪台设备（默认用电脑名）
   AI_LOG_DEVICE=laptop
   ```

4. `npm start`。启动信息里出现
   `AI logs: 提交给AI学习 uploads to github.com/nzhang97/weiwei (branch ai-logs, device …)` 即表示已开启。

没有配置令牌的设备照常工作，只是记录只保存在本机（结算页会提示“本机未配置 GitHub 上传”）。

## 行为说明

- 上传路径：`training/<年-月>/<记录id>__<设备名>.json`；同一局重复提交不会产生重复文件。
- 断网或 GitHub 出错时，记录先保存在本机并进入 `logs/ai_training/upload-queue.json`，
  下次提交或服务器重启时自动补传。
- 结算页按钮下方会显示结果：已上传 / 已保存在本机但上传失败（会自动重试）/ 本机未配置上传。
- `ai-logs` 分支不存在时，第一次上传会自动创建（无父提交的独立分支）。
- 只有 `npm start` 启动的服务器会上传；测试和程序内启动的服务器不会。
- 如果这台设备必须通过 HTTP 代理上网（设置了 `HTTPS_PROXY`），启动前再设置环境变量 `NODE_USE_ENV_PROXY=1`（Node 22.21+/24），否则 Node 不会走代理、上传会显示 fetch failed 并进入重试队列。

## 下载所有设备的记录（分析用）

```
node tools/ai/fetch-ai-logs.mjs
```

令牌取自 `AI_LOG_GITHUB_TOKEN` 或 `GITHUB_TOKEN`（同样会读取 `.env`），记录下载到
`logs/ai_training/remote/<年-月>/`，已下载过的文件会跳过。

可选环境变量：`AI_LOG_GITHUB_REPO`（默认 `nzhang97/weiwei`）、`AI_LOG_GITHUB_BRANCH`（默认 `ai-logs`）。
