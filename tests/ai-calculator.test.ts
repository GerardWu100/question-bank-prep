import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculate } from '../apps/calculator/index.js';
import { SubscriptionProvider } from '../apps/ai-runtime/index.js';
import { buildApp } from '../apps/server/src/app.js';

describe('bounded Python worker', () => {
  it('calculates compound interest, preserves units and resets globals', async () => {
    const first = await calculate({ code: 'result = principal * (1 + rate) ** years', inputs: { principal: 100, rate: 0.05, years: 2 }, units: { result: 'CAD' } });
    expect(first.status).toBe('completed'); expect(first.values.result).toBe(110.25); expect(first.units.result).toBe('CAD');
    expect((await calculate({ code: 'result = principal' })).status).toBe('failed');
  });
  it('terminates loops, recovers, and denies host bridge imports', async () => {
    expect((await calculate({ code: 'while True: pass', timeoutMs: 30 })).error?.code).toBe('timeout');
    expect((await calculate({ code: 'import js\nresult = 1' })).status).toBe('failed');
    expect((await calculate({ code: 'result = 2 + 3' })).values.result).toBe(5);
  });
});

describe('subscription billing policy', () => {
  it('does not use API keys when subscription credentials are absent or expired', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'study-auth-test-'));
    try {
      const provider = new SubscriptionProvider(directory);
      expect((await provider.status()).available).toBe(false);
      await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fake-test-value' }));
      await writeFile(join(directory, 'models_cache.json'), JSON.stringify({ fetched_at: new Date().toISOString(), models: [{ slug: 'gpt-6-luna' }] }));
      expect((await provider.status()).reason).toContain('API keys are never used');
      const events = []; for await (const event of provider.stream({ model: 'gpt-6-luna', prompt: 'hello' })) events.push(event);
      expect(events).toMatchObject([{ type: 'error', code: 'setup_required' }]);
      await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `x.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.x` } }));
      expect((await provider.status()).reason).toContain('expired');
    } finally { await rm(directory, { recursive: true }); }
  });
});

describe('durable tutor runs', () => {
  it('cancels an active stream and saves the partial reply', async () => {
    const provider = { status: async () => ({ available: true, models: [] }), async *stream(request: any) {
      yield { type: 'text', text: 'Started' };
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'error', code: 'cancelled', message: 'Stopped' };
    } };
    const { app } = await buildApp({ provider });
    try {
      const library = (await app.inject({ method: 'POST', url: '/api/libraries', payload: { name: 'Cancel test' } })).json();
      const base = `/api/libraries/${library.id}`;
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      const result = (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Help', operationId: 'cancel-turn', stream: true } })).json();
      expect(result.run.status).toBe('running');
      await app.inject({ method: 'POST', url: `${base}/runs/${result.run.id}/cancel`, payload: {} });
      await new Promise(resolve => setTimeout(resolve, 20));
      const run = (await app.inject(`${base}/runs/${result.run.id}`)).json();
      expect(run.status).toBe('cancelled');
      const saved = (await app.inject(`${base}/chats/${chat.id}`)).json();
      expect(saved.messages[1].content).toBe('Started');
    } finally { await app.close(); }
  });
  it('saves the reasoning summary beside the reply and passes the library thinking level', async () => {
    let effort: string | undefined;
    const provider = { status: async () => ({ available: true, models: [] }), async *stream(request: any) {
      effort = request.effort;
      yield { type: 'thinking', text: 'Discount each dividend.' };
      yield { type: 'text', text: 'Value is $48.87.' };
      yield { type: 'done', model: 'gpt-6.1-sol', provider: 'openai-codex' };
    } };
    const { app } = await buildApp({ provider });
    try {
      const library = (await app.inject({ method: 'POST', url: '/api/libraries', payload: { name: 'Reasoning test' } })).json();
      const base = `/api/libraries/${library.id}`;
      const patched = await app.inject({ method: 'PATCH', url: `${base}/settings`, payload: { operationId: 'effort', expectedVersion: (await app.inject(`${base}/settings`)).json().version, settings: { effort: 'high' } } });
      expect(patched.json()).toMatchObject({ settings: { effort: 'high' } });
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Value?', operationId: 'reasoning-turn', stream: true } });
      await new Promise(resolve => setTimeout(resolve, 50));
      const reply = (await app.inject(`${base}/chats/${chat.id}`)).json().messages[1];
      expect(reply).toMatchObject({ status: 'completed', content: 'Value is $48.87.', reasoning: 'Discount each dividend.' });
      expect(effort).toBe('high');
    } finally { await app.close(); }
  });
  it('retains partial text as interrupted and never invents terminal success', async () => {
    const provider = { status: async () => ({ available: true, models: [] }), async *stream() { yield { type: 'text', text: 'Partial' }; } };
    const { app } = await buildApp({ provider });
    try {
      const library = (await app.inject({ method: 'POST', url: '/api/libraries', payload: { name: 'Test' } })).json();
      const base = `/api/libraries/${library.id}`;
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      const response = (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Help', operationId: 'partial-turn' } })).json();
      expect(response.run.status).toBe('interrupted'); expect(response.chat.messages[1].content).toBe('Partial');
      const replay = (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Help', operationId: 'partial-turn' } })).json();
      expect(replay.chat.messages).toHaveLength(2);
    } finally { await app.close(); }
  });
  it('scopes tool reads and accepts completed streams', async () => {
    let denied = false;
    const provider = { status: async () => ({ available: true, models: [] }), async *stream(request: any) {
      try { await request.executeTool('read_material', { id: 'outside-library' }); } catch { denied = true; }
      yield { type: 'text', text: 'Verified reply' }; yield { type: 'done', model: 'test-only', provider: 'test' };
    } };
    const { app } = await buildApp({ provider });
    try {
      const library = (await app.inject({ method: 'POST', url: '/api/libraries', payload: { name: 'Test' } })).json();
      const base = `/api/libraries/${library.id}`;
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      const result = (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Help', operationId: 'complete-turn' } })).json();
      expect(result.run.status).toBe('completed'); expect(denied).toBe(true);
    } finally { await app.close(); }
  });
  it('opens exact cited revisions and preserves AI authorship after edits', async () => {
    let sourceId = '';
    const provider = { status: async () => ({ available: true, models: [] }), async *stream(request: any) {
      await request.executeTool('read_material', { id: sourceId });
      yield { type: 'text', text: 'A sourced explanation.' }; yield { type: 'done', model: 'test-only', provider: 'test' };
    } };
    const { app, store } = await buildApp({ provider });
    try {
      const library = store.createLibrary('Source test'); const base = `/api/libraries/${library.id}`;
      const note = { id: 'source-note', title: 'Rates', content: 'Original rates', version: 1, hash: 'original' };
      sourceId = note.id; store.put(library.id, 'note', note); store.put(library.id, 'noteRevision', { ...note, noteId: note.id, id: `${note.id}:1` });
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      const response = (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Read it', operationId: 'source-turn' } })).json();
      const message = response.chat.messages[1]; expect(message.sources[0].version).toBe(1);
      store.put(library.id, 'note', { ...note, content: 'Changed', version: 2 });
      const source = (await app.inject(`${base}/chats/${chat.id}/messages/${message.id}/sources/${sourceId}`)).json();
      expect(source.record.content).toBe('Original rates');
      expect((await app.inject(`${base}/chats/${chat.id}/messages/${message.id}/sources/forged`)).statusCode).toBe(404);
      const saved = (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages/${message.id}/save-note`, payload: { operationId: 'save-ai-note' } })).json();
      expect(saved.provenance).toBe('ai'); expect(saved.content).toBe(message.content);
      const edited = (await app.inject({ method: 'PUT', url: `${base}/notes/${saved.id}`, payload: { content: 'Human edit', expectedHash: saved.hash } })).json();
      expect(edited.provenance).toBe('ai'); expect(edited.sourceMessageId).toBe(message.id);
    } finally { await app.close(); }
  });
});
