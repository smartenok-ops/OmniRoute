# OmniRoute x100 multi-instance topology

## Scope and conclusion

This report answers one question: what prevents multiple OmniRoute HTTP processes from safely
sharing state today, and what topology should serve the corrected x100 peak of about 1,250 client
requests per minute (20.8 requests per second sustained)? It does not repeat the separate retention
and PostgreSQL-migration analysis. The current SQLite discussion is limited to the constraints it
places on multiple processes. Subscription capacity and quota economics are also out of scope;
adequate provider accounts are assumed.

The load and criticality premises below are measured inputs supplied with this research task, not
values re-derived from repository code: 72% of recent inbound connections originate from the RU
production server, OmniRoute carries 47.9% of all PlusVibe client requests, and the July 29 event
was an eight-hour customer-facing outage. The corrected planning loads are about 4,427 client
requests/day now, 44,270/day at x10 (125/minute peak), and 442,700/day at x100 (1,250/minute peak).
Those facts make rolling availability and failure isolation first-order requirements even though
the corrected raw request rate is low.

The chat and Responses API request/stream machinery is mostly request-local, so an individual
request can be assigned to any replica. The service as a whole is not stateless, however. Today,
replicas would independently enforce account concurrency and rate limits, independently refresh
rotating OAuth credentials, and independently remember lockouts, live breaker state, sticky
bindings, and idempotency keys. MCP Streamable HTTP sessions are held only by the process that
created them. Those are coordination problems, not load-balancer problems.

The corrected throughput is modest for a multi-process Node deployment. The binding concerns are
availability, large-body concurrency, and shared-state correctness rather than raw requests per
second. The recommended end state starts with four to six API replicas across at least two hosts
behind a least-outstanding-request load balancer, Redis HA for live coordination, a separately
scheduled worker tier, and durable multi-node storage (expected to be PostgreSQL; its detailed
migration is out of scope here). MCP should be a separately routed pool. Replica count and heap size
must be set by load tests using the large-body workload, not request rate alone.

## 1. Shared mutable state inventory

The classifications used below are:

- **(a) safe to duplicate**: loss of global coherence affects efficiency or distribution, not a
  hard correctness guarantee.
- **(b) LB affinity**: the same logical session must return to its owning process unless that state
  is externalized.
- **(c) shared external state**: correctness or global capacity enforcement needs atomic,
  cross-replica coordination (Redis is the proposed live store).
- **(d) hard blocker**: unsafe to run active-active until redesigned; this is not solved by sticky
  routing alone.

| State                                                      | What the code does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Multi-instance classification                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General session bindings and per-key active-session counts | A module-level `Map` owns sessions and bindings, expires them with local timers, and counts active sessions per API key (`open-sse/services/sessionManager.ts:37-85`, `open-sse/services/sessionManager.ts:150-210`, `open-sse/services/sessionManager.ts:241-319`). Explicit session headers, including `x-session-id`, are accepted (`open-sse/services/sessionManager.ts:321-345`).                                                                                                                                                                                                                                                             | **(b)/(c).** Affinity preserves a binding on one replica. Global per-key limits require shared atomic counters; affinity alone cannot enforce a limit across all replicas.                                                                                                                                                             |
| Gateway connection backpressure                            | The streaming capacity check reads the same process-local active-session count and is disabled unless an operator sets a positive cap (`src/sse/utils/backpressure.ts:1-12`, `src/sse/utils/backpressure.ts:53-67`); chat calls it before dispatch (`src/sse/handlers/chat.ts:226-229`).                                                                                                                                                                                                                                                                                                                                                           | **(c)/(d).** If enabled per replica, it is useful local isolation but not global admission; if interpreted as a gateway-wide ceiling it multiplies by N. The target also needs body-weighted reservations because a raw session count treats small and compact requests alike.                                                         |
| Combo conversation stickiness                              | The file explicitly describes in-memory storage and owns a module-level sticky-binding `Map`; reads and writes occur only there (`open-sse/services/combo/sessionStickiness.ts:1-36`, `open-sse/services/combo/sessionStickiness.ts:196-287`). The combo path applies and records the binding (`open-sse/services/combo.ts:1198-1212`, `open-sse/services/combo.ts:1911-1919`).                                                                                                                                                                                                                                                                    | **(b)** as an interim measure, **(c)** for a stateless API tier. A miss fails open, so it is not a service-availability blocker, but a different replica may select a different account/model (`open-sse/services/combo/sessionStickiness.ts:321-405`).                                                                                |
| Codex session-account affinity                             | Unlike general stickiness, this pin is selected/upserted through a DB module (`src/sse/services/sessionAffinityPin.ts:73-127`); Codex enables the TTL behavior (`src/sse/services/sessionAffinityPin.ts:144-160`). The backing records are SQLite KV rows with expiry/cleanup (`src/lib/db/sessionAccountAffinity.ts:12-24`, `src/lib/db/sessionAccountAffinity.ts:57-129`, `src/lib/db/sessionAccountAffinity.ts:164-205`).                                                                                                                                                                                                                       | **(a)** across processes sharing that DB. It is recoverable by another instance. It becomes a normal durable-store concern when replicas span hosts.                                                                                                                                                                                   |
| Round-robin cursor                                         | Round-robin counters are process-local Maps and explicitly reset on restart (`open-sse/services/combo/rrState.ts:18-28`); selection mutates the local cursor (`open-sse/services/combo/rrState.ts:38-98`).                                                                                                                                                                                                                                                                                                                                                                                                                                         | **(a)** if approximate distribution is acceptable. Duplicating it skews global rotation and may concentrate traffic, so use Redis atomic counters if strict global rotation matters.                                                                                                                                                   |
| Codex/DeepSeek live quota cache                            | Codex keeps a 60-second cache plus a local credential registry (`open-sse/services/codexQuotaFetcher.ts:40-68`, `open-sse/services/codexQuotaFetcher.ts:193-270`). DeepSeek also uses a local 60-second cache (`open-sse/services/deepseekQuotaFetcher.ts:20-36`, `open-sse/services/deepseekQuotaFetcher.ts:159-229`). Fetch pacing is a process-local Promise chain (`open-sse/services/quotaFetchThrottle.ts:1-14`, `open-sse/services/quotaFetchThrottle.ts:39-77`).                                                                                                                                                                           | **(a)** for serving, but **(c)** for efficient, globally coherent quota-aware routing. N replicas multiply upstream polling and can make different saturation choices.                                                                                                                                                                 |
| Quota monitors and `quota_snapshots`                       | Monitor state and polling timers are local Maps/timers (`open-sse/services/quotaMonitor.ts:79-98`, `open-sse/services/quotaMonitor.ts:186-310`). `quota_snapshots` provides insert/read/cleanup history (`src/lib/db/quotaSnapshots.ts:18-116`, `src/lib/db/quotaSnapshots.ts:188-208`); the Codex and DeepSeek fetchers above do not use it as their live cache.                                                                                                                                                                                                                                                                                  | **(c)** at scale: elect one monitor or move polling to workers and publish current state. Historical snapshots do not provide live mutual exclusion.                                                                                                                                                                                   |
| Provider circuit breakers                                  | Breaker objects live in a registry Map. A new object restores a persisted snapshot and transitions are saved, while status discovery lazily loads persisted names (`src/shared/utils/circuitBreaker.ts:155-217`, `src/shared/utils/circuitBreaker.ts:475-503`, `src/shared/utils/circuitBreaker.ts:533-599`). Persistence uses `INSERT OR REPLACE` (`src/lib/db/domainState.ts:554-565`).                                                                                                                                                                                                                                                          | **(c).** SQLite gives restart recovery, not live coherence: already-instantiated breakers do not subscribe to peer transitions, and snapshot writes are last-writer-wins.                                                                                                                                                              |
| Model/account lockouts and failure dedup                   | Model lockouts and their status lookup are local (`open-sse/services/accountFallback.ts:389-470`, `open-sse/services/accountFallback.ts:720-795`). Per-connection failure dedup is another local Map (`open-sse/services/accountFallback.ts:99-125`), and breaker recording happens in the handling process (`open-sse/services/accountFallback.ts:880-910`).                                                                                                                                                                                                                                                                                      | **(c).** Otherwise a locked-out account on replica A remains selectable on B and failures can be overcounted across replicas.                                                                                                                                                                                                          |
| Rate limits / `rateLimitStatus`                            | Each process constructs Bottleneck limiters in a local Map (`open-sse/services/rateLimitManager.ts:77-105`, `open-sse/services/rateLimitManager.ts:152-169`). Monitoring reads those local limiter states (`open-sse/services/rateLimitManager.ts:720-760`). Learned limits are persisted as one debounced settings value (`open-sse/services/rateLimitManager.ts:763-800`).                                                                                                                                                                                                                                                                       | **(d)** for correct provider-limit enforcement: N replicas multiply the configured RPM/concurrency. Use shared token buckets/semaphores. Concurrent whole-value persistence is also vulnerable to replicas overwriting one another.                                                                                                    |
| Account semaphore / saturation                             | The source calls the semaphore in-memory, stores gates in a Map, and queues/acquires locally (`open-sse/services/accountSemaphore.ts:1-7`, `open-sse/services/accountSemaphore.ts:45-89`, `open-sse/services/accountSemaphore.ts:188-312`). Blocking and reported stats are also local (`open-sse/services/accountSemaphore.ts:314-368`).                                                                                                                                                                                                                                                                                                          | **(d)** until replaced by a distributed, lease-based semaphore. N replicas otherwise multiply each provider account's allowed concurrency.                                                                                                                                                                                             |
| Round-robin/model semaphore                                | Combo round-robin imports a second per-model semaphore (`open-sse/services/combo.ts:52`); that module explicitly keeps all gates, running counts, queues, and cooldowns in memory (`open-sse/services/rateLimitSemaphore.ts:1-10`, `open-sse/services/rateLimitSemaphore.ts:45-67`, `open-sse/services/rateLimitSemaphore.ts:127-177`).                                                                                                                                                                                                                                                                                                            | **(d)** wherever its configured concurrency/cooldown represents a real shared upstream limit. It otherwise multiplies the model cap and loses cooldowns across replicas; consolidate it with the distributed capacity primitive.                                                                                                       |
| Quota-share live in-flight load                            | Quota-share P2C uses a process-local, lease-expiring connection counter (`open-sse/services/combo/quotaShareInflight.ts:2-21`, `open-sse/services/combo/quotaShareInflight.ts:43-72`, `open-sse/services/combo/quotaShareInflight.ts:75-107`).                                                                                                                                                                                                                                                                                                                                                                                                     | **(c)** for cluster-wide least-loaded selection and concurrency caps. Duplicating is fail-open but makes every replica undercount peer load, defeating P2C/cap decisions during bursts.                                                                                                                                                |
| Monitoring health view                                     | The endpoint imports the local-state readers and aggregates their runtime state (`src/app/api/monitoring/health/route.ts:51-113`, `src/app/api/monitoring/health/route.ts:175-245`). Reset clears persisted state and the handling process's registry (`src/app/api/monitoring/health/route.ts:284-303`).                                                                                                                                                                                                                                                                                                                                          | **(c)** for a truthful cluster view. Today it reports the replica that handled the request, not cluster health; reset cannot immediately invalidate live objects in peers.                                                                                                                                                             |
| OAuth token refresh                                        | Rotation-group serialization is explicitly a process-local Map intended to prevent destructive refresh-token collisions (`open-sse/services/refreshSerializer.ts:1-18`, `open-sse/services/refreshSerializer.ts:56-102`). Token refresh owns additional in-flight/per-connection Maps, acknowledges the process/replica race, and uses a compare-and-swap persistence guard (`open-sse/services/tokenRefresh.ts:75-110`, `open-sse/services/tokenRefresh.ts:178-250`). The refresh path combines a local per-connection mutex with that serializer (`open-sse/services/tokenRefresh.ts:1752-1770`, `open-sse/services/tokenRefresh.ts:1963-1993`). | **(d), the hardest blocker.** CAS can prevent a stale DB overwrite after the fact; it cannot prevent two replicas from sending the same one-time refresh token upstream. Use distributed per-connection and rotation-family locks with leases, fencing tokens, and CAS persistence. Background work means LB affinity is insufficient. |
| Concurrent request deduplication                           | The implementation explicitly says its in-flight Map does not cross instances and applies only to non-streaming requests (`open-sse/services/requestDedup.ts:1-9`, `open-sse/services/requestDedup.ts:33-34`, `open-sse/services/requestDedup.ts:57-67`, `open-sse/services/requestDedup.ts:70-127`).                                                                                                                                                                                                                                                                                                                                              | **(a)** as an optimization. Use Redis only if cross-replica duplicate suppression is worth its cost.                                                                                                                                                                                                                                   |
| Idempotency                                                | The idempotency layer is a process-local five-second store (`src/lib/idempotencyLayer.ts:1-18`, `src/lib/idempotencyLayer.ts:48-78`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **(c)** if the API promises global idempotency. Without externalization, retrying through another replica can execute twice.                                                                                                                                                                                                           |
| Semantic cache                                             | A memory singleton is checked first; reads fall through to SQLite and writes update both memory and SQLite (`src/lib/semanticCache.ts:92-105`, `src/lib/semanticCache.ts:168-254`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **(a)** while sharing SQLite: replicas have colder L1 caches but can recover L2 entries. Redis is the more scalable shared cache at x100.                                                                                                                                                                                              |
| Signature cache                                            | Tool/family/session signatures live in process-local Maps (`open-sse/services/signatureCache.ts:16-21`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **(a)** if signatures can be relearned independently; **(b)/(c)** only if preserving session-specific learned signatures is required across requests.                                                                                                                                                                                  |

The live dashboard therefore cannot be treated as a cluster control plane. In particular, local
semaphore, limiter, lockout, and monitoring state makes adding replicas actively unsafe for shared
provider credentials, even if every client is sticky.

## 2. Storage concurrency boundary

The inspected production database was `/home/ubuntu/OmniRoute/data/storage.sqlite`, 177,070,080
bytes (about 169 MiB). This was a read-only inspection. A separate SQLite connection reported WAL,
normal locking, a 4,096-byte page size, and a 1,000-page automatic checkpoint. Connection-specific
PRAGMAs from that inspection are not evidence of application settings.

The application prefers `better-sqlite3`, then falls back to `node:sqlite`
(`src/lib/db/adapters/driverFactory.ts:37-71`). Each process owns one DB singleton
(`src/lib/db/core.ts:934-956`). When opening it, the application enables WAL, sets a 2,000 ms busy
timeout, and selects `synchronous = NORMAL`; the comment warns that the synchronous busy wait blocks
the Node event loop (`src/lib/db/core.ts:1119-1129`).

Consequently, multiple local processes can safely open the same WAL database: readers can overlap,
but SQLite still serializes write commits. On contention, the synchronous driver blocks that
replica's only HTTP event loop for up to two seconds and can then return a database-busy error. This is safe
for file integrity; it is not horizontally scalable write throughput. There is no defensible exact
transactions-per-second ceiling without benchmarking the actual disk, transaction mix, and
checkpoint behavior; that number is **unverified**. The architectural ceiling is one committing
writer at a time.

Sharing this local file is therefore an interim, same-host option only. A network filesystem must
not be inferred as safe from WAL's local multi-process behavior. For multi-host x100, use the
durable store selected by the sibling data-layer analysis (expected to be PostgreSQL), while Redis
holds ephemeral coordination. Schema conversion, retention, query migration, and exact write-load
sizing are explicitly outside this report.

## 3. Hot-path statelessness and protocol affinity

### Chat Completions and Responses

The route keepalive wrapper is created inside each Chat Completions request and clears its timer
when the stream ends (`src/app/api/v1/chat/completions/route.ts:112-138`). Responses does the same
(`src/app/api/v1/responses/route.ts:83-103`). The Responses transformer factory creates state for an
individual transform stream (`open-sse/transformer/responsesTransformer.ts:80-130`); its stream
timer/state is created per invocation and cleaned up on flush/cancel
(`open-sse/transformer/responsesTransformer.ts:360-385`,
`open-sse/transformer/responsesTransformer.ts:658-682`).

Thus a load balancer may choose any healthy replica at request start, and that connection must stay
with the chosen replica until its stream closes. A later request is technically serviceable by
another replica. It may, however, lose the process-local stickiness, learned signatures, and local
limit/session accounting catalogued above. Use an explicit `x-session-id` as the preferred affinity
key because the code already recognizes it (`open-sse/services/sessionManager.ts:321-345`); moving
those states to Redis removes the need for general API affinity.

For ordinary chat/Responses traffic, **session-affine LB routing is not required for response
correctness**. The combo stickiness implementation explicitly fails open to normal target ordering
on a miss/error (`open-sse/services/combo/sessionStickiness.ts:321-405`), and its stated purpose is
provider prompt-cache reuse rather than reconstructing server-side conversation state
(`open-sse/services/combo/sessionStickiness.ts:1-24`). Codex's separately implemented affinity pin
is recoverable through the DB and only opts in when its TTL is enabled
(`src/sse/services/sessionAffinityPin.ts:144-160`, `src/lib/db/sessionAccountAffinity.ts:57-129`).
Therefore plain non-sticky balancing is valid for API availability once global locks and limits are
externalized. Affinity remains a cache/cost optimization and a temporary way to retain local
session bindings; it cannot make local account semaphores or OAuth serializers globally correct.

### MCP

MCP is genuinely session-affine today. Streamable HTTP transport instances are stored in a
process-local session Map (`open-sse/mcp-server/httpTransport.ts:18-45`). Initialization creates and
stores a transport, while later requests look it up using `mcp-session-id` and return 404 when it is
not present (`open-sse/mcp-server/httpTransport.ts:103-123`,
`open-sse/mcp-server/httpTransport.ts:166-223`). The legacy SSE transport is also one process-local
singleton (`open-sse/mcp-server/httpTransport.ts:48-100`,
`open-sse/mcp-server/httpTransport.ts:250-267`).

Route MCP to a dedicated pool: initialization can use least-connections, then the LB must
consistently hash the returned `mcp-session-id` to the creating replica. Longer term, externalize the
transport/session abstraction or use a broker so session survival does not depend on one process.
Cookie/IP affinity is weaker: NAT groups unrelated clients and client addresses can change.

## 4. Availability, restarts, and draining

### What is possible

Multiple instances are enough to remove the Node process/container as a single point of failure and
to perform blue-green or rolling restarts without rejecting **new** client requests: start the new
color, wait for a real readiness check, remove the old color from LB selection, drain it, then stop
it. This is the same traffic-switching principle as the existing LiteLLM pattern, but not yet an
OmniRoute feature. The repository's production Compose declares one application container and one
published port, not blue/green application services or an LB
(`docker-compose.prod.yml:44-78`). Its Docker health check only accepts a 2xx from the lightweight
DB liveness route (`scripts/dev/healthcheck.mjs:54-85`, `scripts/dev/healthcheck.mjs:88-105`); that
route checks process/DB responsiveness, not whether the replica is accepting new work
(`src/app/api/health/ping/route.ts:18-47`). A deployment controller, two independently named/ported
colors, LB upstream switching, and a draining-aware readiness endpoint are therefore still needed.

Shared-state blockers apply during blue-green overlap exactly as they do during steady
active-active service. Most critically, old and new colors may refresh the same rotating OAuth token
because the serializer is local (`open-sse/services/refreshSerializer.ts:1-18`), and their local
semaphores/limiters multiply account concurrency (`open-sse/services/accountSemaphore.ts:188-312`,
`open-sse/services/rateLimitManager.ts:77-105`). The code can disable some background services on
API replicas, including quota refresh and provider-limit scheduling
(`src/instrumentation-node.ts:99-102`, `src/instrumentation-node.ts:226-238`), but that is not a
substitute for distributed request-path locks and limiters.

### What SIGTERM actually does

Startup registers the graceful-shutdown handler (`src/instrumentation-node.ts:190-218`). On SIGTERM
it sets a process-local draining flag, waits up to 30 seconds by default for a process-local active
request count, flushes spend writes, closes SQLite/audit DBs and log rotation, then calls
`process.exit(0)` (`src/lib/gracefulShutdown.ts:15-28`, `src/lib/gracefulShutdown.ts:63-92`,
`src/lib/gracefulShutdown.ts:94-150`). Compose allows 40 seconds before Docker escalates
(`docker-compose.yml:30-50`), so the nominal timers leave about ten seconds for cleanup.

There are two material gaps:

1. `trackRequest()` is the only function that increments the shutdown counter
   (`src/lib/gracefulShutdown.ts:39-53`), but repository search found no production caller. The
   counter therefore remains zero today, so SIGTERM proceeds directly to cleanup/exit instead of
   waiting for chat or SSE streams. This is verified by a repository-wide call-site search, not
   inferred from the docstring.
2. The draining gate only tests the normalized `/api/` path and returns 503
   (`src/server/authz/pipeline.ts:278-286`). Client aliases are normalized into `/api/v1/*`
   (`src/server/authz/classify.ts:14-45`), so they are covered, but the liveness route is covered too:
   the current Docker/LB probe turns unhealthy only after it receives a draining 503. There is no
   explicit readiness state, connection-count export, or LB deregistration handshake.

Consequently, restarting an instance with an in-flight SSE stream today closes its socket; the
client sees a truncated/broken stream. The optional stream-recovery wrapper is primarily upstream
recovery, is off by default, and after bytes are committed propagates later failure to the client
(`open-sse/services/streamRecovery.ts:1-11`, `open-sse/services/streamRecovery.ts:294-301`). Another
replica cannot resume the emitted byte sequence. Zero downtime for **new connections** is achievable
with blue-green/rolling routing; zero interruption for **existing streams** requires correct request
tracking, LB drain/deregistration before SIGTERM, and a drain timeout at least as long as the maximum
allowed stream (or an explicit client retry/resume contract). A heap OOM/crash cannot drain, so
admission control and spare replicas remain necessary even after graceful shutdown is fixed.

## 5. Concurrency and launcher model

There is no HTTP cluster or worker-pool option in the serving path. The standalone development
launcher spawns one Node child (`scripts/dev/run-standalone.mjs:12-33`). The `serve` CLI's declared
options contain no worker/instance count (`bin/cli/commands/serve.mjs:40-58`); daemon and foreground
modes each launch one child, and the supervisor only restarts that one server
(`bin/cli/commands/serve.mjs:230-304`, `bin/cli/commands/serve.mjs:306-359`). Repository search found
`worker_threads` in plugin/compression work, not as an HTTP serving cluster; for example LLMLingua
explicitly creates a worker for its ONNX engine (`open-sse/services/compression/engines/llmlingua/worker.ts:5-33`).

Each HTTP process therefore has one main JavaScript event loop. Network waits and independent SSE
streams overlap, but synchronous JSON work and synchronous SQLite contention execute/block on that
process's event loop. More processes use more cores and isolate heap spikes, but do not remove the
per-request clone/parse/fan-out amplification described in the measured incident facts.

## 6. Target topology

### Required design before active-active

1. **Redis HA live coordination.** Implement distributed, lease-based OAuth locks keyed by both
   connection and refresh-token rotation family, with fencing and the existing persistence CAS.
   Put provider-account semaphores, token buckets, live breaker/lockout state, per-key session
   counters, idempotency, and conversation bindings in Redis. Pub/sub should invalidate replica L1
   views. These changes address the hard blockers evidenced above.
2. **Worker tier with leadership.** Move quota polling, refresh scheduling, cleanup, and other
   periodic monitors out of every API replica, or protect each job with leader election. Current
   quota monitors are local timers (`open-sse/services/quotaMonitor.ts:186-310`), so merely cloning
   the HTTP process clones background work.
3. **Stateless API tier.** Ordinary `/v1/chat/completions` and `/v1/responses` traffic should use
   least-outstanding-request or least-connections balancing. This fits the measured risk better than
   blind round-robin: ten small requests are not equivalent to one large compact request. Preserve
   each streaming connection. Session hashing is not required for correctness after shared-state
   externalization; optionally hash an explicit `x-session-id` only to retain affinity
   optimizations during the transition.
4. **Separate MCP routing.** Hash established MCP traffic by `mcp-session-id`; do not mix it into a
   non-sticky generic API pool while its transport Map remains local.
5. **Durable multi-node store.** Keep SQLite only for the first same-host phase. Use the sibling
   analysis to define the PostgreSQL migration before multi-host scale. Do not place the WAL file on
   shared network storage based on assumptions not verified here.

### x10 (about 44,270 client requests/day; 125/minute peak)

On the current 22 GiB / 8-core host, run three replicas behind the local LB, initially with roughly
2-3 GiB heap ceilings each, not multiple 6 GiB heaps. Two replicas are the minimum availability
pair; three leaves one spare while another drains or hits a large-body transient. Reserve RAM for
native allocations, SQLite page caches, the LB, the OS, and transient overlap. Exact heap and
replica counts are **proposed starting points**, not verified capacity numbers. At only about 2.1
requests/second peak, this phase is justified by failure isolation and restart availability, not a
need for raw request throughput.

Before exposing all replicas to the same credentials, externalize OAuth locking, account
semaphores/global rate limits, and lockout/live breaker state. Add admission control based on active
weighted requests and admitted body bytes per replica, especially for compact/agent requests. LB
session hashing can temporarily retain conversation stickiness, but it cannot repair global
account limits or background refresh races. Shared local SQLite is acceptable only as this
single-host bridge, with database-busy errors, event-loop delay, WAL/checkpoint time, heap, and admitted
body bytes monitored.

### x100 (about 442,700 client requests/day; 1,250/minute peak)

Start capacity testing at four to six API replicas across at least two failure domains/hosts, each
with a 2-3 GiB heap ceiling, then scale from measurements of weighted active requests,
admitted/in-flight body bytes, heap after GC, event-loop delay, and upstream latency. The corrected
20.8 requests/second sustained peak does not justify 8-12 replicas without workload evidence.
Autoscaling on CPU or raw RPS alone will miss the incident's concurrency/body-size driver. Keep
total configured heap well below physical/container memory; raising the current 6 GiB ceiling would
increase the blast radius and delay overload rather than create backpressure. Maintain at least one
replica of spare capacity per failure domain so losing or draining a process does not immediately
recreate the concurrency collapse on its peers.

The LB should use least-outstanding/least-connections for ordinary API traffic; session affinity is
not required for API correctness after the shared coordination work described above. During the
transition it may consistently hash explicit `x-session-id` to preserve prompt-cache/session
optimizations. If none exists, a stable fingerprint could be derived from API-key identity plus a
canonical conversation identifier, but the server's current fingerprint algorithm uses request
content (`open-sse/services/sessionManager.ts:89-145`), so reproducing it at a generic LB is not free
and remains **unverified** for the chosen LB. Do not hash only on API key: one high-volume tenant
would be pinned to one replica. MCP must remain a separate `mcp-session-id`-affine pool until
redesigned.

### What adding instances cannot solve

- Per-request memory amplification from cloning, parsing, translation, and combo fan-out. Only
  reducing amplification plus body-aware admission/backpressure addresses it. Today's route-level
  admission guard only samples heap for a large request and sheds after the heap ratio is already
  high (`src/shared/middleware/chatBodyAdmission.ts:35-54`,
  `src/shared/middleware/chatBodyAdmission.ts:118-150`); it is not a reservation-based global or
  per-replica concurrency budget.
- Global provider RPM, concurrency, and quota ceilings. Local limiters multiply capacity on paper,
  not upstream entitlements (`open-sse/services/rateLimitManager.ts:77-105`,
  `open-sse/services/accountSemaphore.ts:188-312`).
- Destructive one-time OAuth refresh races; they require distributed locking
  (`open-sse/services/refreshSerializer.ts:1-18`).
- SQLite's one-writer serialization and synchronous event-loop blocking
  (`src/lib/db/core.ts:1119-1129`).
- MCP session loss on a wrong/dead replica while transport state remains local
  (`open-sse/mcp-server/httpTransport.ts:166-223`).
- Overcommit caused by multiplying large heap ceilings. Smaller isolated heaps plus global and
  per-replica admission control are the intended safety mechanism.
- A host, disk, network, or LB failure if every replica and the only shared SQLite/Redis/LB still
  reside on the same machine. Process replication is not failure-domain redundancy.

## Verification notes

This is repository research, not an implementation or benchmark. No production service, container,
or RU host was changed or contacted. The production SQLite file was queried read-only. Exact SQLite
write throughput, safe large-body concurrency per heap size, and the final replica count remain
unverified until workload-representative load tests are run.
