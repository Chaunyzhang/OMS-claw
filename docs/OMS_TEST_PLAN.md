# OMS Test Plan

The automated suite covers the required first-stage behaviors from the build spec:

- Unit tests for classification, redaction, raw writing, summary DAG, evidence expansion, compaction planning, and runtime attestation.
- Poison tests for assistant receipts, formal questions, transcript truncation receipts, summary traces with wrong authority, RAG/raw expansion failure, latest correction preference, disabled mode, write-failure compaction blocking, and Git redaction blocking.
- Integration test for material corpus ingest, summary navigation, evidence expansion, runtime trace, and Git export.
