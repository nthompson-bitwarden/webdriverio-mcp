import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition } from '../types/tool';
import { z } from 'zod';
import { getBrowser, getState } from '../session/state';

const targetSchema = {
  apiName: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).describe('Electron API module, such as dialog, app, or clipboard.'),
  funcName: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).describe('API function, such as showOpenDialog or getName.'),
};
const behaviorSchema = z.enum(['mockReturnValue', 'mockReturnValueOnce', 'mockResolvedValue', 'mockResolvedValueOnce', 'mockRejectedValue', 'mockRejectedValueOnce']);
const actionSchema = z.enum(['clear', 'reset', 'restore']);
type Target = { apiName: string; funcName: string };
type MockArgs = Target & { behavior?: z.infer<typeof behaviorSchema>; value?: unknown };
type ManageArgs = Target & { action: z.infer<typeof actionSchema> };
type ElectronMock = Record<z.infer<typeof behaviorSchema>, (value: unknown) => Promise<unknown>> & {
  update(): Promise<unknown>;
  mock: { calls: unknown[][] };
  mockClear(): Promise<unknown>;
  mockReset(): Promise<unknown>;
  mockRestore(): Promise<unknown>;
};
// Browser ownership keeps handles isolated and lets teardown release them without another cleanup hook.
const sessionMocks = new WeakMap<WebdriverIO.Browser, Map<string, ElectronMock>>();
const keyFor = ({ apiName, funcName }: Target) => JSON.stringify([apiName, funcName]);

function context(target: Target) {
  z.object(targetSchema).parse(target);
  const state = getState();
  if (!state.currentSession || state.sessionMetadata.get(state.currentSession)?.runtime !== 'electron') {
    throw new Error('no active Electron session.');
  }
  const browser = getBrowser();
  const electron = (browser as WebdriverIO.Browser & { electron?: { mock(apiName: string, funcName: string): Promise<ElectronMock> } }).electron;
  if (!electron?.mock) throw new Error('Electron mocking support is unavailable for this session.');
  let mocks = sessionMocks.get(browser);
  if (!mocks) { mocks = new Map(); sessionMocks.set(browser, mocks); }
  return { electron, mocks, key: keyFor(target) };
}

function errorResult(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: `Error with Electron mock: ${error instanceof Error ? error.message : String(error)}` }] };
}

export const mockElectronApiToolDefinition: ToolDefinition = {
  name: 'mock_electron_api',
  description: 'Mock an Electron main-process API function. Repeated calls configure the same mock without clearing history or queued once values. Use resolved/rejected behaviors for async APIs. Mocks belong to the active Electron session.',
  annotations: { title: 'Mock Electron API', destructiveHint: true },
  inputSchema: { ...targetSchema, behavior: behaviorSchema.optional().describe('Default: mockReturnValue. Once behaviors queue a value for the next call.'), value: z.json().optional().describe('JSON value to return, resolve, or reject with. Omit for undefined.') },
};
export const mockElectronApiTool: ToolCallback = async (args: MockArgs) => {
  try {
    const behavior = behaviorSchema.parse(args.behavior ?? 'mockReturnValue');
    const { electron, mocks, key } = context(args);
    let mock = mocks.get(key);
    if (!mock) {
      mock = await electron.mock(args.apiName, args.funcName);
      // Retain immediately so a failed configuration can still be restored or retried.
      mocks.set(key, mock);
    }
    await mock[behavior](args.value);
    return { content: [{ type: 'text', text: `Electron mock configured: ${args.apiName}.${args.funcName} (${behavior})` }] };
  } catch (error) { return errorResult(error); }
};

export const getElectronMockCallsToolDefinition: ToolDefinition = {
  name: 'get_electron_mock_calls',
  description: 'Read current call arguments for a function created by mock_electron_api in the active Electron session.',
  annotations: { title: 'Get Electron Mock Calls', readOnlyHint: true },
  inputSchema: targetSchema,
};
export const getElectronMockCallsTool: ToolCallback = async (args: Target) => {
  try {
    const { mocks, key } = context(args);
    const mock = mocks.get(key);
    if (!mock) throw new Error('mock not found; call mock_electron_api first.');
    await mock.update();
    return { content: [{ type: 'text', text: JSON.stringify({ calls: mock.mock.calls, callCount: mock.mock.calls.length }) }] };
  } catch (error) { return errorResult(error); }
};

export const manageElectronMockToolDefinition: ToolDefinition = {
  name: 'manage_electron_mock',
  description: 'Manage a function created by mock_electron_api: clear removes call history, reset also removes configured behavior and queued values, restore reinstates the original function and releases the mock.',
  annotations: { title: 'Manage Electron Mock', destructiveHint: true },
  inputSchema: { ...targetSchema, action: actionSchema },
};
export const manageElectronMockTool: ToolCallback = async (args: ManageArgs) => {
  try {
    const action = actionSchema.parse(args.action);
    const { mocks, key } = context(args);
    const mock = mocks.get(key);
    if (!mock) throw new Error('mock not found; call mock_electron_api first.');
    const method = { clear: 'mockClear', reset: 'mockReset', restore: 'mockRestore' } as const;
    await mock[method[action]]();
    if (action === 'restore') mocks.delete(key);
    return { content: [{ type: 'text', text: `Electron mock ${action} completed: ${args.apiName}.${args.funcName}` }] };
  } catch (error) { return errorResult(error); }
};
