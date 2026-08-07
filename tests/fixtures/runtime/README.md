# Runtime lock fixtures

`lock-contender.ts` is a persistent child-process fixture used to exercise the Windows filesystem lock election with two real PIDs across repeated stale-owner rounds. It communicates only test outcomes over Node IPC and always releases a winning lock on request.
