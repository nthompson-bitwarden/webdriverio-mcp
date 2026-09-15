import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getState } from '../../src/session/state';
import { mockTool, mockToolDefinition, getMockCallsTool, getMockCallsToolDefinition, manageMockTool, manageMockToolDefinition } from '../../src/tools/mock.tool';

type TestTool = (args: Record<string, unknown>) => ReturnType<typeof mockTool>;
const configure = mockTool as unknown as TestTool;
const inspect = getMockCallsTool as unknown as TestTool;
const manage = manageMockTool as unknown as TestTool;
const target = { mockType: 'electron', apiName: 'dialog', funcName: 'showOpenDialog' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function session(id = 'electron') {
  const mock = {
    mockReturnValue: vi.fn(), mockReturnValueOnce: vi.fn(), mockResolvedValue: vi.fn(),
    mockResolvedValueOnce: vi.fn(), mockRejectedValue: vi.fn(), mockRejectedValueOnce: vi.fn(),
    mockClear: vi.fn(), mockReset: vi.fn(), mockRestore: vi.fn(), update: vi.fn(), mock: { calls: [] as unknown[][] },
  };
  const create = vi.fn().mockResolvedValue(mock);
  const state = getState();
  state.currentSession = id;
  state.browsers.set(id, { electron: { mock: create } } as unknown as WebdriverIO.Browser);
  state.sessionMetadata.set(id, { type: 'browser', runtime: 'electron', capabilities: {}, isAttached: false });
  return { mock, create };
}

beforeEach(() => {
  const state = getState();
  state.browsers.clear(); state.sessionMetadata.clear(); state.sessionHistory.clear(); state.currentSession = null;
});

describe('Electron mocks', () => {
  it.each([
    ['configure', configure, {}],
    ['inspect', inspect, {}],
    ['manage', manage, { action: 'restore' }],
  ] as const)('rejects browser %s without touching Electron mocks in any runtime', async (_name, tool, extra) => {
    const { create, mock } = session();
    await configure(target);
    for (const runtime of ['electron', 'webdriver'] as const) {
      getState().sessionMetadata.get('electron')!.runtime = runtime;
      const result = await tool({ mockType: 'browser', ...extra });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Browser mocking is not implemented yet') }]);
    }
    expect(create).toHaveBeenCalledOnce();
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.mockRestore).not.toHaveBeenCalled();
  });

  it('requires an explicit mockType and a complete Electron target before service calls', async () => {
    const { create } = session();
    for (const args of [
      { apiName: 'app', funcName: 'getName' },
      { ...target, mockType: 'unknown' },
      { mockType: 'electron' },
      { mockType: 'electron', apiName: 'app' },
      { mockType: 'electron', funcName: 'getName' },
    ]) {
      expect((await configure(args)).isError).toBe(true);
      expect((await inspect(args)).isError).toBe(true);
      expect((await manage({ ...args, action: 'restore' })).isError).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
  });

  describe.each([
    ['configure', configure, {}],
    ['inspect', inspect, {}],
    ['manage', manage, { action: 'restore' }],
  ] as const)('%s routing', (_name, tool, extra) => {
    it.each([
      ['webdriver', undefined, 'Browser mocking is not implemented yet'],
      [undefined, undefined, 'Browser mocking is not implemented yet'],
      ['webdriver', 'browser', 'Browser mocking is not implemented yet'],
      [undefined, 'browser', 'Browser mocking is not implemented yet'],
      ['webdriver', 'electron', 'requires an active Electron session'],
      [undefined, 'electron', 'requires an active Electron session'],
      ['electron', undefined, 'mockType is required'],
      ['electron', 'browser', 'Browser mocking is not implemented yet'],
    ] as const)('routes runtime %s and selector %s', async (runtime, mockType, message) => {
      const { create } = session();
      const browserMock = vi.fn();
      getState().browsers.get('electron')!.mock = browserMock;
      getState().sessionMetadata.get('electron')!.runtime = runtime;
      const result = await tool({ ...target, mockType, ...extra });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(message) }]);
      expect(create).not.toHaveBeenCalled();
      expect(browserMock).not.toHaveBeenCalled();
    });

    it.each(['ios', 'android'] as const)('rejects %s for every selector', async type => {
      const { create } = session();
      getState().sessionMetadata.get('electron')!.type = type;
      for (const mockType of [undefined, 'browser', 'electron']) {
        const result = await tool({ ...target, mockType, ...extra });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('unsupported for iOS/Android Appium') }]);
      }
      expect(create).not.toHaveBeenCalled();
    });

    it.each(['session', 'metadata', 'browser'])('rejects missing %s for every selector', async missing => {
      const { create } = session();
      if (missing === 'session') { getState().currentSession = null; }
      if (missing === 'metadata') getState().sessionMetadata.clear();
      if (missing === 'browser') getState().browsers.clear();
      for (const mockType of [undefined, 'browser', 'electron']) {
        const result = await tool({ ...target, mockType, ...extra });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: expect.stringMatching(/session/i) }]);
      }
      expect(create).not.toHaveBeenCalled();
    });
  });

  it.each([mockToolDefinition, getMockCallsToolDefinition, manageMockToolDefinition])('exposes optional mockType for $name', definition => {
    const schema = z.object(definition.inputSchema);
    expect(schema.safeParse({ action: 'restore' }).success).toBe(true);
    expect(schema.safeParse({ mockType: 'browser', action: 'restore' }).success).toBe(true);
    for (const mockType of ['network', 'unknown', null, 1]) {
      expect(schema.safeParse({ mockType, action: 'restore' }).success).toBe(false);
    }
    expect(Object.keys(definition.inputSchema)).not.toContain('kind');
  });

  it('creates one handle and preserves once-value order for overlapping configurations', async () => {
    const { mock, create } = session();
    const creation = deferred<typeof mock>();
    const started = deferred<void>();
    create.mockImplementationOnce(() => { started.resolve(); return creation.promise; });
    const first = configure({ ...target, behavior: 'mockReturnValueOnce', value: 'first' });
    await started.promise;
    const second = configure({ ...target, behavior: 'mockReturnValueOnce', value: 'second' });
    creation.resolve(mock);
    const results = await Promise.all([first, second]);
    expect(results.every(result => !result.isError)).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(mock.mockReturnValueOnce.mock.calls).toEqual([['first'], ['second']]);
  });

  it('allows a queued request to retry failed creation', async () => {
    const { create } = session();
    const creation = deferred<never>();
    const started = deferred<void>();
    create.mockImplementationOnce(() => { started.resolve(); return creation.promise; });
    const first = configure(target);
    await started.promise;
    const second = configure(target);
    creation.reject(new Error('creation failed'));
    expect((await first).isError).toBe(true);
    expect((await second).isError).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('sequences inspection and restoration after configuration, then recreates the handle', async () => {
    const { mock, create } = session();
    const configuration = deferred<void>();
    const started = deferred<void>();
    const events: string[] = [];
    mock.mockReturnValue.mockImplementationOnce(async () => {
      started.resolve();
      await configuration.promise;
      events.push('configured');
    }).mockImplementationOnce(() => { events.push('reconfigured'); });
    mock.update.mockImplementation(() => { events.push('inspected'); });
    mock.mockRestore.mockImplementation(() => { events.push('restored'); });
    const first = configure(target);
    await started.promise;
    const inspection = inspect(target);
    const restoration = manage({ ...target, action: 'restore' });
    const second = configure(target);
    configuration.resolve();
    const results = await Promise.all([first, inspection, restoration, second]);
    expect(results.every(result => !result.isError)).toBe(true);
    expect(events).toEqual(['configured', 'inspected', 'restored', 'reconfigured']);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not block another target or a replacement browser during pending creation', async () => {
    const { mock, create } = session();
    const creation = deferred<typeof mock>();
    const started = deferred<void>();
    create.mockImplementationOnce(() => { started.resolve(); return creation.promise; });
    const pending = configure(target);
    await started.promise;
    expect((await configure({ mockType: 'electron', apiName: 'app', funcName: 'getName' })).isError).toBeUndefined();
    const replacement = session();
    expect((await configure(target)).isError).toBeUndefined();
    creation.resolve(mock);
    expect((await pending).isError).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
    expect(replacement.create).toHaveBeenCalledOnce();
    await inspect(target);
    expect(replacement.mock.update).toHaveBeenCalledOnce();
    expect(mock.update).not.toHaveBeenCalled();
  });

  it.each(['mockReturnValue', 'mockReturnValueOnce', 'mockResolvedValue', 'mockResolvedValueOnce', 'mockRejectedValue', 'mockRejectedValueOnce'])('delegates %s', async behavior => {
    const { mock, create } = session();
    expect((await configure({ ...target, behavior, value: { canceled: true } })).isError).toBeUndefined();
    expect(create).toHaveBeenCalledWith('dialog', 'showOpenDialog');
    expect(mock[behavior as keyof typeof mock]).toHaveBeenCalledWith({ canceled: true });
  });

  it('keeps the handle when queuing subsequent values', async () => {
    const { mock, create } = session();
    await configure({ ...target, value: 'default' });
    await configure({ ...target, behavior: 'mockReturnValueOnce', value: 'first' });
    await configure({ ...target, behavior: 'mockReturnValueOnce', value: 'second' });
    expect(create).toHaveBeenCalledOnce();
    expect(mock.mockReturnValueOnce.mock.calls).toEqual([['first'], ['second']]);
  });

  it('refreshes call history before returning it', async () => {
    const { mock } = session();
    await configure(target);
    mock.update.mockImplementation(async () => { mock.mock.calls = [[{ title: 'Open' }]]; });
    const result = await inspect(target);
    expect(mock.update).toHaveBeenCalledOnce();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ calls: [[{ title: 'Open' }]], callCount: 1 });
  });

  it.each([['clear', 'mockClear'], ['reset', 'mockReset'], ['restore', 'mockRestore']])('delegates %s', async (action, method) => {
    const { mock } = session();
    await configure(target);
    expect((await manage({ ...target, action })).isError).toBeUndefined();
    expect(mock[method as keyof typeof mock]).toHaveBeenCalledOnce();
    expect((await inspect(target)).isError).toBe(action === 'restore' ? true : undefined);
  });

  it('creates a new handle after restoration', async () => {
    const { create } = session();
    await configure(target);
    await manage({ ...target, action: 'restore' });
    await configure(target);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('retains the handle when configuration or restoration fails', async () => {
    const { mock, create } = session();
    mock.mockReturnValue.mockRejectedValueOnce(new Error('configure failed'));
    expect((await configure(target)).isError).toBe(true);
    mock.mockRestore.mockRejectedValueOnce(new Error('restore failed'));
    expect((await manage({ ...target, action: 'restore' })).isError).toBe(true);
    expect((await configure(target)).isError).toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect((await manage({ ...target, action: 'restore' })).isError).toBeUndefined();
  });

  it('does not reuse mocks after session replacement, even with the same session ID', async () => {
    session();
    await configure(target);
    const { create } = session();
    expect((await inspect(target)).isError).toBe(true);
    await configure(target);
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects missing sessions, non-Electron sessions, and unavailable bridges', async () => {
    expect((await configure(target)).isError).toBe(true);
    const { create } = session();
    getState().sessionMetadata.get('electron')!.runtime = 'webdriver';
    expect((await configure(target)).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
    getState().sessionMetadata.get('electron')!.runtime = 'electron';
    getState().browsers.set('electron', {} as unknown as WebdriverIO.Browser);
    expect((await configure(target)).isError).toBe(true);
  });

  it('does not create mocks through inspection or management', async () => {
    const { create } = session();
    expect((await inspect(target)).isError).toBe(true);
    expect((await manage({ ...target, action: 'clear' })).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('reports service creation and refresh failures as tool errors', async () => {
    const { create, mock } = session();
    create.mockRejectedValueOnce(new Error('bridge failed'));
    expect((await configure(target)).isError).toBe(true);
    await configure(target);
    mock.update.mockRejectedValueOnce(new Error('refresh failed'));
    expect((await inspect(target)).isError).toBe(true);
  });

  it('validates the public schema before accepting malformed targets or behavior', () => {
    const schema = z.object(mockToolDefinition.inputSchema);
    expect(schema.safeParse({ ...target, value: null }).success).toBe(true);
    expect(schema.safeParse({ mockType: 'browser' }).success).toBe(true);
    expect(schema.safeParse({ apiName: 'app', funcName: 'getName' }).success).toBe(true);
    expect(schema.safeParse({ ...target, mockType: 'unknown' }).success).toBe(false);
    expect(schema.safeParse({ ...target, behavior: 'mockImplementation' }).success).toBe(false);
    expect(schema.safeParse({ ...target, apiName: '__proto__' }).success).toBe(false);
    expect(schema.safeParse({ ...target, funcName: '' }).success).toBe(false);
  });
});
