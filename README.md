# dsh-notification-sound

在三个时刻各响一声提示音：**AI 弹出选项卡问你问题**、**有工具请求你批准**、**一轮对话结束**。音效可换成你自己的。仅支持 Windows 10 / 11。

## 安装

```sh
dsh plugin --profile desktop add github:YUsaltyfish/dsh-notification-sound
```

桌面端通常自动加载；命令行版（`dsh web`）把 `desktop` 换成 `web` 并重启一次。

## 换成你自己的音频

把音频改名成 `question.wav`（问询）/ `approval.wav`（权限）/ `end.wav`（结束），丢进：

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-notification-sound\sounds\
```

支持 `.wav .mp3 .m4a .wma .aac .flac`（建议优先 `.wav`）。⚠️ 升级或重装会覆盖这个文件夹；想长期保留就把音频放任意文件夹，在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾加（保存后一两秒生效，不用重启）：

```yaml
- id: notification-sound
  config:
    soundDirectory: 'D:\我的音效'   # 再按需加 questionSound / approvalSound / endSound
```

## 设置项

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `soundDirectory` | 空 | 自定义音效文件夹；留空用自带 `sounds\`，再找不到用系统音效 |
| `questionSound` / `approvalSound` / `endSound` | 系统音效 | 三个时刻各自的音频（文件名或完整路径） |
| `notifyOnQuestion` / `notifyOnApproval` / `notifyOnTurnEnd` | `true` | 分别开关三个时刻 |
| `enabled` / `cooldownMs` / `rootAgentsOnly` | `true` / `800` / `true` | 总开关 / 同种声音最小间隔(ms) / 只对人面对的会话响 |

> 这几行是**整段替换**的：改设置时要把想保留的项一起写上。

## 试听与卸载

让 AI 调 **`fish_beep`** 试听；出问题就把它返回的 `detail` 贴给 AI。

```sh
dsh plugin --profile desktop remove dsh-notification-sound
```

MIT · 作者：YUsaltyfish
