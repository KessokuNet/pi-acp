import type { AcpClientConnection } from '../../src/acp/connection.js'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AcpClientConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  readonly elicitationRequests: unknown[] = []
  readonly fileReads: unknown[] = []
  readonly fileContents = new Map<string, string>()
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }
  nextElicitationResponse: { action: 'accept'; content?: Record<string, unknown> } | { action: 'decline' | 'cancel' } =
    {
      action: 'cancel'
    }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }

  async createElicitation(params: unknown): Promise<unknown> {
    this.elicitationRequests.push(params)
    return this.nextElicitationResponse
  }

  async readTextFile(params: unknown): Promise<{ content: string }> {
    this.fileReads.push(params)
    const path = (params as { path?: string } | null)?.path ?? ''
    const content = this.fileContents.get(path)
    if (content === undefined) throw new Error(`no such file: ${path}`)
    return { content }
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[]; streamingBehavior?: string }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  clearQueueCount = 0
  /** Set to make the next `prompt` calls reject, exercising the adapter's local-queue fallback. */
  promptFailure: Error | null = null

  private exitHandlers: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = []

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  onExit(handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  emitExit(info: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null }) {
    for (const h of this.exitHandlers) h(info)
  }

  async prompt(message: string, attachments: unknown[] = [], streamingBehavior?: string): Promise<void> {
    if (this.promptFailure) {
      const err = this.promptFailure
      this.promptFailure = null
      throw err
    }
    this.prompts.push({ message, attachments, streamingBehavior })
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    this.clearQueueCount += 1
    return { steering: [], followUp: [] }
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  sessionStats: unknown = null

  async getSessionStats(): Promise<unknown> {
    return this.sessionStats
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AcpClientConnection {
  return conn as unknown as AcpClientConnection
}
