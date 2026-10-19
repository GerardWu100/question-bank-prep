import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculate } from '../apps/calculator/index.js';
import { SubscriptionProvider } from '../apps/ai-runtime/index.js';
import { ModelUsageLimit } from '../apps/ai-runtime/usage-limit.js';
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

describe('ChatGPT subscription sign-in', () => {
  const token = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')}.x`;
  it('never reads a Codex API key and refuses an expired borrowed (Codex CLI) login', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'study-auth-test-'));
    try {
      const authFile = join(directory, 'auth.json');
      const provider = new SubscriptionProvider(authFile);
      expect((await provider.status()).available).toBe(false);
      await writeFile(authFile, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fake-test-value' }));
      expect((await provider.status()).reason).toContain('No ChatGPT sign-in');
      const events = []; for await (const event of provider.stream({ model: 'gpt-6-luna', prompt: 'hello' })) events.push(event);
      expect(events).toMatchObject([{ type: 'error', code: 'setup_required' }]);
      await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token(1), refresh_token: 'r' } }));
      expect((await provider.status()).reason).toContain('expired');
    } finally { await rm(directory, { recursive: true }); }
  });
  it('offers the listed models the pinned catalog knows, with their thinking levels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'study-auth-test-'));
    try {
      const authFile = join(directory, 'auth.json');
      // App-owned (codex-auth-maker) and still valid: usable without any network call.
      await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', refresh_owner: 'pi-ai', tokens: { access_token: token(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'r' } }));
      const status = await new SubscriptionProvider(authFile, undefined, () => ['gpt-6.1-sol', 'no-such-model']).status();
      expect(status.available).toBe(true);
      expect(status.models).toMatchObject([{ id: 'gpt-6.1-sol', enabled: true, defaultEffort: 'medium' }, { id: 'no-such-model', enabled: false }]);
      expect(status.models[0].efforts).toContain('high');
    } finally { await rm(directory, { recursive: true }); }
  });
});

describe('project-wide model usage limit', () => {
  it('blocks past the hourly and daily caps and keeps the count across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'study-usage-test-'));
    try {
      const stateFile = join(directory, 'ai-usage.json');
      const start = Date.parse('2026-10-18T12:00:00Z');
      const limit = new ModelUsageLimit({ perHour: 2, perDay: 3 }, stateFile);
      expect(limit.take(start).allowed).toBe(true);
      expect(limit.take(start + 1000).allowed).toBe(true);
      expect(limit.take(start + 2000)).toMatchObject({ allowed: false, window: 'hour', retryAt: new Date(start + 3_600_000) });
      const restarted = new ModelUsageLimit({ perHour: 2, perDay: 3 }, stateFile);
      expect(restarted.take(start + 3_600_001).allowed).toBe(true);
      expect(restarted.take(start + 7_300_000)).toMatchObject({ allowed: false, window: 'day', retryAt: new Date(start + 86_400_000) });
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
  it('deletes a chat while its reply streams, and unlinks the saved note of a deleted chat', async () => {
    const provider = { status: async () => ({ available: true, models: [] }), async *stream(request: any) {
      yield { type: 'text', text: 'Started' };
      if (request.prompt === 'Wait') await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'done', model: 'm', provider: 'p' };
    } };
    const { app } = await buildApp({ provider });
    try {
      const library = (await app.inject({ method: 'POST', url: '/api/libraries', payload: { name: 'Delete test' } })).json();
      const base = `/api/libraries/${library.id}`;
      const saved = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      const done = (await app.inject({ method: 'POST', url: `${base}/chats/${saved.id}/messages`, payload: { text: 'Hi', operationId: 'delete-1' } })).json();
      const note = (await app.inject({ method: 'POST', url: `${base}/chats/${saved.id}/messages/${done.chat.messages[1].id}/save-note`, payload: { operationId: 'delete-note' } })).json();
      const streaming = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      await app.inject({ method: 'POST', url: `${base}/chats/${streaming.id}/messages`, payload: { text: 'Wait', operationId: 'delete-2', stream: true } });
      expect((await app.inject({ method: 'DELETE', url: `${base}/chats/${streaming.id}`, payload: {} })).json()).toEqual({ deleted: 1 });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect((await app.inject(`${base}/chats/${streaming.id}`)).statusCode).toBe(404);
      expect((await app.inject(`${base}/chats`)).json().chats.map((c: any) => c.id)).toEqual([saved.id]);
      expect((await app.inject({ method: 'DELETE', url: `${base}/chats/${saved.id}`, payload: {} })).json()).toEqual({ deleted: 1 });
      expect((await app.inject(`${base}/chats`)).json().chats).toEqual([]);
      const notes = (await app.inject(`${base}/notes`)).json().notes;
      expect(notes.find((n: any) => n.id === note.id)).toMatchObject({ content: 'Started', chatId: null });
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
  it('gives the tutor your answer and result after you answer, and withholds them in hint mode', async () => {
    const prompts: string[] = [];
    const provider = { status: async () => ({ available: true, models: [] }), async *stream(request: any) {
      prompts.push(request.systemPrompt);
      yield { type: 'text', text: 'ok' };
      yield { type: 'done', model: 'gpt-6.1-sol', provider: 'openai-codex' };
    } };
    const { app, store } = await buildApp({ provider });
    try {
      const library = store.createLibrary('Context test');
      const preview = store.preview(library.id, [{ path: 'bank.md', content: '## Question 1\nTwo plus two?\n### Choices\nA. 3\nB. 4\nC. 5\n### Answer\nB\n' }]);
      store.commit(library.id, preview.id, true);
      const question = store.list(library.id, 'question')[0];
      const base = `/api/libraries/${library.id}`;
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: { questionId: question.id } })).json();
      const send = async (operationId: string) => {
        await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Help', operationId, stream: true } });
        await new Promise(resolve => setTimeout(resolve, 30));
      };
      await send('before-answer');
      store.answer(library.id, question.id, { operationId: 'answer', expectedVersion: 0, selection: 'A' });
      await send('after-answer');
      expect(prompts[0]).toContain('Hint mode');
      expect(prompts[0]).not.toContain('"yourAnswer"');
      expect(prompts[1]).toContain('"yourAnswer":"A"');
      expect(prompts[1]).toContain('"yourResult":"wrong"');
    } finally { await app.close(); }
  });
  it('gives the study review your mistakes, your tutor questions and your notes, with one notes-search tool', async () => {
    const seen: Record<string, any> = {};
    let toolNames: string[] = [];
    const provider = { status: async () => ({ available: true, models: [] }), async *stream(request: any) {
      toolNames = request.tools.map((tool: any) => tool.name);
      for (const name of ['get_my_mistakes', 'get_my_questions', 'get_my_notes']) seen[name] = await request.executeTool(name, {});
      yield { type: 'text', text: 'plan' };
      yield { type: 'done', model: 'gpt-6.1-sol', provider: 'openai-codex' };
    } };
    const { app, store } = await buildApp({ provider, readingRoot: tmpdir() });
    try {
      const library = store.createLibrary('Review test');
      const preview = store.preview(library.id, [{ path: '01-quantitative-methods/bank.md', content: '# Chapter LM01 Basics\n## Question 1\nTwo plus two?\n### Choices\nA. 3\nB. 4\nC. 5\n### Answer\nB\n' }]);
      store.commit(library.id, preview.id, true);
      const question = store.list(library.id, 'question')[0];
      store.answer(library.id, question.id, { operationId: 'wrong', expectedVersion: 0, selection: 'A' });
      store.saveNote(library.id, { id: 'n1', title: 'Regression', content: 'Check the t-stat.', provenance: 'human-saved', version: 1 });
      const base = `/api/libraries/${library.id}`;
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text: 'Why is homoskedasticity needed?', operationId: 'review-turn', stream: true } });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(seen.get_my_mistakes).toMatchObject({ byChapter: [{ chapter: 'Chapter LM01 Basics', answered: 1, wrong: 1, unsure: 0 }], mistakes: [{ result: 'wrong', yourAnswer: 'A', answerKey: 'B' }] });
      expect(seen.get_my_questions).toEqual([{ chat: 'Ask AI', text: 'Why is homoskedasticity needed?' }]);
      expect(seen.get_my_notes).toEqual([{ title: 'Regression', origin: 'your note', text: 'Check the t-stat.' }]);
      expect(toolNames.filter(name => name === 'rg' || name === 'search_study_notes')).toHaveLength(1);
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
