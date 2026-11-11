import {
  methods,
  type AgentContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@agentclientprotocol/sdk/unstable'

/** The client-side calls the adapter makes; tests substitute a fake. */
export interface AcpClientConnection {
  sessionUpdate(params: SessionNotification): Promise<void>
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
}

/** Resolves the client context lazily, since the agent is built before `connect()` returns. */
export function clientConnection(getClient: () => AgentContext): AcpClientConnection {
  return {
    sessionUpdate: params => getClient().notify(methods.client.session.update, params),
    requestPermission: params => getClient().request(methods.client.session.requestPermission, params)
  }
}
