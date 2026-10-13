# DSH Host API design record

## Decision

Lane Router exposes a versioned, authenticated loopback API for a trusted DSH Host. DSH is a first-class `PlatformBackend`; it does not impersonate Claude or Codex and has no launcher or restore implementation.

The Host supplies the stable DSH Session id in an authenticated header. The Router supplies `backend=dsh`, owns binding generations, and rejects identity or generation fields in request JSON. A DSH attach may repeat for the same Session and lane, but cannot replace another conversation's active binding. This is an internal call precondition so existing agent tool semantics do not change.

Messages remain in the existing mailbox and database. WebSocket notifications are body-free, at-least-once indexes. The Host obtains bodies from the structured read resource, durably flushes them, and then uses the existing non-idempotent ack operation. Read performs a complete ownership and pending-state preflight before opening any mailbox file.

Schema version 7 widens only the binding backend check to include `dsh`. The adjacent migration rebuilds the binding table, copies every row unchanged, verifies the row count and foreign keys, and preserves all generations. No new durable state or mailbox is introduced.

## Consequences

An authenticated local Host can speak for any Session id because the token and same-account process are the trust boundary. The token therefore stays in the Router data root and is never returned from health resources. A disconnected Host loses reachability but not pending mail. Reconnect replaces the stale socket for the same Session and may cause repeated notifications, which consumers must tolerate.

The public wire details and consumer obligations are specified in `docs/dsh-host-api.md`.
