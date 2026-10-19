import { useEffect, useState } from "react";
import { api } from "./api";

/** Common endpoints offered as suggestions for an API connection's base URL. */
const ENDPOINT_PRESETS = [
  { label: "Anthropic", url: "https://api.anthropic.com" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  {
    label: "Google Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  { label: "Ollama (this computer)", url: "http://localhost:11434/v1" },
];
const DEFAULT_API_BASE_URL = "https://openrouter.ai/api/v1";
/** Rows of the endpoint's model list shown at once; the filter narrows the rest. */
const REMOTE_MODEL_ROWS = 60;

/**
 * One connection as edited here. `apiKey` is what the user typed: empty keeps the saved
 * key, and `removeKey` sends "" to delete it. `saved` marks a connection the server knows.
 */
interface Draft {
  id: string;
  kind: "codex" | "api";
  baseUrl: string;
  models: string;
  apiKey: string;
  removeKey: boolean;
  apiKeySaved: boolean;
  apiKeyEnding: string;
  saved: boolean;
}

const toDraft = (connection: any): Draft => ({
  ...connection,
  models: connection.models.join("\n"),
  apiKey: "",
  removeKey: false,
  saved: true,
});
const modelList = (models: string) => models.split(/\s+/).filter(Boolean);
const titleOf = (draft: Draft) => {
  if (draft.kind === "codex") return "ChatGPT subscription";
  try {
    return `API key · ${new URL(draft.baseUrl).host}`;
  } catch {
    return "API key";
  }
};

/**
 * Settings → AI provider: the AI connections, tried top to bottom. Each is the ChatGPT
 * subscription or an API key (Anthropic, OpenAI or any OpenAI-compatible endpoint) with
 * the model IDs it offers. Keys are write-only: the server never sends them back.
 * `onSaved` reloads the model menu.
 */
export function AIProviderSettings({ onSaved }: { onSaved: () => void }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null),
    [remote, setRemote] = useState<{ id: string; models: any[] } | null>(null),
    [filter, setFilter] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const show = (settings: any) => setDrafts(settings.connections.map(toDraft));
  useEffect(() => {
    void api("/ai-settings").then(show, (e) => setStatus(e.message));
  }, []);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus("");
    try {
      await action();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      show(
        await api(
          "/ai-settings",
          {
            connections: drafts!.map((draft) => ({
              id: draft.id,
              kind: draft.kind,
              baseUrl: draft.baseUrl,
              models: modelList(draft.models),
              // An empty box keeps the saved key; "Remove key" sends "".
              ...(draft.removeKey
                ? { apiKey: "" }
                : draft.apiKey
                  ? { apiKey: draft.apiKey }
                  : {}),
            })),
          },
          "PUT",
        ),
      );
      setStatus("Saved");
      onSaved();
    });
  if (!drafts) return status ? <p className="error">{status}</p> : null;
  const edit = (index: number, change: Partial<Draft>) =>
    setDrafts(drafts.map((d, i) => (i === index ? { ...d, ...change } : d)));
  const move = (index: number, step: number) => {
    const next = [...drafts];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setDrafts(next);
  };
  const add = (kind: Draft["kind"]) =>
    setDrafts([
      ...drafts,
      {
        id: crypto.randomUUID(),
        kind,
        baseUrl: kind === "api" ? DEFAULT_API_BASE_URL : "",
        models: "",
        apiKey: "",
        removeKey: false,
        apiKeySaved: false,
        apiKeyEnding: "",
        saved: false,
      },
    ]);
  const addModel = (index: number, id: string) => {
    const list = modelList(drafts[index].models);
    if (!list.includes(id)) edit(index, { models: [...list, id].join("\n") });
  };
  const browsing = remote && drafts.findIndex((d) => d.id === remote.id);
  const shown = (remote?.models ?? []).filter((m) =>
    `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <section className="panel ai-provider">
      <h2>AI provider</h2>
      <p className="muted">
        Tried top to bottom: when one fails before answering, the next one
        answers.
      </p>
      {drafts.map((draft, index) => (
        <fieldset key={draft.id}>
          <legend>
            {index + 1}. {titleOf(draft)}
          </legend>
          {draft.kind === "api" && (
            <>
              <label>
                Base URL
                <input
                  list="ai-endpoint-presets"
                  value={draft.baseUrl}
                  onChange={(e) => edit(index, { baseUrl: e.target.value })}
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  autoComplete="off"
                  value={draft.apiKey}
                  placeholder={
                    draft.apiKeySaved && !draft.removeKey
                      ? `Saved key ending …${draft.apiKeyEnding}; type to replace`
                      : "Paste your key"
                  }
                  onChange={(e) =>
                    edit(index, { apiKey: e.target.value, removeKey: false })
                  }
                />
              </label>
            </>
          )}
          <label>
            Models (one ID per line, first = backup model)
            <textarea
              rows={3}
              value={draft.models}
              placeholder={
                draft.kind === "codex"
                  ? "gpt-6.1-sol"
                  : "claude-sonnet-5-5 or openrouter/free"
              }
              onChange={(e) => edit(index, { models: e.target.value })}
            />
          </label>
          <div className="chips">
            <button
              className="quiet"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              ↑ Up
            </button>
            <button
              className="quiet"
              disabled={busy || index === drafts.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓ Down
            </button>
            {draft.kind === "api" && draft.saved && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setFilter("");
                    setRemote({
                      id: draft.id,
                      models: (
                        await api(
                          `/ai-settings/remote-models?connection=${encodeURIComponent(draft.id)}`,
                        )
                      ).models,
                    });
                  })
                }
              >
                Browse the endpoint's models
              </button>
            )}
            {draft.kind === "api" && draft.apiKeySaved && !draft.removeKey && (
              <button
                className="quiet"
                disabled={busy}
                onClick={() => edit(index, { removeKey: true, apiKey: "" })}
              >
                Remove key
              </button>
            )}
            <button
              className="quiet"
              disabled={busy}
              onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}
            >
              Remove connection
            </button>
          </div>
          {remote && browsing === index && (
            <div className="remote-models">
              <input
                aria-label="Filter models"
                placeholder={`Filter ${remote.models.length} models (try "free")`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="chips">
                {shown.slice(0, REMOTE_MODEL_ROWS).map((m) => (
                  <button
                    key={m.id}
                    className="secondary"
                    title={m.name}
                    onClick={() => addModel(index, m.id)}
                  >
                    + {m.id}
                    {m.tools === false ? " · no tools" : ""}
                  </button>
                ))}
              </div>
              {shown.length > REMOTE_MODEL_ROWS && (
                <p className="muted">
                  {shown.length - REMOTE_MODEL_ROWS} more; narrow the filter.
                </p>
              )}
            </div>
          )}
        </fieldset>
      ))}
      <datalist id="ai-endpoint-presets">
        {ENDPOINT_PRESETS.map((preset) => (
          <option key={preset.url} value={preset.url}>
            {preset.label}
          </option>
        ))}
      </datalist>
      <div className="chips">
        <button className="secondary" disabled={busy} onClick={() => add("api")}>
          + API key
        </button>
        {!drafts.some((d) => d.kind === "codex") && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => add("codex")}
          >
            + ChatGPT subscription
          </button>
        )}
        <button disabled={busy} onClick={() => void save()}>
          Save
        </button>
        {status && <span className="muted">{status}</span>}
      </div>
    </section>
  );
}
