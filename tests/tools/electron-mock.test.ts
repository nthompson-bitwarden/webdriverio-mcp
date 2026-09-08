import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getState } from '../../src/session/state';
import { mockElectronApiTool, mockElectronApiToolDefinition, getElectronMockCallsTool, manageElectronMockTool } from '../../src/tools/electron-mock.tool';

type TestTool = (args: Record<string, unknown>) => ReturnType<typeof mockElectronApiTool>;
const configure = mockElectronApiTool as unknown as TestTool;
const inspect = getElectronMockCallsTool as unknown as TestTool;
const manage = manageElectronMockTool as unknown as TestTool;
const target = { apiName: 'dialog', funcName: 'showOpenDialog' };
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
    const schema = z.object(mockElectronApiToolDefinition.inputSchema);
    expect(schema.safeParse({ ...target, value: null }).success).toBe(true);
    expect(schema.safeParse({ ...target, behavior: 'mockImplementation' }).success).toBe(false);
    expect(schema.safeParse({ ...target, apiName: '__proto__' }).success).toBe(false);
    expect(schema.safeParse({ ...target, funcName: '' }).success).toBe(false);
  });
});
