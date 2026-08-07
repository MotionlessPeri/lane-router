# Runtime lock fixtures

`lock-contender.ts` is a child-process fixture used to exercise Windows filesystem lock election with real PIDs. It can persist a winning lock, release it on request, or exit immediately after writing reclaim ownership metadata to reproduce a crashed recovery owner.
