# QA cases: the outbox, the loopback adapter and the merge policy

Format from `docs/AGENTS.md`: Given / When / Then / Layer / Blocked-by.
Owner: `db-architect` (the skill), with `tenancy-guard` on anything about what a role may queue.
Implemented by `tests/app/sync.spec.ts` unless a case says otherwise.

## How to read these

Every case here is about a rule from `docs/01-architecture-review.md` C.3, executed rather than described.
The rules live as data in `src/app/sync/policy.ts`, so a case names the primitive it exercises (`write_once`, `ordinal`, `sticky`, `coupled`, `recompute`, `implies`, `local_only`, `immutable`) and asserts the outcome, never the code path.

Two devices in these cases means two local IndexedDB databases sharing one loopback server database, all in memory.
"Stale" means the second device pulled, then wrote against what it pulled, while the first device wrote something else in between.

`Blocked-by: no transport` means the case needs a real network and cannot exist in this build: nothing here has ever run over one, which is why the panel says `Adapter: loopback` in plain text.

---

## Group 1: the drain

### QC-SYNC-001 A drain moves every pending entry to sent and lands the row
- Given: one asset created through the scoped repository, so one pending outbox entry
- When: `push()`
- Then: the entry reads `sent` with `attempts: 1` and stays in the log, outbox depth is 0, and the server holds the row with a `server_updated_at` the server chose
- Layer: unit
- Blocked-by: none

### QC-SYNC-002 A patch merges into the row its create made
- Given: a create and then a patch, both queued
- When: both drain in `seq` order
- Then: the server row carries the patched field and the created fields, at `rev` 2. Causal order is the only order a patch stream can be applied in
- Layer: unit
- Blocked-by: none

### QC-SYNC-003 A patch for a row the server never saw is promoted, not failed
- Given: an outbox holding a patch whose create is gone (the state hydration leaves, D12)
- When: `push()`
- Then: the whole local row is sent, minus its local-only fields. See D30 for why failing here would misrepresent the design
- Layer: unit
- Blocked-by: none

### QC-SYNC-004 A patch with no row anywhere fails loudly
- Given: an outbox entry naming a row that exists on neither side
- When: `push()`
- Then: the entry is `failed`, `last_error` says nothing to merge into, and no row is invented on the server
- Layer: unit
- Blocked-by: none

### QC-SYNC-005 A retry after a transport failure resumes without duplicating
- Given: an entry that failed mid flight, with the far side having already applied it
- When: the entry is retried
- Then: the row is unchanged and no duplicate is created
- Layer: integration
- Blocked-by: no transport. A loopback drain cannot fail mid flight, so the `attempts` and `last_error` fields are maintained and have never been exercised under a real failure. Recorded in `qa/manual-checklist.md`

## Group 2: the cursor

### QC-SYNC-010 A pull applies rows another device pushed
- Given: device A created an asset and pushed it
- When: device B pulls
- Then: B holds the row, and B queues nothing back: a pulled row is not work B did
- Layer: unit
- Blocked-by: none

### QC-SYNC-011 The cursor advances, so a second pull is a no-op
- Given: one completed pull
- When: pull again with nothing new on the server
- Then: zero rows applied, and `sync_state` carries both halves of the cursor, `(server_updated_at, id)`
- Layer: unit
- Blocked-by: none

### QC-SYNC-012 A synced row stops reading as never synced
- Given: a locally created row, whose `server_updated_at` is null by construction
- When: push then pull
- Then: the local row carries the server's instant. The client never writes this column itself
- Layer: unit
- Blocked-by: none

### QC-SYNC-013 A device with a fast clock does not make its rows invisible
- Given: a device whose `updated_at` is forty minutes in the future
- When: another device pulls
- Then: the row arrives, because the cursor orders by `server_updated_at` and never by the client's clock
- Layer: unit
- Blocked-by: none. Covered indirectly today (the server assigns every cursor value), and worth a dedicated case when a second clock is injectable per device

## Group 3: band 4, the rule that matters most

### QC-SYNC-020 A stale device cannot flip a rejected clip back to approved
- Given: device A rejected a clip and pushed. Device B, holding the pre-rejection copy, approves it
- When: B pushes
- Then: the server still reads `rejected`, and B reads `rejected` after its next pull. Primitive: `ordinal`
- Layer: unit
- Blocked-by: none

### QC-SYNC-021 The refusal is a row, not a notification
- Given: the refusal above
- When: the push completes
- Then: a `sync_conflict` row exists with the policy, the kept value, the refused value, the direction and no resolution. A conflict that is only a toast is discovered three weeks later inside a campaign
- Layer: unit
- Blocked-by: none

### QC-SYNC-022 A coupled group is refused as a unit
- Given: a rejection with its reason, and a competing approval carrying a different note
- When: the merge runs
- Then: every field of the losing decision loses with it. Field-level last-write-wins would leave a rejection sitting next to another reviewer's note, which is how an audit log starts lying. Primitive: `coupled`
- Layer: unit
- Blocked-by: none

### QC-SYNC-023 A rejection unpublishes even when the patch never said so
- Given: a published, approved clip, and a patch carrying only `review_status: rejected`
- When: the merge runs
- Then: `is_published` and its integer mirror are false, and the correction is recorded. Primitive: `implies`. This keeps the `published_implies_approved` invariant in Data Health true after a merge as well as after a write
- Layer: unit
- Blocked-by: none

## Group 4: the other primitives

### QC-SYNC-030 A write-once field refuses a second, different value
- Given: `collab.usage_terms_text` already set, and a stale device sending different terms
- When: the merge runs
- Then: the original stands and a `write_once` conflict is recorded. Nothing picks a winner: two people agreed to two different things and a human has to say which observation was wrong
- Layer: unit
- Blocked-by: none

### QC-SYNC-031 A write-once field still accepts its first value
- Given: the same field, null
- When: a patch sets it
- Then: it is set, with no conflict. Write-once is not read-only
- Layer: unit
- Blocked-by: none

### QC-SYNC-032 An identical resend is not a conflict
- Given: the same value sent twice
- When: the merge runs
- Then: no conflict row. A conflict list that fills with echoes is a conflict list nobody reads
- Layer: unit
- Blocked-by: none

### QC-SYNC-033 `derivative_state` never regresses
- Given: a desktop that produced a sheet (`ready`), and a phone still reporting `none`
- When: the phone pushes
- Then: `ready` stands, with an `ordinal` conflict recorded. Every forward step is accepted in a companion case
- Layer: unit
- Blocked-by: none

### QC-SYNC-034 An AI projection is never merged
- Given: two devices disagreeing about `ai_description`
- When: the merge runs
- Then: neither side wins and the base is kept, because the projection is re-derived from the append-only `ai_run` rows. Primitive: `recompute`
- Layer: unit
- Blocked-by: none

### QC-SYNC-035 A soft deleted row cannot be resurrected
- Given: `deleted_at` set, and a patch clearing it
- When: the merge runs
- Then: the deletion stands. Primitive: `sticky`. A device that re-adds a row has lost a deletion; a device that un-deletes one has silently republished it
- Layer: unit
- Blocked-by: none

### QC-SYNC-036 An insert-only row ignores an update
- Given: an `ai_run` row and a patch to its output
- When: the merge runs
- Then: nothing is applied. Primitive: `immutable`. The provenance spine cannot be edited after the fact
- Layer: unit
- Blocked-by: none

### QC-SYNC-037 A client cannot write the pull cursor
- Given: a patch carrying `server_updated_at` and `rev`
- When: the merge runs
- Then: both are ignored. A client that could write the cursor could hide its own rows from every other device with no error anywhere
- Layer: unit
- Blocked-by: none

## Group 5: what must never leave the device

### QC-SYNC-040 A create strips local-only fields from its queued patch
- Given: an asset created with `media_state: bytes_local`
- When: the entry is inspected
- Then: the patch has no `media_state`, and the local row still does. It is a fact about this machine, not about the clip
- Layer: unit
- Blocked-by: none

### QC-SYNC-041 A patch strips them and keeps the rest
- Given: a patch mixing `media_state`, `upload_state`, `upload_offset_bytes`, `local_file_key` and `poster_key`
- When: the entry is inspected
- Then: only `poster_key` and `updated_at` survive
- Layer: unit
- Blocked-by: none

### QC-SYNC-042 A patch of nothing but local state queues nothing
- Given: a patch of only local-only fields
- When: it is written
- Then: the local write happens and no outbox entry appears. Outbox depth is a number a human uses to decide whether it is safe to close the tab
- Layer: unit
- Blocked-by: none

### QC-SYNC-043 A round trip never overwrites the local answer
- Given: device A holds the bytes, device B does not
- When: A pushes and B pulls, then B pushes and A pulls
- Then: neither device's `media_state` is changed by the other's, and the server has no such column at all
- Layer: unit
- Blocked-by: none

## Group 6: the panel, and the honesty rule

### QC-SYNC-050 The panel names the adapter and claims nothing else
- Given: the sync surface
- When: it renders
- Then: it reads `Adapter: loopback`, carries `data-adapter="loopback"`, and no string anywhere on it says connected, live, or Supabase
- Layer: e2e
- Covered by: `e2e/sync.e2e.mjs`. The route is wired, so this is asserted rather than deferred

### QC-SYNC-051 The panel shows the real payloads
- Given: a queue with entries
- When: the panel renders
- Then: each row exposes `data-seq`, `data-store`, `data-op`, `data-state` and the verbatim patch JSON, plus per table pending counts and per table cursors
- Layer: e2e
- Covered by: `e2e/sync.e2e.mjs`

### QC-SYNC-052 A conflict is visible on the surface, not only in the store
- Given: a refused merge
- When: the panel renders
- Then: a conflict row carries `data-policy`, `data-store` and `data-direction`, and states what was kept and what was refused
- Layer: e2e
- Covered by: `e2e/sync.e2e.mjs`
