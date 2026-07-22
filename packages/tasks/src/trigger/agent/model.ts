// Single source of truth for the agent model id. This model family is served
// ONLY by the OpenAI Responses API (`openai.responses.create`) — Chat
// Completions is legacy and unsupported for it. Keep this as the one constant
// so a model bump is a one-line change.
export const AGENT_MODEL = "gpt-5.6-terra"

// Cheap-path model for the per-message constraint extractor (extract-constraints
// task, ADR 0019). Aliased to AGENT_MODEL today but kept as its own constant so
// the high-volume extractor can later be pointed at a cheaper/faster model
// without touching the planning agent.
export const EXTRACTOR_MODEL = AGENT_MODEL
