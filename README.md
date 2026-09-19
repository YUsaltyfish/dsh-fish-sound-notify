# dsh-fish-sound-notify

> **三个时刻各响一声** Windows 系统提示音：
> **AI 弹出选项卡等你回答** / **有工具请求权限** / **一轮对话结束**。
> 按 DSH 官方组合包（bundle）规范打包；**响铃全程不弹任何控制台窗口**。

```sh
# English quick start
dsh plugin --profile web add ./dsh-fish-sound-notify-0.2.0.tgz
dsh --profile web --dump-config     # look for the "# == dsh-fish-sound-notify" layer
dsh web
```
Windows only. Everything is configurable: `questionSound` / `approvalSound` / `endSound` /
`cooldownMs` / `rootAgentsOnly` / `notifyOnQuestion` / `notifyOnApproval` / `notifyOnTurnEnd` / `enabled`.

---

## 它做什么

| 时刻 | 触发事件 | 默认音效 |
| --- | --- | --- |
| AI 弹出选项卡、等你回答 | `user-questions/request` | `Windows Notify.wav`（双音） |
| **有工具请求权限、等你批准** | `approval/request` | `Windows Ding.wav`（单声"叮"，较急） |
| 一轮对话结束 | `agent/status` 变为 `idle` | `Windows Notify System Generic.wav`（柔和单音） |

三种声音**各自独立冷却**，所以"刚响过结束音，紧接着弹权限卡片"不会把权限音挤掉。

附带模型工具 **`fish_beep`**：让 AI 随时响一声（试听 / 主动提醒你看屏幕），
`kind` 取 `question` / `approval` / `end`（默认 `end`）。

---

## 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | **Windows 10 / 11** | 依赖 PowerShell 与 `C:\Windows\Media` 系统音效；其它平台不会发声，但会如实返回原因、不报错崩溃 |
| DSH | `>=0.1.0-rc.1`（`engines.dsh`） | 已在 **0.1.5-rc.2** 上实测通过 |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 与官方包一致 |
| 第三方依赖 | **无** | 只用 Node 内置 `node:child_process` 与官方 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`（后者以 `peerDependencies` 声明，标准安装自带） |
| 子进程服务 | **不需要** | 0.2.0 起自己 spawn 播放进程（原因见下节） |

---

## 安装

四种方式任选，装进你要用的 profile（示例用 `web`）：

| 方式 | 命令 | 适用场景 |
| --- | --- | --- |
| **本地 tarball** | `dsh plugin --profile web add ./dsh-fish-sound-notify-0.2.0.tgz` | 别人把这个 `.tgz` 发给你 / 离线安装 |
| **源码目录** | `dsh plugin --profile web add ./bundle` | 手上有解压后的源码目录 |
| **GitHub** | `dsh plugin --profile web add github:<owner>/<repo>` | 仓库已公开。本包是纯 JS、**无构建步骤**，不需要 `allowBuilds` 构建授权 |
| **npm** | `dsh plugin --profile web add dsh-fish-sound-notify` | 作者发布到 npm 之后可用 |

装完先校验、再启动：

```sh
dsh --profile web --dump-config   # 输出里应出现 "# == dsh-fish-sound-notify" 这一层
dsh web
```

> **改完必须重启 DSH 才生效**：DSH 的配置在启动时一次性组合（除非 profile 开了 `patchReload: live`）。
> 插件市场（dshmarket）会显示「待重启」并给出一键重启按钮。

### 安装后怎么确认装好了

1. `--dump-config` 输出里出现 `# == dsh-fish-sound-notify` 层；
2. 启动日志里出现 `[fish-sound-notify] 已装载：弹选项卡响「…」，请求权限响「…」，回合结束响「…」`；
3. 让 AI 调用一次 `fish_beep`，返回形如：

   ```
   提示音已播放：铃声=end，powershell.exe，退出码=0，原因=… ｜ 见过问询 0 次、权限请求 0 次、回合结束 1 次 ｜ 累计响铃 1 次，上次 15:58:13
   ```

4. 让 AI 用选项卡问你问题 → 响问询音；让它做一次需要授权的操作 → 响权限音；它这一轮说完 → 响结束音。

---

## 配置

所有可调参数都是配置字段（官方约定：不把可能需要按部署变化的取值写死在代码里）。
默认值定义在 `index.js` 导出的 `Config` schema 中；在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

> ⚠️ patch 会**整行替换** `config`（不是深度合并），要保留的字段请一并写上。

```yaml
- id: fish-sound-notify
  config:
    approvalSound: 'Windows Notify Messaging.wav'
    cooldownMs: 1500
    notifyOnTurnEnd: false
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；`false` 时不注册任何行为 |
| `notifyOnQuestion` | boolean | `true` | 弹出选项卡时是否响 |
| `notifyOnApproval` | boolean | `true` | **请求权限时是否响** |
| `notifyOnTurnEnd` | boolean | `true` | 一轮对话结束时是否响 |
| `questionSound` | string | `Windows Notify.wav` | 问询音 |
| `approvalSound` | string | `Windows Ding.wav` | **权限音** |
| `endSound` | string | `Windows Notify System Generic.wav` | 结束音 |
| `cooldownMs` | number | `800` | **同一种**声音两次之间的最小间隔 |
| `rootAgentsOnly` | boolean | `true` | 只对"人面对的根会话"响；`false` 时子 agent 也响 |
| `spawnTimeoutMs` | number | `15000` | 播放进程的兜底存活上限，到点强杀，避免残留 |

音效字段只接受 `C:\Windows\Media` 下的**纯文件名**（`xxx.wav`；含路径分隔符或引号的值会被忽略，
以防配置值被当成脚本注入）。查找顺序是「本时刻的音效 → 另外两个时刻的音效 → 系统默认通知音 →
`notify.wav` → `chimes.wav`」；全都找不到时退回系统"星号"提示音。

---

## 为什么不会闪黑窗口了（0.2.0 的关键修复）

**旧版（0.1.x）**：官方 `subprocess` 服务在 Windows 上会先启动一个 **Node "runner" 进程**来做进程树
容器（Job 对象），而它 spawn 这个 runner 时**漏传了 `windowsHide: true`**：

```js
// @deepseek-ai/dsh-subprocess-local/lib/index.js · launchWindowsJob()
child = (internals.spawn ?? spawn)(command, [...prefix, '--', ...spec.argv], {
  cwd: process.cwd(),
  env: runnerEnvironment(...),
  stdio: runnerStdio(spec, true, ignoredStdinFd ?? 'pipe'),
  // ← 这里缺了 windowsHide: true（同文件其它两处 spawn/taskkill 都传了）
})
```

于是每次响铃前，都会先闪出一个 **node.exe 控制台窗口**。Node 的 `windowsHide` 默认是 `false`，
所以这不是本插件能通过参数绕过的 —— 只要走那条服务就会闪。

**0.2.0 起**：本插件自己 `spawn`，显式传 `windowsHide: true`（并附带 `-WindowStyle Hidden`）。
实测证据（让子进程自己报告 `GetConsoleWindow()`）：

| spawn 参数 | 子进程自报 |
| --- | --- |
| `windowsHide: false`（旧路径） | `consoleHandle=2230996`，`isVisible=True` ← 黑窗口 |
| **`windowsHide: true`（现在）** | **`consoleHandle=0`，`isVisible=False`** ← 完全不创建窗口 |

副作用（都是好事）：不再依赖 `subprocess` 服务、少一层进程（不再有 runner），
起播更快；插件卸载时会把还在播放的子进程一并收掉。

> 📌 这是官方 `dsh-subprocess-local` 的一个小缺陷，值得回报上游：给 `launchWindowsJob`
> 的那次 `spawn` 补上 `windowsHide: true` 即可让所有走该服务的插件都受益。

---

## 升级 / 卸载

```sh
# 升级：装新版本覆盖（层和依赖一起更新），然后重启 DSH
dsh plugin --profile web add ./dsh-fish-sound-notify-0.2.0.tgz

# 卸载：依赖和配置层一起移除，然后重启 DSH
dsh plugin --profile web remove dsh-fish-sound-notify
```

> 0.1.x → 0.2.0 的升级同时修掉了黑窗口问题，**必须重启**才生效。

---

## 排查（Troubleshooting）

| 现象 | 原因 / 处理 |
| --- | --- |
| **响铃前仍闪黑窗口** | 装的是 **0.1.x 旧版**。升级到 0.2.0 并重启 DSH 即可（0.2.0 不再走会闪窗口的那条服务） |
| 一声都不响 | 先让 AI 调 `fish_beep` 看 `ok`；若 `ok: true` 但没听到，检查**系统音量**与**声音方案**（Windows 设为「无声」时会静音）、是否远程桌面/无音频设备 |
| `fish_beep` 返回 `ok: false` | 把返回里的 `detail` 原文贴给 AI —— 它写明了失败在哪一步（找不到 PowerShell / 启动失败 / 退出码非 0 / 当前平台不是 Windows） |
| 弹选项卡或请求权限时不响 | 若是**子 agent** 发起，按设计不响（`rootAgentsOnly: true`）；或距上一次同种声音不到 `cooldownMs` |
| `--dump-config` 里没有这一层 | 检查 `package.json` 是否声明了 `dsh.bundle`、`dsh plugin` 的输出有没有报错、profile 的 `dsh.profile.bundles` 里是否列出本包 |
| 声音比画面慢约半秒 | 正常：每次响铃都要启动一个隐藏的 PowerShell 进程（0.3～0.6 秒） |

---

## 兼容性与维护（peer 版本范围）

`package.json` 里同一个宿主要求写了两种形式，**不是笔误** —— 读它的两个消费者用的 semver 语义不同：

| 字段 | 谁读它 | semver 语义 | 因此写成 |
| --- | --- | --- | --- |
| `engines.dsh` | 插件市场展示兼容性 | `includePrerelease: true` | 简单的 `>=0.1.0-rc.1` 就够，且对未来版本友好 |
| `peerDependencies` | npm / pnpm 安装时校验 | **默认语义** | 必须把 `0.1.x` 每个 tuple 显式列出预发布分支 |

原因：**默认语义下，带预发布标签的版本只有在"范围里存在与它 `major.minor.patch` 完全相同、
且自身带预发布标签的比较符"时才会被放行**。所以 `>=0.1.0-rc.1` 匹配不到 `0.1.5-rc.2`，
使用者会看到 `unmet peer dependency`（npm 下甚至直接 `ERESOLVE`）。

实测覆盖（真 node-semver，默认语义）：`0.1.0-rc.6` ~ `0.1.6-rc.1` ✅、`0.2.0` / `1.0.0` ✅；
`0.1.7-rc.1`（未来）需要补分支。**维护规则**：harness 升到新的 `0.1.x` tuple 时，
给 `peerDependencies["@deepseek-ai/dsh-tools"]` 追加一个分支，例如
`|| >=0.1.7-alpha.1 <0.2.0-0`。

---

## 提交到插件市场

按 `PUBLISHING.md` 的清单走：核心是往
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提一个 `data/plugins/<owner>__<repo>.yml` 条目文件（模板见 `submission-entry.yml`，分类 `notify`）。

---

## 已知限制

1. **仅 Windows**（PowerShell + `C:\Windows\Media` 系统音效）。其它平台不发声，但会返回明确原因。
2. **机器级通知**：同一进程里任何"人面对的根会话"提问/请求权限/结束都会响，不区分你在看哪个会话。
3. 起播有约 0.3～0.6 秒延迟（要启动一个隐藏的 PowerShell 进程）。
4. 同一时刻的不同声音可能叠在一起（三种声音各自冷却，互不挤占）。
5. 音效只能用 `C:\Windows\Media` 下的文件名，暂不支持自定义路径。

---

## 许可与作者

MIT · 作者：蓝色大肥鱼 (BlueFatFish)（可在 `package.json` 的 `author` 字段改成你的名字）
