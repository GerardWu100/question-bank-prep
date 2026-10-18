import { useEffect, useState } from "react";
import { api } from "./api";

/** Common OpenAI-compatible endpoints offered as suggestions for the base URL. */
const ENDPOINT_PRESETS = [
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  {
    label: "Google Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  { label: "Ollama (this computer)", url: "http://localhost:11434/v1" },
];
/** Rows of the endpoint's model list shown at once; the filter narrows the rest. */
const REMOTE_MODEL_ROWS = 60;

/**
 * Settings → AI provider: choose the Codex ChatGPT login or an API key for any
 * OpenAI-compatible endpoint, the key itself (write-only: the server never sends it back)
 * and the model IDs offered in the AI model menu. `onSaved` reloads the model menu.
 */
export function AIProviderSettings({ onSaved }: { onSaved: () => void }) {
  const [saved, setSaved] = useState<any>(null),
    [route, setRoute] = useState("codex"),
    [baseUrl, setBaseUrl] = useState(""),
    [apiKey, setApiKey] = useState(""),
    [models, setModels] = useState(""),
    [remote, setRemote] = useState<any[] | null>(null),
    [filter, setFilter] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const show = (settings: any) => {
    setSaved(settings);
    setRoute(settings.route);
    setBaseUrl(settings.baseUrl);
    setModels(settings.models.join("\n"));
    setApiKey("");
  };
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
  const save = (extra: Record<string, unknown> = {}) =>
    act(async () => {
      show(
        await api(
          "/ai-settings",
          {
            route,
            baseUrl,
            models: models.split(/\s+/).filter(Boolean),
            // An empty box keeps the saved key; "Remove key" sends "".
            ...(apiKey ? { apiKey } : {}),
            ...extra,
          },
          "PUT",
        ),
      );
      setStatus("Saved");
      onSaved();
    });
  const addModel = (id: string) => {
    const list = models.split(/\s+/).filter(Boolean);
    if (!list.includes(id)) setModels([...list, id].join("\n"));
  };
  if (!saved) return status ? <p className="error">{status}</p> : null;
  const shown = (remote ?? []).filter((m) =>
    `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <section className="panel ai-provider">
      <h2>AI provider</h2>
      <fieldset>
        <legend>Send tutor requests through</legend>
        <label className="check">
          <input
            type="radio"
            autoComplete="off"
            name="ai-route"
            checked={route === "codex"}
            onChange={() => setRoute("codex")}
          />
          ChatGPT subscription (Codex login)
        </label>
        <label className="check">
          <input
            type="radio"
            autoComplete="off"
            name="ai-route"
            checked={route === "api-key"}
            onChange={() => setRoute("api-key")}
          />
          API key (OpenRouter, OpenAI or any OpenAI-compatible endpoint)
        </label>
      </fieldset>
      {route === "api-key" && (
        <>
          <label>
            Base URL
            <input
              list="ai-endpoint-presets"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <datalist id="ai-endpoint-presets">
              {ENDPOINT_PRESETS.map((preset) => (
                <option key={preset.url} value={preset.url}>
                  {preset.label}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={
                saved.apiKeySaved
                  ? `Saved key ending …${saved.apiKeyEnding}; type to replace`
                  : "Paste your key"
              }
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <label>
            Models (one ID per line)
            <textarea
              rows={4}
              value={models}
              placeholder="openrouter/free"
              onChange={(e) => setModels(e.target.value)}
            />
          </label>
        </>
      )}
      <div className="chips">
        <button disabled={busy} onClick={() => void save()}>
          Save
        </button>
        {route === "api-key" && (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setRemote((await api("/ai-settings/remote-models")).models);
                })
              }
            >
              Browse the endpoint's models
            </button>
            {saved.apiKeySaved && (
              <button
                className="quiet"
                disabled={busy}
                onClick={() => void save({ apiKey: "" })}
              >
                Remove key
              </button>
            )}
          </>
        )}
        {status && <span className="muted">{status}</span>}
      </div>
      {route === "api-key" && remote && (
        <div className="remote-models">
          <input
            aria-label="Filter models"
            placeholder={`Filter ${remote.length} models (try "free")`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="chips">
            {shown.slice(0, REMOTE_MODEL_ROWS).map((m) => (
              <button
                key={m.id}
                className="secondary"
                title={m.name}
                onClick={() => addModel(m.id)}
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
    </section>
  );
}
