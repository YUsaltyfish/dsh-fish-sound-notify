/**
 * dsh-notification-sound —— DSH 组合包（bundle）的 host 半体。
 *
 * 在三个时刻各播放一次提示音：
 *   1. AI 弹出选项卡、等待用户回答        → user-questions/request
 *   2. 工具请求权限、等待用户批准          → approval/request
 *   3. 一轮对话结束（AI 说完进入空闲）     → agent/status → idle
 *
 * 音频来源（均可自定义）：
 *   - 系统音效：`C:\Windows\Media` 下的文件名（默认，开箱即用）
 *   - 自定义文件夹：`soundDirectory` 指向任意目录，音效字段填该目录里的文件名
 *   - 绝对路径：音效字段直接写 `D:\我的音效\hello.mp3`
 *   `.wav` 走 System.Media.SoundPlayer（最稳）；其它格式（mp3/m4a/wma/flac…）走
 *   WPF MediaPlayer（用系统解码器）。
 *
 * 为什么不用 ctx.subprocess，而是直接 import node:child_process？
 *   官方 subprocess 服务在 Windows 上会先起一个 Node "runner" 进程做 Job 容器，
 *   而它 spawn 该 runner 时没传 windowsHide（见 @deepseek-ai/dsh-subprocess-local
 *   的 launchWindowsJob），于是每次响铃前都会闪一个 node.exe 控制台窗口。
 *   本插件自己 spawn 并显式传 windowsHide: true（实测子进程 GetConsoleWindow() = 0）。
 *
 * 文件路径一律先由 Node 解析成绝对路径，再用 base64 交给 PowerShell 解码播放，
 * 因此路径里的空格、中文、引号都不会影响脚本，也不可能造成脚本注入。
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'notification-sound'

/** 硬依赖：工具注册表 + Agent 注册表（用于区分"人面对的会话"与子 agent）。 */
export const inject = ['tools', 'agents']

/** 部署相关取值一律做成配置字段，不写死在代码里（官方配置约定）。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  notifyOnQuestion: Schema.boolean().default(true),
  notifyOnApproval: Schema.boolean().default(true),
  notifyOnTurnEnd: Schema.boolean().default(true),
  questionSound: Schema.string().default('Windows Notify Messaging.wav'),
  approvalSound: Schema.string().default('Windows Ding.wav'),
  endSound: Schema.string().default('Windows Notify System Generic.wav'),
  soundDirectory: Schema.string().default(''),
  cooldownMs: Schema.number().default(800),
  rootAgentsOnly: Schema.boolean().default(true),
  spawnTimeoutMs: Schema.number().default(15000),
})

const LOG_PREFIX = '[notification-sound] '
const SOUND_KINDS = ['question', 'approval', 'end']
const ALWAYS_FALLBACK_NAMES = ['Windows Notify System Generic.wav', 'Windows Notify.wav', 'notify.wav', 'chimes.wav']
/** 随包一起分发的音效文件夹（可以直接替换里面的文件来换音效）。 */
const BUNDLED_SOUNDS_DIR = fileURLToPath(new URL('./sounds/', import.meta.url))
/** 同名不同后缀也算：question.wav 找不到时，会继续试 question.mp3 等。 */
const TRY_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.wma', '.aac', '.flac']
/** 用户把音频丢进 sounds\\ 文件夹时用的约定文件名（有就优先播它）。 */
const CONVENTION_BY_KIND = {
  question: 'question.wav',
  approval: 'approval.wav',
  end: 'end.wav',
}
/** 上面都找不到时，每个时刻各自回退到哪个系统音效。 */
const SYSTEM_FALLBACK_BY_KIND = {
  question: 'Windows Notify Messaging.wav',
  approval: 'Windows Ding.wav',
  end: 'Windows Notify System Generic.wav',
}
const MEDIA_DIR = path.join(process.env.SystemRoot === undefined ? 'C:\\Windows' : process.env.SystemRoot, 'Media')
const POWERSHELL_CANDIDATES = [
  path.join(process.env.SystemRoot === undefined ? 'C:\\Windows' : process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'powershell.exe',
  'pwsh',
]

function describe(error) {
  if (error === undefined || error === null) return String(error)
  return error.message !== undefined ? String(error.message) : String(error)
}

function isFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile()
  } catch (error) {
    return false
  }
}

/**
 * 生成播放脚本：目标文件绝对路径以 base64 传入。
 * 退出码约定：0 成功；3 文件不存在；4/5 非 wav 播放器不可用；6 未指定文件（走系统提示音）。
 */
function playerScript(targetPath) {
  const payload = targetPath === undefined || targetPath === null ? '' : Buffer.from(String(targetPath), 'utf8').toString('base64')
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$b='" + payload + "'",
    "if ($b.Length -eq 0) { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 900; exit 0 }",
    "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))",
    "if (-not (Test-Path -LiteralPath $p)) { exit 3 }",
    "$ext=[IO.Path]::GetExtension($p).ToLowerInvariant()",
    "if ($ext -eq '.wav') { (New-Object System.Media.SoundPlayer $p).PlaySync(); exit 0 }",
    "try { Add-Type -AssemblyName PresentationCore } catch { exit 4 }",
    "$mp=$null",
    "try { $mp=New-Object System.Windows.Media.MediaPlayer } catch { exit 5 }",
    "$mp.Open([Uri]$p)",
    "$mp.Play()",
    "$probe=20",
    "while ($probe -gt 0 -and -not $mp.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 100; $probe=$probe-1 }",
    "if (-not $mp.NaturalDuration.HasTimeSpan) { $mp.Close(); exit 6 }",
    "$limit=300",
    "while ($limit -gt 0) {",
    "  if ($mp.NaturalDuration.HasTimeSpan -and $mp.Position -ge $mp.NaturalDuration.TimeSpan) { break }",
    "  Start-Sleep -Milliseconds 100",
    "  $limit=$limit-1",
    "}",
    "$mp.Close()",
    "exit 0",
  ].join('; ')
}

function exitMeaning(code) {
  if (code === 3) return '音频文件不存在'
  if (code === 4) return '非 wav 格式需要 WPF（PresentationCore）支持，当前 PowerShell 不可用'
  if (code === 5) return '无法创建 MediaPlayer（非 wav 格式播放器不可用）'
  if (code === 6) return '无法解析该音频（格式不受支持或文件损坏）'
  return '退出码=' + String(code)
}

export function apply(ctx, config) {
  const settings = config === undefined || config === null ? {} : config
  const log = (message) => console.log(LOG_PREFIX + message)

  if (settings.enabled === false) {
    log('已在配置中禁用（enabled: false），不注册任何行为。')
    return
  }

  const isWindows = process.platform === 'win32'
  const stats = { question: 0, approval: 0, turnEnd: 0, beeps: 0, last: '还没响过', lastFile: '(未指定)' }
  const lastPlayedAt = { question: 0, approval: 0, end: 0 }
  const liveChildren = new Set()

  const soundDirectory = typeof settings.soundDirectory === 'string' ? settings.soundDirectory.trim() : ''
  const directoryUsable = soundDirectory.length > 0 && (() => {
    try {
      return statSync(soundDirectory).isDirectory()
    } catch (error) {
      return false
    }
  })()
  if (soundDirectory.length > 0 && !directoryUsable) {
    log('警告：soundDirectory 不是可读目录，将只使用系统音效 → ' + soundDirectory)
  }

  ctx.effect(() => {
    return () => {
      for (const child of liveChildren) {
        try {
          child.kill()
        } catch (error) {
          // 已经退出了
        }
      }
      liveChildren.clear()
    }
  })

  function configuredFor(kind) {
    if (kind === 'question') return settings.questionSound
    if (kind === 'approval') return settings.approvalSound
    return settings.endSound
  }

  /** 在指定文件夹里找文件名；同名不同后缀也会试一遍。 */
  function locateInFolder(folder, name) {
    if (typeof folder !== 'string' || folder.length === 0) return undefined
    const direct = path.join(folder, name)
    if (isFile(direct)) return direct
    const ext = path.extname(name).toLowerCase()
    const base = ext.length > 0 ? name.slice(0, -ext.length) : name
    for (const candidate of TRY_EXTENSIONS) {
      if (candidate === ext) continue
      const alternative = path.join(folder, base + candidate)
      if (isFile(alternative)) return alternative
    }
    return undefined
  }

  /** 找顺序：用户指定的文件夹 → 插件自带 sounds\\ → 系统 Media 目录。 */
  function locateByName(name) {
    if (typeof name !== 'string') return undefined
    const trimmed = name.trim()
    if (trimmed.length === 0) return undefined
    if (path.isAbsolute(trimmed)) return isFile(trimmed) ? trimmed : undefined
    if (trimmed.includes(path.sep) || trimmed.includes('/')) return undefined
    if (directoryUsable) {
      const inCustom = locateInFolder(soundDirectory, trimmed)
      if (inCustom !== undefined) return inCustom
    }
    const inBundled = locateInFolder(BUNDLED_SOUNDS_DIR, trimmed)
    if (inBundled !== undefined) return inBundled
    return locateInFolder(MEDIA_DIR, trimmed)
  }

  /**
   * 解析出这一次要播放的绝对路径。
   * 顺序：本时刻的配置 → 另外两个时刻的配置 → 内置兜底名 → undefined（系统提示音）。
   */
  function resolveAudioFile(kind) {
    const names = [configuredFor(kind), CONVENTION_BY_KIND[kind], SYSTEM_FALLBACK_BY_KIND[kind], ...SOUND_KINDS.filter((other) => other !== kind).map(configuredFor), ...ALWAYS_FALLBACK_NAMES]
    for (const name of names) {
      const located = locateByName(name)
      if (located !== undefined) return located
    }
    return undefined
  }

  function runOnce(exe, args, signal) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let child
      try {
        child = spawn(exe, args, {
          cwd: MEDIA_DIR,
          stdio: 'ignore',
          windowsHide: true,
          ...(signal === undefined || signal === null ? {} : { signal }),
        })
      } catch (error) {
        finish({ kind: 'spawn-error', code: null, message: describe(error) })
        return
      }
      liveChildren.add(child)
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch (error) {
          // 已经退出了
        }
      }, settings.spawnTimeoutMs)
      child.once('error', (error) => {
        clearTimeout(timer)
        liveChildren.delete(child)
        finish({
          kind: 'spawn-error',
          code: error === undefined || error === null ? null : error.code,
          message: describe(error),
        })
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        liveChildren.delete(child)
        finish({ kind: 'exit', code })
      })
    })
  }

  async function playSound(kind, reason, signal, explicit) {
    if (settings.enabled === false) return { played: false, detail: '配置里已禁用（enabled: false）' }
    if (!isWindows) return { played: false, detail: '仅支持 Windows（当前平台 ' + process.platform + '），本插件不会在其它系统上发声' }
    const now = Date.now()
    if (now - lastPlayedAt[kind] < settings.cooldownMs) {
      return { played: false, detail: '同一种声音距上次不足 ' + settings.cooldownMs + 'ms，忽略这次重复触发' }
    }
    lastPlayedAt[kind] = now

    let target
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      target = locateByName(explicit)
      if (target === undefined) {
        return { played: false, detail: '指定的音频找不到：' + explicit + '（已查 soundDirectory 与 ' + MEDIA_DIR + '）' }
      }
    } else {
      target = resolveAudioFile(kind)
    }
    stats.lastFile = target === undefined ? '(系统默认提示音)' : target
    const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', playerScript(target)]

    let lastFailure = '找不到可用的 PowerShell'
    for (const exe of POWERSHELL_CANDIDATES) {
      const outcome = await runOnce(exe, args, signal)
      if (outcome.kind === 'spawn-error') {
        if (outcome.code === 'ENOENT') {
          lastFailure = '找不到 ' + exe
          continue
        }
        return { played: false, detail: '启动 ' + exe + ' 失败：' + outcome.message }
      }
      if (outcome.code === 0) {
        stats.beeps = stats.beeps + 1
        stats.last = new Date().toTimeString().slice(0, 8)
        return { played: true, detail: '音频=' + stats.lastFile + '，' + path.basename(exe) + '，退出码=0，原因=' + reason }
      }
      return { played: false, detail: '音频=' + stats.lastFile + '，' + path.basename(exe) + '：' + exitMeaning(outcome.code) + '，原因=' + reason }
    }
    return { played: false, detail: lastFailure }
  }

  function fire(kind, reason) {
    playSound(kind, reason).then((result) => {
      log(reason + ' → ' + JSON.stringify(result))
    }, (error) => {
      console.error(LOG_PREFIX + '播放提示音异常：' + describe(error))
    })
  }

  /**
   * 只对"人面对的运行根会话"响铃：子 agent（被其它 agent 拥有）不响，
   * 否则一次委派会产生一串无意义的提示音。
   */
  function isHumanFacing(agent) {
    if (settings.rootAgentsOnly === false) return true
    if (agent === undefined || agent === null) return true
    try {
      const roots = ctx.agents.roots()
      if (!Array.isArray(roots)) return true
      for (const root of roots) if (String(root.id) === String(agent.id)) return true
      return false
    } catch (error) {
      log('判断根会话失败，本次按"应响铃"处理：' + describe(error))
      return true
    }
  }

  function snapshot() {
    return '见过问询 ' + stats.question + ' 次、权限请求 ' + stats.approval + ' 次、回合结束 ' + stats.turnEnd + ' 次'
      + ' ｜ 累计响铃 ' + stats.beeps + ' 次，上次 ' + stats.last + '，最近音频 ' + stats.lastFile
  }

  // 时刻一：有人被提问（选项卡即将弹出）。waterfall 事件，浏览器端会"接单"，
  // 因此用 prepend 插到最前面：先响铃，再把话筒传下去。
  ctx.on('user-questions/request', (request, next) => {
    stats.question = stats.question + 1
    const agent = request === undefined || request === null ? undefined : request.agent
    if (settings.notifyOnQuestion !== false && isHumanFacing(agent)) {
      fire('question', '弹出选项卡，等待用户回答')
    }
    return next()
  }, { prepend: true })

  // 时刻二：有工具请求权限（界面上要弹批准卡片）。
  ctx.on('approval/request', (req, next) => {
    stats.approval = stats.approval + 1
    const agent = req === undefined || req === null ? undefined : req.agent
    if (settings.notifyOnApproval !== false && isHumanFacing(agent)) {
      const toolName = req !== undefined && req !== null && typeof req.toolName === 'string' && req.toolName.length > 0
        ? req.toolName
        : '未知工具'
      fire('approval', '请求权限：' + toolName)
    }
    return next()
  }, { prepend: true })

  // 时刻三：一轮对话结束（agent 转入 idle）。
  ctx.on('agent/status', (payload) => {
    if (payload === undefined || payload === null || payload.status !== 'idle') return
    stats.turnEnd = stats.turnEnd + 1
    if (settings.notifyOnTurnEnd === false) return
    if (!isHumanFacing(payload.agent)) return
    fire('end', '对话回合结束（agent 进入 idle）')
  })

  // 附带工具：试听、主动提醒，或直接点名播放自定义音频。
  ctx.tools.register(defineTool({
    name: 'fish_beep',
    description: '立刻播放一次提示音：kind=question 是"弹出选项卡"用的问询音，kind=approval 是"请求权限"用的提醒音，kind=end 是"对话结束"用的柔和音（默认 end）。可选 sound 直接指定要播放的文件（soundDirectory 里的文件名，或绝对路径）。',
    parameters: {
      kind: { type: 'string', description: 'question / approval / end，默认 end。' },
      sound: { type: 'string', description: '可选：直接指定音频文件（文件名或绝对路径），用于试听自定义音效。' },
      reason: { type: 'string', description: '可选：为什么要叫这一声，会写进返回信息。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value.ok ? '提示音已播放：' : '提示音没响成：') + value.detail }],
    },
    async execute(args, exec) {
      const kind = SOUND_KINDS.includes(args.kind) ? args.kind : 'end'
      lastPlayedAt[kind] = 0
      const signal = exec === undefined || exec === null ? undefined : exec.signal
      const result = await playSound(kind, args.reason === undefined ? '手动触发' : args.reason, signal, args.sound)
      return { ok: result.played, detail: result.detail + ' ｜ ' + snapshot() }
    },
  }))

  log('已装载：弹选项卡响「' + settings.questionSound + '」，请求权限响「' + settings.approvalSound
    + '」，回合结束响「' + settings.endSound + '」'
    + (directoryUsable ? '，自定义音频目录「' + soundDirectory + '」' : '，音效查找：插件自带 sounds\\ → ' + MEDIA_DIR)
    + (settings.rootAgentsOnly === false ? '（对所有 agent，含子 agent）' : '（仅人面对的根会话）')
    + (isWindows ? '' : ' ｜ 注意：当前系统不是 Windows，不会发声'))
}