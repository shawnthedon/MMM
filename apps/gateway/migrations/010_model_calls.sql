-- MMM gateway — 010: model calls are metered, and a key is a sealed value
--
-- `providers` has existed since 001 with `spend_mtd` and `key_sealed` columns that nothing ever wrote.
-- The Models screen described a gateway on top of them. This migration makes the table able to hold the
-- truth: which provider is actually configured, under which fingerprint, and what was called when.
--
-- Nothing here invents historical spend. `spend_mtd` is dropped at the end of this file: the only real
-- number is a SUM over `model_calls`, which starts empty — an app that has made no call has spent
-- nothing, and the screen says so.

ALTER TABLE providers ADD COLUMN key_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN key_hint TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN default_model TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN configured_at INTEGER;
ALTER TABLE providers ADD COLUMN configured_by TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- One row per attempt. `status` distinguishes a call that happened from one that was refused before it
-- could happen — a budget refusal is not spend, and must never be summed as if it were.
CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  principal_id TEXT NOT NULL DEFAULT '',
  via TEXT NOT NULL DEFAULT 'api',
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',            -- ok | blocked | error
  error_code TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_estimated INTEGER NOT NULL DEFAULT 1,    -- cost comes from a price table, not an invoice
  latency_ms INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL DEFAULT '',
  reply_chars INTEGER NOT NULL DEFAULT 0         -- length only: the prompt and the reply are not stored
);
CREATE INDEX IF NOT EXISTS idx_model_calls_ts ON model_calls(ts DESC);
CREATE INDEX IF NOT EXISTS idx_model_calls_provider ON model_calls(provider_id, ts DESC);

-- Budget defaults are written once and edited by the Owner; absent rows mean "use the defaults in code".
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('models.budget', '{"dailyUsd":5,"perCallUsd":0.5,"enforced":true}');
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('models.defaultProvider', '');

-- ---------------------------------------------------------------------------------------------
-- The catalogue itself
--
-- A gateway with no provider rows cannot be configured: the Models screen would be empty and every
-- route below 404s. So the shipped catalogue is written here, once — but only as *names to configure*.
-- No row claims to be on (`status` is derived from whether a sealed key exists), no row carries money
-- (`spend_mtd` is dropped below, and spend is a SUM over `model_calls`), and the model lists are the
-- shipped *suggestions*: the adapter does not restrict calls to them, because a stale list is not
-- evidence about what a provider serves. If a demo seed runs later it replaces these ids with its own.
-- ---------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO providers (id, category, name, status, auth, models, latency, endpoint)
VALUES
  ('pv-openai', 'Frontier Cloud', 'OpenAI', 'off', 'API key', '["GPT-5","o3"]', 0, ''),
  ('pv-anthropic', 'Frontier Cloud', 'Anthropic', 'off', 'API key', '["Claude Opus 4","Claude Sonnet 4"]', 0, ''),
  ('pv-google', 'Frontier Cloud', 'Google', 'off', 'API key', '["Gemini 3 Pro"]', 0, ''),
  ('pv-xai', 'Frontier Cloud', 'xAI', 'off', 'API key', '["Grok 3"]', 0, ''),
  ('pv-openrouter', 'Mid-Tier Cloud', 'OpenRouter', 'off', 'API key', '["auto","many"]', 0, ''),
  ('pv-together', 'Mid-Tier Cloud', 'Together AI', 'off', 'API key', '["Qwen2.5-72B"]', 0, ''),
  ('pv-mistral', 'Mid-Tier Cloud', 'Mistral', 'off', 'API key', '["Large","Codestral"]', 0, ''),
  ('pv-cohere', 'Mid-Tier Cloud', 'Cohere', 'off', 'API key', '["Command R+"]', 0, ''),
  ('pv-ai21', 'Mid-Tier Cloud', 'AI21', 'off', 'API key', '["Jamba"]', 0, ''),
  ('pv-zhipu', 'Mid-Tier Cloud', 'Zhipu GLM', 'off', 'API key', '["GLM-4 Plus"]', 0, ''),
  ('pv-ollama', 'Local/Self-Hosted', 'Ollama', 'off', 'local URL', '["qwen2.5:32b","llama3.3"]', 0, ''),
  ('pv-lmstudio', 'Local/Self-Hosted', 'LM Studio', 'off', 'local URL', '["any GGUF"]', 0, ''),
  ('pv-llamacpp', 'Local/Self-Hosted', 'llama.cpp', 'off', 'local URL', '["any GGUF"]', 0, ''),
  ('pv-vllm', 'Local/Self-Hosted', 'vLLM', 'off', 'local URL', '["qwen2.5-72b"]', 0, ''),
  ('pv-localai', 'Local/Self-Hosted', 'LocalAI', 'off', 'local URL', '["any"]', 0, ''),
  ('pv-tabby', 'Local/Self-Hosted', 'TabbyAPI', 'off', 'local URL', '["exl2 models"]', 0, ''),
  ('pv-deepseek', 'Specialized', 'DeepSeek', 'off', 'API key', '["DeepSeek-V3","R1"]', 0, ''),
  ('pv-qwen', 'Specialized', 'Qwen', 'off', 'API key', '["Qwen-Max"]', 0, ''),
  ('pv-minimax', 'Specialized', 'MiniMax', 'off', 'API key', '["MiniMax-01"]', 0, ''),
  ('pv-moonshot', 'Specialized', 'Moonshot AI', 'off', 'API key', '["Kimi K2"]', 0, ''),
  ('pv-perplexity', 'Specialized', 'Perplexity', 'off', 'API key', '["Sonar"]', 0, ''),
  ('pv-groq', 'Specialized', 'Groq', 'off', 'API key', '["Llama-3.3-70B"]', 0, ''),
  ('pv-azure', 'Enterprise', 'Azure OpenAI', 'off', 'Entra', '["GPT-5"]', 0, ''),
  ('pv-bedrock', 'Enterprise', 'AWS Bedrock', 'off', 'IAM', '["Claude","Nova"]', 0, ''),
  ('pv-vertex', 'Enterprise', 'GCP Vertex AI', 'off', 'Service acct', '["Gemini 3"]', 0, ''),
  ('pv-watsonx', 'Enterprise', 'IBM watsonx', 'off', 'API key', '["Granite"]', 0, '');

-- `spend_mtd` was a fixture column on a table nothing ever wrote to: a number that could only be a
-- lie. It is dropped rather than zeroed, so no future query can read spend from anywhere but the
-- ledger.
ALTER TABLE providers DROP COLUMN spend_mtd;
