# DSH Host API v1

## Terms

| Term | Meaning |
|---|---|
| DSH Host | The trusted local process that owns a DSH Session id and consumes Router messages. |
| Session id | Stable identity supplied by the authenticated DSH Host, not by a model or tool call. |
| notification | An at-least-once message index; it never contains a message body. |

## Address and authentication

The Router serves the API only on its configured loopback listener. Read the base URL from `<data-root>/discovery.json`. The v1 resources are `GET /dsh/v1/health`, `POST /dsh/v1/call`, `POST /dsh/v1/read`, and WebSocket `/dsh/v1/channel`.

Every request and WebSocket upgrade requires `Authorization: Bearer <token>`. The Router creates a random token at `<data-root>/dsh-host.token` and reuses it across Router restarts. POSIX systems enforce mode `0600`. Windows removes inherited grants, grants full control to the current owner, verifies the final ACL has exactly that one non-inherited allow rule, and fails startup if it cannot establish or verify that state. The token is not returned by `/health` or the DSH health resource. The DSH Host must not log or place it in a URL.

Except for health, requests and WebSocket upgrades require `X-DSH-Session-Id`. The authenticated Host is the authority for this value. JSON bodies cannot supply `backend`, `generation`, `conversationId`, or `sessionId`; the Router fixes `backend` to `dsh` and derives identity from the header. Possession of the token grants the ability to speak for local DSH Sessions, so the trust model is one trusted Host under the same local account, not mutually distrusting local clients.

Every JSON response contains `protocolVersion: 1`.

## HTTP resources

### Health

`GET /dsh/v1/health` returns:

```json
{"protocolVersion":1,"status":"ok"}
```

### Call

`POST /dsh/v1/call` accepts the existing Router tool schemas:

```json
{"requestKey":"host-durable-request-id","method":"lane_send","params":{"target":"project/lane","body":"text","kind":"normal"}}
```

The only accepted methods are `lane_directory`, `lane_attach_current`, `lane_send`, and `lane_ack`. `lane_restore_project` is not exposed. `requestKey` is required and retains the existing send retry semantics. A DSH attach is idempotent when the same Session is already attached to the same lane. It fails closed when a different conversation owns the lane; DSH cannot silently take over that binding. The original Claude and Codex tool paths retain their existing takeover behavior.

A successful call returns `{"protocolVersion":1,"result":...}`. For `lane_send`, `notificationState: "sent"` means only that the notification frame left the Router. It does not mean the consumer read, durably stored, or processed the message.

### Read

`POST /dsh/v1/read` accepts:

```json
{"messageIds":["message-id"]}
```

The Router first verifies that every unique id is pending and belongs to the lane currently bound to the DSH Session. If any id fails, the whole request fails before any mailbox body is read. On success it returns:

```json
{"protocolVersion":1,"messages":[{"id":"message-id","sender":"project/source","target":"project/lane","kind":"normal","replyTo":null,"createdAt":1780000000000,"body":"message text"}]}
```

`replyTo` is an opaque correlation id. It does not grant ownership, imply ordering, or authorize reading another message.

### Errors

Errors use `{"protocolVersion":1,"error":{"code":"STABLE_CODE","message":"description"}}`. Authentication failures use HTTP 401, malformed or forbidden input uses 400, ownership and Router precondition failures use 409, and unknown resources use 404.

`lane_ack` is intentionally non-idempotent. A repeated ack fails because the message is no longer pending. Before changing any row, a batch ack verifies that every pending mailbox file, or its already-moved resolved destination, exists; a predictable missing-file failure leaves the whole batch pending. Consumers must treat their own durable record as the retry authority rather than retrying ack as though it were a read.

## WebSocket channel

Open `/dsh/v1/channel` with the Bearer token and Session header. A newer connection for the same Session replaces the older socket. Reconnect preserves a previously reported busy state and does not release binding-replacement waiters; the replacement socket must report `idle` before that Session becomes replaceable. Sending a pending notification also blocks replacement independently of HTTP/WebSocket arrival order. A successful `lane_ack` retains that block until the channel reports a later `idle`, so takeover cannot split durable flush, ack, and final delivery completion across two owners. The Host may send lifecycle observations:

```json
{"protocolVersion":1,"type":"lifecycle","state":"busy"}
```

The other state is `idle`. Before the first lifecycle frame, reach is `unconfirmed`; an open socket alone is not reported as live. Disconnecting changes reach to `no_channel` and does not resolve mailbox messages.

Both normal and correction notifications use:

```json
{"protocolVersion":1,"type":"notification","notification":{"kind":"correction","messageIds":["message-id"],"messages":[{"id":"message-id","sender":"project/source"}]}}
```

Notifications are indexes, can be repeated, and contain no body or mailbox path. The consumer must not parse Markdown mailbox files.

## Consumer sequence

```mermaid
sequenceDiagram
  participant R as Router
  participant H as DSH Host
  participant D as Durable consumer store
  R->>H: WebSocket notification index
  H->>R: POST /dsh/v1/read
  R-->>H: Structured messages with bodies
  H->>D: Durable flush
  Note over H,D: Do not ack before the flush completes
  H->>R: POST /dsh/v1/call lane_ack
  R-->>H: Resolved ids
```

If the channel disconnects at any point, pending mailbox rows and files remain pending. A later notification may repeat the same ids; the consumer reads, deduplicates against its durable store, and acks only after the durable flush succeeds.
