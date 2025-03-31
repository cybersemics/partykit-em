# Retrospective: Local-first Sync Engine

Link: [Original Proposal](https://gist.github.com/finkef/50b4b473e0e73391d401420a93ac3e7a)

---

- [Retrospective: Local-first Sync Engine](#retrospective-local-first-sync-engine)
  - [Executive Summary](#executive-summary)
  - [Goals](#goals)
  - [Approach Taken](#approach-taken)
  - [Key Learnings](#key-learnings)
  - [Challenges \& Limitations](#challenges--limitations)
  - [Architectural Evolution](#architectural-evolution)
  - [Productionization \& Next Steps](#productionization--next-steps)
  - [Conclusion](#conclusion)



## Executive Summary

This document reviews the proof-of-concept implementation of a custom local-first synchronization engine designed for **em**. The primary goal was to validate a bespoke approach, leveraging CRDTs and tailored database strategies, against the core requirements of convergence, tree consistency, and replication for **em**'s unique tree-shaped data.

The POC successfully demonstrated the viability of a custom Tree CRDT based on the principles outlined by Kleppmann, implemented using SQLite (via `wa-sqlite` and a Web Worker) on the client and Postgres on the server. While the initial architecture involving Turso and PartyKit faced limitations regarding bulk data synchronization, the exploration led to a refined architecture involving PartyKit (or preferably, self-hosted [`partyserver`](https://github.com/threepointone/partyserver/)) for real-time collaboration and a dedicated sync server for efficient initial state replication using Postgres `COPY` streams.

Overall, the POC validates the viability of a custom-built solution that effectively addresses **em**'s core requirements through precise control over the tree data structure and performance optimizations. The implementation successfully handles the inherent complexity while providing a solid foundation for future development. Key learnings around architectural choices, database selection, and the critical importance of thorough testing provide clear direction for moving forward. The solution leverages well-chosen tools to directly tackle **em**'s specific tree-based requirements while maintaining independence and flexibility.

## Goals 

The POC aimed to address the following critical requirements for **em**'s sync engine:

1.  **Convergence:** Ensure all replicas eventually reflect the same state without user intervention, regardless of operation order, through deterministic, commutative conflict resolution.
2.  **Tree Consistency:** Guarantee the data structure remains a valid Directed Acyclic Graph (DAG) at all times, preventing cycles.
3.  **Replication:** Enable efficient replication of the entire thoughtspace or specific subtrees between clients and the server.

## Approach Taken

The implemented POC consisted of the following components:

*   **Client-Side:**
    *   **Persistence:** SQLite database managed via `wa-sqlite`, running inside a Web Worker ([`src/app/worker/sql.worker.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/app/worker/sql.worker.ts)) to offload processing from the main thread.
    *   **Data Access:** A `SqliteDriver` ([`src/shared/sqlite-driver.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/shared/sqlite-driver.ts)) providing an interface to the worker for database operations. Custom hooks ([`src/app/lib/use-tree.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/app/lib/use-tree.ts), [`src/app/lib/use-op-log.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/app/lib/use-op-log.ts)) manage local state derived from the SQLite DB.
    *   **CRDT Logic:** Implicitly handled by inserting `MoveOperation` records into the local `op_log` and recalculating the tree state based on timestamped operations, mirroring the server-side logic principles.
    *   **UI:** A basic `IsomorphicTree` ([`src/app/components/isomorphic-tree.tsx`](https://github.com/cybersemics/partykit-em/blob/main/src/app/components/isomorphic-tree.tsx)) using `react-arborist`, with a virtual loading state ([`src/app/lib/use-virtual-tree.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/app/lib/use-virtual-tree.ts)) before full hydration from the local DB.
*   **Server-Side (Real-time Deltas & Collaboration):**
    *   **Compute:** PartyKit room ([`src/party/server.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/party/server.ts)), acting as a stateful WebSocket server per thoughtspace, managing client connections and relaying real-time `MoveOperation` updates. *Self-hosted `partyserver` is now the recommended deployment target.*
    *   **Database:** PostgreSQL, accessed via [`src/shared/pg-driver.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/shared/pg-driver.ts).
    *   **CRDT Processing:** Implemented primarily within the highly optimized `process_move_operations` PostgreSQL function ([`src/shared/pg-driver.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/shared/pg-driver.ts)), handling concurrent move insertions, cycle prevention, and state updates atomically based on the Kleppmann algorithm. This includes the custom deletion/restore logic, implemented by having the server analyze conflicting operations based on their `last_sync_timestamp` and insert corrective `move(node, PrevParent)` operations if a deletion occurred without knowledge of concurrent child additions.
    *   **Authentication:** Handled within PartyKit/`partyserver`'s `onBeforeConnect` hook (conceptual, not actually implemented in POC).
*   **Server-Side (Initial Sync):**
    *   **Compute:** A dedicated Node.js/Hono server ([`src/sync-server/server.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/sync-server/server.ts)).
    *   **Mechanism:** Leverages PostgreSQL's `COPY ... TO STDOUT (FORMAT binary)` to efficiently stream a snapshot of the `nodes` and `op_log` tables directly to the client, bypassing complex CRDT merging for the initial load. This server shares the same Postgres database and authentication practices as the `partyserver` component, but offers support for backpressure handling with native TCP streams which is not supported in Cloudflare Workers.
*   **Data Model:**
    *   **Tree Structure:** Managed by the `nodes` table (storing `id`, `parent_id`) and the `op_log` table (recording `MoveOperation`s with timestamps). The tree state is derived by applying the op_log according to the CRDT rules. Timestamps used the format `new Date().toISOString() + '-' + clientId`, which proved sufficient for total ordering in practice for this application domain, avoiding the complexity of formal HLCs.
    *   **Node Content/Metadata:** Intended to be handled via a Last-Write-Wins (LWW) mechanism, likely using a separate `payloads` table (present in schema but content sync logic not implemented in POC). This LWW approach can be extended to any node metadata. A separate `UPDATE` operation type could track these changes.

## Key Learnings

*   **CRDT Suitability & Confidence:** The POC strongly validated that the chosen Tree CRDT algorithm (Kleppmann) is well-suited and capable of handling complex concurrent scenarios for **em**'s specific requirements, although thorough testing is essential before production. It provides deterministic convergence superior to generic CRDT approaches for this use case.
*   **Custom Deletion/Restore Logic:** The necessity and viability of the custom server-side logic (inserting corrective moves based on sync timestamps) to handle concurrent additions to deleted subtrees was confirmed as essential for the desired user experience and achievable within the CRDT framework.
*   **Postgres `COPY` Stream for Initial Sync:** This emerged as the most significant performance win. Streaming binary snapshots via `COPY` from a dedicated server is vastly more efficient and scalable for initial workspace loading than transferring and applying individual operations, especially for large thoughtspaces (e.g., 1M nodes).
*   **Server-Side Postgres Optimizations:** Implementing the core CRDT logic directly within the `process_move_operations` Postgres function yielded *huge* performance gains by minimizing application-database round trips and leveraging the database engine's efficiency. Further optimization via indexing might be possible.
*   **Client Architecture (`wa-sqlite` + Worker):** Using SQLite in a Web Worker proved effective at keeping the main UI thread responsive during local database operations. `wa-sqlite` itself performed well. While the POC loaded the entire tree state from the worker (causing some initial delay), this is an artifact; production would leverage partial loading/virtualization already present in **em**. Moving sync logic itself into the worker is a potential future optimization.
*   **PartyKit/`partyserver` for Real-Time:** PartyKit (and preferably self-hosted `partyserver` using Wrangler) provides an excellent, reliable abstraction for managing WebSockets, handling reconnects, presence, authentication, and relaying real-time delta updates efficiently.
*   **Build Strategy:** Successfully building a complex system by composing well-chosen tools (Postgres `COPY`, SQLite client, reliable WebSocket abstraction) validates the custom approach over relying on monolithic third-party solutions.

## Challenges & Limitations

*   **PartyKit Resource Constraints:** The primary challenge was hitting Cloudflare Worker CPU and (more critically) memory limits when attempting large data transfers for initial sync. The Worker's TCP polyfill lacks proper backpressure handling for streams like Postgres `COPY`, leading to memory exhaustion. This discovery directly necessitated the dedicated sync server architecture.
*   **Turso Performance Issues:** The initial choice of Turso (managed SQLite) showed significant performance degradation with larger workspaces, necessitating the move to Postgres for the server-side component to achieve required performance.
*   **SQLite Debugging on Client:** Debugging the `wa-sqlite` instance within the Web Worker proved **difficult**, primarily relying on logging or executing manual queries via worker messages. Native development tools offer limited visibility into the worker's database state.
*   **UI Virtualization Necessity:** While the POC included a basic virtual tree, rendering very large trees (e.g., 100k+ siblings) directly in the UI requires sophisticated virtualization techniques (already handled by the main **em** application architecture). The POC's full tree transfer from worker to main thread also needs optimization.
*   **Driver Abstraction Value:** The initial idea of a shared `Driver` interface ([`src/shared/crdt.ts`](https://github.com/cybersemics/partykit-em/blob/main/src/shared/crdt.ts)) became less valuable and potentially counter-productive once server-side logic moved to highly optimized Postgres-specific functions. Maintaining the abstraction hindered leveraging platform-specific advantages, leading to the recommendation to abandon it for production.

## Architectural Evolution

Based on the learnings and challenges, the proposed architecture evolved significantly:

1.  **Dedicated Sync Server:** Introduced specifically to handle the high-throughput, memory-intensive initial sync using Postgres `COPY` streams, offloading this burden from the real-time collaboration server.
2.  **Refined PartyKit/`partyserver` Role:** Its role was clearly defined to focus solely on managing real-time WebSocket connections, authentication, and broadcasting delta operations (`push` messages), leveraging its strengths in stateful connection management. Deployment via self-hosted `partyserver` on Cloudflare Workers using Wrangler templates is preferred for greater control and integration with other Cloudflare services.
3.  **Server Database:** Changed from Turso to PostgreSQL to achieve necessary performance and leverage advanced features like custom functions and efficient `COPY` streams.
4.  **Data Access Logic:** Moved away from a shared `Driver` abstraction towards distinct, optimized data access patterns for the SQLite client and Postgres server, acknowledging that platform-specific optimization is more valuable than code sharing via a generic interface in this context.

## Productionization & Next Steps

Moving this POC towards a production-ready system requires addressing several key areas:

1.  **Rigorous CRDT Testing (CRITICAL):**
    *   Develop comprehensive test suites specifically for the CRDT logic, focusing heavily on integration tests using actual Postgres and SQLite databases.
    *   Include: Unit tests, property-based tests (verifying convergence, acyclicity), and meticulously crafted tests for known concurrency edge cases (simultaneous moves, move+delete, cycle attempts, deletion/restore scenarios with varying `last_sync_timestamp` values). *The goal is to gain high confidence in the correctness of the core algorithm under stress.*
2.  **Implement Content Sync (LWW):**
    *   Fully implement the Last-Write-Wins mechanism for node content and other metadata using the `payloads` table.
    *   Define and implement an `UPDATE` operation type to handle content changes, distinct from `MOVE`.
    *   Ensure efficient merging and retrieval of content alongside tree structure.
3.  **Robust Authentication & Authorization:**
    *   Implement a secure authentication mechanism (e.g., JWT-based) integrated consistently across both the `partyserver` (`onBeforeConnect`) and the dedicated sync server.
    *   Define and enforce authorization rules (e.g., user can only access/sync their own thoughtspaces).
4.  **Error Handling & Resilience:**
    *   Implement comprehensive error handling for network issues, database errors, failed operations, etc., with appropriate retry logic for transient failures.
    *   While the CRDT provides significant resilience against network partitions and concurrent edits, plan for potential bugs leading to state divergence.
    *   Formalize the "hard fork" capability (creating a new thoughtspace from a client's exported state/SQLite file) as a documented escape hatch for unrecoverable issues. This leverages the portability of the client's SQLite database.
5.  **Monitoring & Observability:**
    *   Integrate logging and metrics into both the `partyserver` and the sync server components to monitor performance (sync times, operation throughput), errors, and resource usage (CPU, mem, DB connections).
6.  **Scalability & Deployment:**
    *   Design the dedicated sync server for potential horizontal scaling if initial sync becomes a bottleneck.
    *   Utilize Cloudflare Workers (via `partyserver`/Wrangler) for scalable, global deployment of the real-time component.
    *   Select and configure a suitably scaled and reliable Postgres provider.
7.  **Backup & Restore:**
    *   Implement a regular, automated backup strategy for the Postgres databases.
    *   Formalize and potentially productize the ability to export/import the client-side SQLite database as a file for user-managed backups or transfers. Consider cloud storage options like S3/R2 for automated backups, potentially as a premium feature.
8.  **Native Client Considerations:**
    *   Evaluate using native SQLite bindings within Capacitor/mobile apps for potential performance gains over `wa-sqlite`.
9.  **Code Refinement:**
    *   Refactor POC code for clarity, maintainability, and production robustness. Remove the generic `Driver` interface in favor of clear, platform-specific data layers. Optimize data transfer between worker and main thread on the client, potentially moving more sync coordination logic into the worker.

## Conclusion

The POC successfully validated the core requirements of the custom local-first sync engine approach for **em**. The Tree CRDT (based on Kleppmann), combined with use of PostgreSQL features like `COPY` streams and optimized functions, provides a performant and robust solution tailored to **em**'s tree structure. This approach offers greater control and avoids the compromises of generic third-party alternatives or vendor lock-in.

While challenges related to initial sync performance in constrained environments (like early PartyKit attempts) were significant, they informed the evolution towards a more robust and viable architecture involving a dedicated sync server. The primary task remaining before production is the critical and exhaustive testing of the CRDT implementation to ensure its absolute correctness under all concurrency scenarios. With focused effort on this testing, alongside hardening infrastructure, this custom approach represents a strong path forward for **em**'s sync needs.
