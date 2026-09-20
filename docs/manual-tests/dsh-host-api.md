# DSH Host API manual tests

### TC-DSH-1: Authenticated read, durable flush, and ack

**Goal**: Verify the shipped Router accepts a trusted DSH Host without exposing or changing real user data.

**Fixture**: None; use a newly created temporary directory as `LANE_ROUTER_DATA_ROOT`.

**Setup**: Build the repository. Start the Router with `LANE_ROUTER_DATA_ROOT` set to the temporary directory. Read `discovery.json` and `dsh-host.token` from that directory. Use a WebSocket client that can set `Authorization` and `X-DSH-Session-Id` headers.

**Steps**:
1. Call `GET /dsh/v1/health` without a token and confirm HTTP 401, then repeat with the Bearer token and confirm protocol version 1.
2. Open `/dsh/v1/channel` as Session A and send an `idle` lifecycle frame. Attach Session A to a new lane through `/dsh/v1/call`.
3. Open and attach Session B to another lane. Send a normal message from A to B.
4. Observe a body-free notification on B. Call `/dsh/v1/read` with its id and write the returned structured object to a separate durable test file, flushing the file before continuing.
5. Call `lane_ack` through `/dsh/v1/call`. Repeat the ack once.
6. Close both sockets and stop the Router. Delete the temporary data root.

**Expected**: Unauthorized health reveals no token. The notification contains ids and senders but no body or mailbox path. Read returns the body as a field. Binding replacement remains blocked from notification send through durable flush and ack until a later `idle`. The first ack resolves the id and the second fails with an ownership/pending error. No files are created under `C:\Users\KrabsXD\.lane-router`.

**Last verified**: Not yet run manually.

**Automated coverage**: `tests/process/dsh-host-api.test.ts` and `tests/router/dsh-router-core.test.ts` exercise the corresponding isolated protocol states.

### TC-DSH-2: Reconnect and offline pending retention

**Goal**: Verify same-Session reconnect replacement and pending retention while disconnected.

**Fixture**: None; use a newly created temporary directory as `LANE_ROUTER_DATA_ROOT`.

**Setup**: Continue with two attached test Sessions in the isolated Router from TC-DSH-1.

**Steps**:
1. Open a second WebSocket for Session B with the same authenticated headers.
2. Confirm the first socket closes with replacement reason and send `idle` on the second socket.
3. Close the second socket, send a message to B, and inspect B's structured directory reach plus the isolated mailbox and database.
4. Reconnect B and wait for notification retry, then read and ack the pending id.

**Expected**: Only the newest socket receives notifications. Disconnected reach is `no_channel`. The offline send records `notificationState: "no_channel"` and remains pending. Reconnect can repeat an id, and read followed by ack resolves it once.

**Last verified**: Not yet run manually.

**Automated coverage**: `tests/process/dsh-host-api.test.ts` and `tests/router/dsh-router-core.test.ts` exercise the corresponding isolated protocol states.
