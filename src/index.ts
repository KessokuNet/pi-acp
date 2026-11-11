import { agent as agentApp, methods, ndJsonStream, type AgentConnection } from '@agentclientprotocol/sdk/unstable'
import { PiAcpAgent } from './acp/agent.js'
import { clientConnection } from './acp/connection.js'
import { getPiCommand, shouldUseShellForPiCommand } from './pi-rpc/command.js'
import { getPiCommandOverride } from './acp/pi-acp-settings.js'
// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getPiCommand(getPiCommandOverride())
  const res = spawnSync(cmd, [], {
    stdio: 'inherit',
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>(resolve => {
      if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()

      try {
        process.stdout.write(chunk, err => {
          void err
          resolve()
        })
      } catch {
        // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
        resolve()
      }
    })
  }
})

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.on('end', () => controller.close())
    process.stdin.on('error', err => controller.error(err))
  }
})

const stream = ndJsonStream(input, output)

// The client context is read lazily: handlers and sessions only run after `connect()` returns.
const piAgent = new PiAcpAgent(clientConnection(() => connection.client))

const agent = methods.agent
const connection: AgentConnection = agentApp()
  .onRequest(agent.initialize, ({ params }) => piAgent.initialize(params))
  .onRequest(agent.authenticate, ({ params }) => piAgent.authenticate(params))
  .onRequest(agent.logout, ({ params }) => piAgent.logout(params))
  .onRequest(agent.session.new, ({ params }) => piAgent.newSession(params))
  .onRequest(agent.session.load, ({ params }) => piAgent.loadSession(params))
  .onRequest(agent.session.list, ({ params }) => piAgent.listSessions(params))
  .onRequest(agent.session.delete, ({ params }) => piAgent.deleteSession(params))
  .onRequest(agent.session.resume, ({ params }) => piAgent.resumeSession(params))
  .onRequest(agent.session.close, ({ params }) => piAgent.closeSession(params))
  .onRequest(agent.session.setMode, ({ params }) => piAgent.setSessionMode(params))
  .onRequest(agent.session.setConfigOption, ({ params }) => piAgent.setSessionConfigOption(params))
  .onRequest(agent.session.prompt, ({ params }) => piAgent.prompt(params))
  .onNotification(agent.session.cancel, ({ params }) => piAgent.cancel(params))
  .connect(stream)

function shutdown() {
  try {
    // Best-effort: dispose session subprocesses when the client disconnects.
    piAgent.dispose()
  } catch {
    // ignore
  }
  try {
    process.exit(0)
  } catch {
    // ignore
  }
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Avoid crashing if the client closes stdout early.
process.stdout.on('error', () => {
  try {
    process.exit(0)
  } catch {
    // ignore
  }
})
