// Smoke test for the `_session/steering` extension method.
//
// Runs: initialize -> session/new -> session/prompt (a multi-second bash command),
// then sends `_session/steering` while that turn is still running and expects
// `{ outcome: "injected" }` plus a user_message_chunk echo in the thread.
//
// Usage: node scripts/smoke-acp-steering.mjs

import { spawn } from 'node:child_process'

function spawnAgent() {
  const proc = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] })
  proc.stdout.setEncoding('utf-8')

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
      for (const l of listeners) l(msg)
    }
  })

  return {
    proc,
    send(obj) {
      proc.stdin.write(JSON.stringify(obj) + '\n')
    },
    onMessage(cb) {
      listeners.push(cb)
    },
    kill() {
      proc.kill('SIGTERM')
    }
  }
}

const a = spawnAgent()

const seen = { echo: 0, injected: false, stopReason: null, errors: [] }
const startedAt = Date.now()
let sessionId = null
let steerTimer = null

function finish(code, message) {
  if (steerTimer) clearTimeout(steerTimer)
  console.log(`${code === 0 ? 'OK' : 'FAIL'} steering smoke: ${message}`)
  a.kill()
  process.exit(code)
}

const timeout = setTimeout(() => {
  finish(1, `timed out after 180s (seen=${JSON.stringify(seen)})`)
}, 180_000)

a.onMessage(msg => {
  if (msg?.error) seen.errors.push(msg.error)

  if (msg?.method === 'session/update') {
    if (msg.params?.update?.sessionUpdate === 'user_message_chunk') seen.echo++
  }

  if (msg?.id === 1) {
    a.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] }
    })
    return
  }

  if (msg?.id === 2 && msg?.result?.sessionId) {
    sessionId = msg.result.sessionId
    a.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Run this exact bash command, wait for it to finish, then reply with only the word done: sleep 8'
          }
        ]
      }
    })

    steerTimer = setTimeout(() => {
      a.send({
        jsonrpc: '2.0',
        id: 4,
        method: '_session/steering',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'Also add STEERED at the very end of your reply.' }],
          _meta: { steering: { idleBehavior: 'promptRequired' } }
        }
      })
    }, 3000)
    return
  }

  if (msg?.id === 4) {
    if (msg?.result?.outcome !== 'injected') {
      finish(1, `expected outcome "injected", got ${JSON.stringify(msg?.result ?? msg?.error)}`)
      return
    }
    seen.injected = true
    return
  }

  if (msg?.id === 3) {
    seen.stopReason = msg?.result?.stopReason ?? null
    clearTimeout(timeout)
    if (seen.errors.length > 0) {
      finish(1, `protocol errors: ${JSON.stringify(seen.errors)}`)
      return
    }
    if (!seen.injected) finish(1, `turn finished after ${Date.now() - startedAt}ms without an injected steer`)
    else if (seen.echo === 0) finish(1, 'no user_message_chunk echo for the steered message')
    else finish(0, `outcome=injected, echo=${seen.echo}, stopReason=${seen.stopReason}`)
  }
})

a.proc.on('exit', code => {
  if (!seen.stopReason) finish(1, `agent exited early with code ${code}: ${JSON.stringify(seen)}`)
})
a.proc.on('error', err => finish(1, String(err)))

a.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
