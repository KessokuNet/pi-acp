// Reproduces what a client receives when restoring a pi-acp session that used the bash tool.
//
// 1) initialize (with terminal capability, like Zed) + session/new + prompt that runs bash
// 2) new process: session/load for that sessionId, dumping every replayed session/update

import { spawn } from 'node:child_process'

function spawnAgent() {
  const proc = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env
  })
  proc.stdout.setEncoding('utf8')

  let buffer = ''
  const listeners = []
  proc.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      for (const listener of listeners) listener(msg)
    }
  })

  return {
    proc,
    send(obj) {
      proc.stdin.write(JSON.stringify(obj) + '\n')
    },
    onMessage(callback) {
      listeners.push(callback)
    },
    kill() {
      proc.kill('SIGTERM')
    }
  }
}

const INIT = {
  protocolVersion: 1,
  clientCapabilities: {
    terminal: true,
    fs: { readTextFile: true, writeTextFile: true }
  }
}

function describeMeta(meta) {
  if (!meta) return undefined
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => {
      if (value && typeof value === 'object' && typeof value.data === 'string')
        return [key, `${value.data.length} chars`]
      if (value && typeof value === 'object') return [key, JSON.stringify(value)]
      return [key, value]
    })
  )
}

function describe(update) {
  const content = update.content
  const summary = {
    update: update.sessionUpdate,
    toolCallId: update.toolCallId,
    title: update.title,
    kind: update.kind,
    status: update.status,
    content: Array.isArray(content)
      ? content.map(entry => {
          if (entry?.type === 'terminal') return `terminal(${entry.terminalId})`
          const text = entry?.content?.text
          return typeof text === 'string' ? `text(${text.length} chars)` : entry?.type
        })
      : content === null
        ? null
        : undefined,
    rawInput: update.rawInput ? JSON.stringify(update.rawInput).slice(0, 90) : undefined,
    meta: describeMeta(update._meta),
    text: update.sessionUpdate === 'agent_message_chunk' ? (content?.text ?? '').slice(0, 60) : undefined
  }
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined))
}

async function createSessionWithBash(prompt) {
  const agent = spawnAgent()
  return await new Promise((resolve, reject) => {
    let sessionId = null
    const updates = []
    const timer = setTimeout(() => reject(new Error('timed out waiting for the prompt')), 240_000)

    agent.onMessage(msg => {
      if (msg?.error) console.error('[create] error response:', JSON.stringify(msg))
      if (msg?.method === 'session/update') {
        updates.push(msg.params.update)
        console.error(`[create] ${msg.params.update.sessionUpdate}`)
        return
      }
      if (msg?.id === 1) {
        console.error('[create] initialized')
        agent.send({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: process.cwd(), mcpServers: [] }
        })
      }
      if (msg?.id === 2 && msg?.result?.sessionId) {
        console.error(`[create] session ${msg.result.sessionId}`)
        sessionId = msg.result.sessionId
        agent.send({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: {
            sessionId,
            prompt: [
              {
                type: 'text',
                text:
                  prompt ?? 'Run the bash tool with the command `ls -la` and then reply with exactly the word finished.'
              }
            ]
          }
        })
        return
      }
      if (msg?.id === 3) {
        console.error('[create] prompt finished:', JSON.stringify(msg.result ?? msg.error))
        clearTimeout(timer)
        agent.kill()
        resolve({ sessionId, updates })
      }
    })
    agent.proc.on('error', reject)

    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT })
  })
}

async function loadSession(sessionId) {
  const agent = spawnAgent()
  return await new Promise((resolve, reject) => {
    const updates = []
    const timer = setTimeout(() => {
      agent.kill()
      reject(new Error('timed out waiting for session/load'))
    }, 240_000)

    agent.onMessage(msg => {
      if (msg?.error) console.error('[load] error response:', JSON.stringify(msg))
      if (msg?.method === 'session/update') {
        updates.push(msg.params.update)
        return
      }
      if (msg?.id === 4) {
        console.error('[load] initialized')
        agent.send({
          jsonrpc: '2.0',
          id: 5,
          method: 'session/load',
          params: { sessionId, cwd: process.cwd(), mcpServers: [] }
        })
      }
      if (msg?.id === 5) {
        console.error('[load] response received, replayed so far:', updates.length)
        if (msg.error) {
          clearTimeout(timer)
          agent.kill()
          reject(new Error(JSON.stringify(msg.error)))
          return
        }
        // Replayed updates arrive before the response; wait a beat for the trailing command list.
        setTimeout(() => {
          clearTimeout(timer)
          agent.kill()
          resolve(updates)
        }, 1500)
      }
    })
    agent.proc.on('error', reject)

    agent.send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: INIT })
  })
}

const only = process.argv[2]
const customPrompt = process.argv[3]
let sessionId = only
let updates = []
if (!only) {
  const created = await createSessionWithBash(customPrompt)
  sessionId = created.sessionId
  updates = created.updates
  console.log(`\n=== live prompt: ${sessionId} (${updates.length} updates)`)
  for (const update of updates) console.log(JSON.stringify(describe(update)))
} else {
  console.log(`(loading existing session ${sessionId})`)
}

const replayed = await loadSession(sessionId)
console.log(`\n=== session/load replay (${replayed.length} updates)`)
for (const update of replayed) console.log(JSON.stringify(describe(update)))
