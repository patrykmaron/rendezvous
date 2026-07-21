// Single source of truth for the agent model id. This model family is served
// ONLY by the OpenAI Responses API (`openai.responses.create`) — Chat
// Completions is legacy and unsupported for it. Keep this as the one constant
// so a model bump is a one-line change.
export const AGENT_MODEL = "gpt-5.6-terra"
