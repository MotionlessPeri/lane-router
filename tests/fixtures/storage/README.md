# Storage fixtures

`seed.ts` creates the smallest valid project, workspace, lane, and binding graph used by the SQLite integration tests. Tests create messages, deliveries, claims, acknowledgements, and operations through production repositories so transaction behavior remains observable.
