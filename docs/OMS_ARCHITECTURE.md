# OMS Architecture

OMS is an OpenClaw native plugin with two registered surfaces:

- Context engine id `oms`, responsible for ingest, safe assembly, compaction checks, and lifecycle hooks.
- Memory/tool capability `oms`, responsible for explicit tools such as `oms_summary_search`, `oms_expand_evidence`, `oms_fts_search`, `oms_trace`, and `oms_git_export`.

The design follows the project rule: summary is navigation, raw is truth. Raw visible user/assistant transcript is written first, derived artifacts point back through `source_edges`, and high-confidence retrieval answers only from authoritative raw evidence packets.
