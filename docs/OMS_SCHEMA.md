# OMS Schema

Schema version: `v1`.

The SQLite schema contains:

- `agents`, `body_bindings`, `sessions`, `turns`
- `raw_messages` plus contentless `raw_messages_fts`
- `message_events`
- `summaries`, `source_edges`
- `retrieval_runs`, `retrieval_candidates`, `evidence_packets`

The migration SQL files live under `src/storage/migrations`. The runtime also embeds the same migrations in `SQLiteConnection` so a compiled package can initialize a database without relying on copied SQL files.
