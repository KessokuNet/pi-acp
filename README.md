# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Differences from upstream

[KessokuNet/pi-acp](https://github.com/KessokuNet/pi-acp) is based on
[georgeharker/pi-acp](https://github.com/georgeharker/pi-acp), itself a fork of
[svkozak/pi-acp](https://github.com/svkozak/pi-acp). This fork has not been published to npm.

It uses ACP SDK 2.6.0 over protocol v1 and adds Zed subagent cards, pi-tasks plans,
compaction cards, retry notices, automatic session titles, native rename support,
model-specific reasoning levels, and readable composer references.
MCP forwarding uses Pi's built-in support rather than a separate MCP extension.

On top of upstream it adds:

- **Subagents as ACP tasks** — a bundled pi extension bridges the
  [pi-subagents](https://github.com/tintinweb/pi-subagents) fleet into the ACP `plan` channel, so
  each subagent shows up as a task. See [Subagents as tasks](#subagents-as-tasks).
- **MCP forwarding** — ACP `mcpServers` are registered with pi's built-in MCP support for the
  session. See [MCP servers](#mcp-servers).
- **Multi-root workspaces** — additional workspace roots on `session/new` / `session/load`
  (`sessionCapabilities.additionalDirectories`), communicated to pi via `--append-system-prompt`.
- **v2-oriented session capabilities** — advertises `session/resume`, `session/close`, and
  `mcpCapabilities.http` (steps toward ACP v2 parity; see `docs/v2-parity-and-mcp-plan.md`).
- **`PI_ACP_DATA_DIR`** — env override for the adapter's own data directory (see
  [Environment variables](#environment-variables)).

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
  - When the client advertises `fs.read_text_file`, that pre-edit snapshot comes from the client's editor buffer, so a diff reflects unsaved changes instead of what is on disk
  - Tool results are forwarded as ACP content blocks, including images (pi's `read` can return a screenshot)
- Usage and cost
  - `usage_update` reports context usage (`used`/`size`) and pi's cumulative session cost (`cost.amount`, in USD)
- Configuration options
  - Model and thinking level are exposed as ACP `select` config options
- Extension UI
  - Notifications from pi extensions become ACP `notice` updates when the client advertises `session.notices`, and stay as assistant text otherwise. Both carry `_meta.piAcp.notify.level`
  - `input` and `editor` extension requests are collected through `elicitation/create` (form mode) when the client advertises elicitation, and are cancelled with a visible note otherwise
  - `setTitle` extension requests are relayed as a `session_info_update`
  - `setStatus` extension requests (the text-bar channel behind `/usage` and status extensions such as `@specode/pi-subscription-usage`) are republished as `session_info_update._meta.piAcp.status`, a map of status key to text, with an entry removed when the extension clears it. Clients that read `_meta` can render it; Zed does not, so its UI shows nothing
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
  - A restored thread replays the stored conversation: user messages, assistant text and thinking, and every tool call with its input and output. pi splits a call across two messages (the assistant message holds the tool's arguments, the `toolResult` holds its output), so `pi-acp` pairs them by tool-call id
  - Historic bash calls replay as text cards (command as the title, output plus a non-zero exit code as the body). A restored call's terminal belonged to the connection that died, so replaying the terminal `_meta` channel would render an empty card
- Prompt queueing and steering
  - A `session/prompt` sent while a turn is running is handed straight to pi with `streamingBehavior: "followUp"`, so it waits for the running turn and then runs, inside the same ACP turn. If pi refuses the prompt (e.g. while compacting), `pi-acp` holds it locally and starts it after the turn settles
  - `session/cancel` aborts the turn and clears pi's queue
  - `_session/steering` is supported as an extension method (matching claude-code-acp's convention, advertised as `_meta.steering.supported`): a client can inject a message into the running turn (`{"outcome":"injected"}`), be told to send a normal prompt instead (`{"outcome":"promptRequired"}`, when it passes `_meta.steering.idleBehavior: "promptRequired"`), or have a turn started for it (`{"outcome":"startedNewTurn"}`)
  - `_meta.piAcp.queueDepth` (and `queued.steering`/`queued.followUp` counts) is published from pi's own `queue_update`
- Multi-workspace support (`sessionCapabilities.additionalDirectories`)
  - ACP clients can pass additional workspace roots on `session/new` / `session/load` (e.g. Zed multi-root workspaces)
  - `cwd` stays the primary working directory; the additional roots are communicated to pi via `--append-system-prompt`, since pi has no native multi-root workspace concept
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` v0.80.4+ installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version)

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@geohar/pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g @geohar/pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Settings (`pi-acp.json`)

pi-acp reads its own settings from `pi-acp.json` in the pi agent's `extensions/` directory — i.e. `<PI_CODING_AGENT_DIR>/extensions/pi-acp.json` (default `~/.pi/agent/extensions/pi-acp.json`), alongside other extensions' settings. This is a dedicated pi-acp file; it is **not** merged into pi's own `settings.json`. A default file is written on first run if one does not already exist, and an existing file is never overwritten. For backward compatibility the pre-0.2.2 location — `<PI_CODING_AGENT_DIR>/pi-acp.json` (agent root) — is still read as a fallback when no file exists in `extensions/`.

Options:

- `embeddedContext` (boolean, default `true`) — advertises ACP `promptCapabilities.embeddedContext` to the client. When `false`, compliant ACP clients should avoid sending embedded `resource` blocks; if they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.
- `rpcTimeoutMs` (number, default `120000`) — per-request timeout for pi RPC calls. Generous so legitimately slow commands (e.g. compaction) finish.
- `debug` (boolean, default `false`) — emit adapter debug logging to stderr.
- `piCommand` (string, optional) — override the pi executable name/path. Absent = platform default (`pi`, or `pi.cmd` on Windows).
- `dataDir` (string, optional) — override pi-acp's own data directory. Absent = `~/.pi/pi-acp`. This controls where the session-map file and any future adapter-owned data is stored; it is separate from `PI_CODING_AGENT_DIR`, which rehomes pi's own agent directory (and hence `extensions/pi-acp.json`).

The default file written on first run contains:

```json
{
  "embeddedContext": true,
  "rpcTimeoutMs": 120000,
  "debug": false
}
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - not implemented (use the model selector UI in Zed)
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

**Note**: Slash commands provided by pi extensions are not currently supported.

## Subagents as tasks

pi itself emits no ACP plans, so the ACP `plan` (task-list) channel is unused. When you use the
[pi-subagents](https://github.com/tintinweb/pi-subagents) extension, pi-acp can surface the running
subagent fleet as an ACP plan — each subagent becomes a task with `pending` / `in_progress` /
`completed` status.

Because pi's RPC mode does not forward pi's in-process event bus (`subagents:*`), the bridging is
done by a pi extension. The `pi-acp` package doubles as that extension (`src/pi-extension.ts`,
declared under `pi.extensions`): loaded inside pi, it subscribes to the bus and, for each change,
persists a **`CustomEntry`** via `pi.appendEntry("acp:subagents", <record>)`. Appending emits an
`entry_appended` event, which pi forwards over RPC (unlike the bus itself); the adapter decodes it
into a `plan` update. `CustomEntry` (not `CustomMessageEntry`) is used deliberately so the fleet
state is recorded without entering the model's context. `entry_appended` forwards while a turn is
active (subagents run inside turns), so plan updates track the fleet during a prompt.

No configuration — it just works once the two packages are installed:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:@geohar/pi-acp   # loads the pi.extensions entry (the bridge)
```

The adapter marks the pi process it spawns with `PI_ACP=1`, which activates the bundled extension
there; the extension stays inert in a normal terminal `pi` session (no marker), so it has no effect
outside the adapter.

ACP `PlanEntryStatus` has no `failed` value, so a failed subagent is shown as `completed` with a
`(failed)` annotation.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- ACP filesystem delegation is read-only: `fs/read_text_file` is used to snapshot a file from the
  client's buffer before an edit, but writes still go through pi directly.
- No ACP terminal delegation (`terminal/*`). pi executes commands locally and the adapter only
  mirrors their output as a display-only terminal.
- No ACP permission gating (`session/request_permission`): pi executes tools locally and does not surface pre-execution tool intents over RPC, so the adapter cannot gate them yet. Permission requests are only used to render pi extension `select`/`confirm` prompts.

## MCP servers

MCP servers passed by the ACP client (`session/new`, `session/load`, `session/resume`) are handed to
the spawned pi in the `PI_ACP_MCP_SERVERS` environment variable. The bundled pi extension registers
each one with `pi.registerMcpServer()`, so pi's built-in MCP support connects them for that session
only. No extra MCP extension is needed, and nothing is written to disk.

stdio and http servers are supported; sse/acp servers are skipped with a notice. A server with the
same name in your own `mcp.json` takes precedence over the client's. The pi-acp package must be
installed as a pi package (`pi install <path or npm:...>`) for the extension to load.

A stale `<cwd>/.pi/mcp.json` left by an older pi-acp version (marked `_generatedBy: pi-acp`) is
cleaned up automatically.

### MCP policy

By default pi-acp registers every client-provided server. To control which servers it registers,
create `~/.pi/pi-acp/mcp-policy.json` (under `PI_ACP_DATA_DIR`):

```json
{
  "generate": "*",
  "exclude": ["mcp-combiner"],
  "auth": {
    "some-http-server": { "bearerTokenEnv": "MY_TOKEN", "headers": { "X-Extra": "v" } }
  }
}
```

- **`generate`** — which servers pi-acp registers: `true`/`"*"`/omitted = all (default) · `["a","b"]` =
  only those · `false` = none.
- **`exclude`** — denylist (wins over `generate`).
- **`auth`** — for a registered server, add `Authorization: Bearer ${VAR}` (+ extra headers). pi
  expands `${VAR}` when it connects.

Names are case-insensitive. Note the ACP MCP shape has no dedicated auth field, so bearer auth can
only travel as an HTTP header — either provided by the client in the server's `headers`, or added via
this policy's `auth`.

- Additional workspace roots are not a hard filesystem boundary: pi can operate outside them. They are communicated to the model (workspace awareness), not enforced as a sandbox.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
