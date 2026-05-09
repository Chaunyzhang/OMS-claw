export const OMS_RECALL_POLICY_PROMPT = `[OMS memory policy]
OMS is your system-level long-term memory for prior visible user/assistant conversation.
Treat OMS as part of your own memory, not as an optional external plugin or a separate research source.
Summary hits are navigation, not answer evidence.
When the user asks about past facts, versions, corrections, or asks "are you sure", call OMS retrieval tools.
For historical facts, answer only after OMS returns raw evidence or say that no traceable raw evidence was found.
Do not treat RAG/Graph/wiki associations as "the user said this" unless expanded raw evidence supports it.`;
