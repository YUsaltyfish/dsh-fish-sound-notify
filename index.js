/**
 * dsh-fish-sound-notify —— DSH 组合包（bundle）的 host 半体。
 *
 * 在三个时刻各播放一次 Windows 系统提示音：
 *   1. AI 弹出选项卡、等待用户回答        → user-questions/request
 *   2. 工具请求权限、等待用户批准          → approval/request
 *   3. 一轮对话结束（AI 说完进入空闲）     → agent/status → idle
 *
 * 结构遵循官方文档 docs/user/develop/basic/{index,tool,config,publish}.zh.md。
 *
 * 为什么不用 ctx.subprocess，而是直接 import node:child_process？
 *   官方 subprocess 服务在 Windows 上会先起一个 Node "runner" 进程来做 Job 容器，
 *   而它 spawn 这个 runner 时漏传了 windowsHide（见 @deepseek-ai/dsh-subprocess-local
 *   lib/index.js 的 launchWindowsJob），于是每次响铃前都会闪出一个 node.exe 控制台窗口。
 *   本插件改为自己 spawn，并显式传 windowsHide: true。
 *   实测（子进程自报 GetConsoleWindow）：
 *     windowsHide=false → consoleHandle=2230996, isVisible=True   （就是那个黑窗口）
 *     windowsHide=true  → consoleHandle=0,       isVisible=False  （完全不创建窗口）
 */

import { spawn } from 'node:child_process'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'fish-sound-notify'

/** 硬依赖：工具注册表 + Agent 注册表（用于区分"人面对的会话"与子 agent）。 */
export const inject = ['tools', 'agents']

/** 部署相关取值一律做成配置字段，不写死在代码里（官方配置约定）。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  notifyOnQuestion: Schema.boolean().default(true),
  notifyOnApproval: Schema.boolean().default(true),
  notifyOnTurnEnd: Schema.boolean().default(true),
  questionSound: Schema.string().default('Windows Notify.wav'),
  approvalSound: Schema.string().default('Windows Ding.wav'),
  endSound: Schema.string().default('Windows Notify System Generic.wav'),
  cooldownMs: Schema.number().default(800),
  rootAgentsOnly: Schema.boolean().default(true),
  spawnTimeoutMs: Schema.number().default(15000),
})

const LOG_PREFIX = '[fish-sound-notify] '
const SOUND_KINDS = ['question', 'approval', 'end']
const ALWAYS_FALLBACKS = ['Windows Notify System Generic.wav', 'Windows Notify.wav', 'notify.wav', 'chimes.wav']

function describe(error) {
  if (error === undefined || error === null) return String(error)
  return error.message !== undefined ? String(error.message) : String(error)
}

/**
 * 只接受 %SystemRoot%\Media 下的安全文件名：不含路径分隔符、通配符、引号。
 * 配置值会被拼进 PowerShell 单引号字符串，这一步是防注入的硬边界。
 */
function safeSoundName(name) {
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  if (trimmed.length === 0) return undefined
  if (!/^[^\\/:*?"<>|']+\.wav$/i.test(trimmed)) return undefined
  return trimmed
}

/** 生成一段 PowerShell 脚本：按顺序找到第一个存在的系统音效并同步播放。 */
function soundScript(fileNames) {
  const candidates = []
  for (const entry of fileNames) {
    const safe = safeSoundName(entry)
    if (safe !== undefined && !candidates.includes(safe)) candidates.push(safe)
  }
  const quoted = candidates.map((entry) => "'" + entry + "'").join(',')
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$m=Join-Path $env:SystemRoot 'Media'",
    "$c=@(" + quoted + ")",
    "$f=$null",
    "foreach($n in $c){ $p=Join-Path $m $n; if(Test-Path $p){ $f=$p; break } }",
    "if($f){ (New-Object System.Media.SoundPlayer $f).PlaySync() } else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 900 }",
  ].join('; ')
}

export function apply(ctx, config) {
  const settings = config === undefined || config === null ? {} : config
  const log = (message) => console.log(LOG_PREFIX + message)

  if (settings.enabled === false) {
    log('已在配置中禁用（enabled: false），不注册任何行为。')
    return
  }

  const isWindows = process.platform === 'win32'
  const stats = { question: 0, approval: 0, turnEnd: 0, beeps: 0, last: '还没响过' }
  /** 每种声音各自的冷却时间戳：三个时刻互不挤占。 */
  const lastPlayedAt = { question: 0, approval: 0, end: 0 }
  /** 正在播放的进程，插件卸载时一并收掉（官方约定：副作用必须可回收）。 */
  const liveChildren = new Set()

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

  function soundFor(kind) {
    if (kind === 'question') return settings.questionSound
    if (kind === 'approval') return settings.approvalSound
    return settings.endSound
  }

  function snapshot() {
    return '见过问询 ' + stats.question + ' 次、权限请求 ' + stats.approval + ' 次、回合结束 ' + stats.turnEnd + ' 次'
      + ' ｜ 累计响铃 ' + stats.beeps + ' 次，上次 ' + stats.last
  }

  /** 起一个隐藏窗口的 PowerShell 播放声音；返回它的结局。 */
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
          cwd: 'C:/Windows',
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

  async function playSound(kind, reason, signal) {
    if (settings.enabled === false) return { played: false, detail: '配置里已禁用（enabled: false）' }
    if (!isWindows) return { played: false, detail: '仅支持 Windows（当前平台 ' + process.platform + '），本插件不会在其它系统上发声' }
    const now = Date.now()
    if (now - lastPlayedAt[kind] < settings.cooldownMs) {
      return { played: false, detail: '同一种声音距上次不足 ' + settings.cooldownMs + 'ms，忽略这次重复触发' }
    }
    lastPlayedAt[kind] = now

    const sound = soundFor(kind)
    const candidates = [sound, ...SOUND_KINDS.filter((other) => other !== kind).map(soundFor), ...ALWAYS_FALLBACKS]
    const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', soundScript(candidates)]

    let lastFailure = '找不到可用的 PowerShell'
    for (const exe of ['powershell.exe', 'pwsh']) {
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
        return { played: true, detail: '铃声=' + sound + '，' + exe + '，退出码=0，原因=' + reason }
      }
      return { played: false, detail: exe + ' 退出码=' + String(outcome.code) + '，原因=' + reason }
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

  // 时刻一：有人被提问（选项卡即将弹出）。这是 waterfall 事件，浏览器端会"接单"，
  // 一旦接单下游监听器就收不到，所以用 prepend 插到最前面，响铃后再把话筒传下去。
  ctx.on('user-questions/request', (request, next) => {
    stats.question = stats.question + 1
    const agent = request === undefined || request === null ? undefined : request.agent
    if (settings.notifyOnQuestion !== false && isHumanFacing(agent)) {
      fire('question', '弹出选项卡，等待用户回答')
    }
    return next()
  }, { prepend: true })

  // 时刻二：有工具请求权限（界面上要弹批准卡片）。同样是 waterfall，必须放行 next()。
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

  // 附带工具：让模型随时响一声（试听 / 主动提醒用户看屏幕）。
  ctx.tools.register(defineTool({
    name: 'fish_beep',
    description: '立刻播放一次系统提示音：kind=question 是"弹出选项卡"用的问询音，kind=approval 是"请求权限"用的提醒音，kind=end 是"对话结束"用的柔和音（默认 end）。可用于试听或提醒用户看屏幕。',
    parameters: {
      kind: { type: 'string', description: 'question / approval / end，默认 end。' },
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
      const result = await playSound(kind, args.reason === undefined ? '手动触发' : args.reason, signal)
      return { ok: result.played, detail: result.detail + ' ｜ ' + snapshot() }
    },
  }))

  log('已装载：弹选项卡响「' + settings.questionSound + '」，请求权限响「' + settings.approvalSound
    + '」，回合结束响「' + settings.endSound + '」'
    + (settings.rootAgentsOnly === false ? '（对所有 agent，含子 agent）' : '（仅人面对的根会话）')
    + (isWindows ? '' : ' ｜ 注意：当前系统不是 Windows，不会发声'))
}
