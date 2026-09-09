import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition } from '../types/tool';
import { z } from 'zod';
import { getBrowser, getState } from '../session/state';

const electronTargetSchema = {
  apiName: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).describe('Electron API module, such as dialog, app, or clipboard.'),
  funcName: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).describe('API function, such as showOpenDialog or getName.'),
};
const kindSchema = z.enum(['electron', 'network']);
const targetSchema = {
  kind: kindSchema.describe('Mock kind. Electron API function mocks are supported; network mocks are not implemented yet.'),
  apiName: electronTargetSchema.apiName.optional().describe('Required for kind electron: API module, such as dialog, app, or clipboard.'),
  funcName: electronTargetSchema.funcName.optional().describe('Required for kind electron: API function, such as showOpenDialog or getName.'),
};
const behaviorSchema = z.enum(['mockReturnValue', 'mockReturnValueOnce', 'mockResolvedValue', 'mockResolvedValueOnce', 'mockRejectedValue', 'mockRejectedValueOnce']);
const actionSchema = z.enum(['clear', 'reset', 'restore']);
type Target = { kind: z.infer<typeof kindSchema>; apiName?: string; funcName?: string };
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
const sessionOperations = new WeakMap<WebdriverIO.Browser, Map<string, Promise<void>>>();
const keyFor = ({ apiName, funcName }: { apiName: string; funcName: string }) => JSON.stringify([apiName, funcName]);

function context(target: Target) {
  kindSchema.parse(target.kind);
  if (target.kind === 'network') throw new Error('Network mocking is not implemented yet. Only kind "electron" is currently supported.');
  const electronTarget = z.object(electronTargetSchema).parse(target);
  const state = getState();
  if (!state.currentSession || state.sessionMetadata.get(state.currentSession)?.runtime !== 'electron') {
    throw new Error('no active Electron session.');
  }
  const browser = getBrowser();
  const electron = (browser as WebdriverIO.Browser & { electron?: { mock(apiName: string, funcName: string): Promise<ElectronMock> } }).electron;
  if (!electron?.mock) throw new Error('Electron mocking support is unavailable for this session.');
  let mocks = sessionMocks.get(browser);
  if (!mocks) { mocks = new Map(); sessionMocks.set(browser, mocks); }
  return { browser, electron, mocks, target: electronTarget, key: keyFor(electronTarget) };
}

function withTarget<T>(target: Target, operation: (ctx: ReturnType<typeof context>) => Promise<T>): Promise<T> {
  const ctx = context(target);
  let operations = sessionOperations.get(ctx.browser);
  if (!operations) { operations = new Map(); sessionOperations.set(ctx.browser, operations); }
  // Capture the browser now and serialize the entire operation, including restore and inspection.
  const result = (operations.get(ctx.key) ?? Promise.resolve()).then(() => operation(ctx));
  const cleanup = () => {
    if (operations.get(ctx.key) === tail) operations.delete(ctx.key);
  };
  // A failed operation must not prevent later retries from running.
  const tail = result.then(cleanup, cleanup);
  operations.set(ctx.key, tail);
  return result;
}

function errorResult(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: `Error with mock: ${error instanceof Error ? error.message : String(error)}` }] };
}

export const mockToolDefinition: ToolDefinition = {
  name: 'mock',
  description: 'Configure a session-scoped mock of the explicit kind. Currently supports kind electron for main-process API functions in Electron sessions; kind network returns an unsupported error. Electron mocks require apiName and funcName. Repeated calls preserve history and queued once values. Use resolved/rejected behaviors for async APIs.',
  annotations: { title: 'Configure Mock', destructiveHint: true },
  inputSchema: { ...targetSchema, behavior: behaviorSchema.optional().describe('Default: mockReturnValue. Once behaviors queue a value for the next call.'), value: z.json().optional().describe('JSON value to return, resolve, or reject with. Omit for undefined.') },
};
export const mockTool: ToolCallback = async (args: MockArgs) => {
  try {
    const behavior = behaviorSchema.parse(args.behavior ?? 'mockReturnValue');
    return await withTarget(args, async ({ electron, mocks, target, key }) => {
      let mock = mocks.get(key);
      if (!mock) {
        mock = await electron.mock(target.apiName, target.funcName);
        // Retain immediately so a failed configuration can still be restored or retried.
        mocks.set(key, mock);
      }
      await mock[behavior](args.value);
      return { content: [{ type: 'text' as const, text: `Electron mock configured: ${args.apiName}.${args.funcName} (${behavior})` }] };
    });
  } catch (error) { return errorResult(error); }
};

export const getMockCallsToolDefinition: ToolDefinition = {
  name: 'get_mock_calls',
  description: 'Read current call arguments for a mock in the active session. Specify kind and the same target used by mock. Only kind electron is supported and requires apiName and funcName; network mocking is not implemented yet.',
  annotations: { title: 'Get Mock Calls', readOnlyHint: true },
  inputSchema: targetSchema,
};
export const getMockCallsTool: ToolCallback = async (args: Target) => {
  try {
    return await withTarget(args, async ({ mocks, key }) => {
      const mock = mocks.get(key);
      if (!mock) throw new Error('mock not found; call mock first.');
      await mock.update();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ calls: mock.mock.calls, callCount: mock.mock.calls.length }) }] };
    });
  } catch (error) { return errorResult(error); }
};

export const manageMockToolDefinition: ToolDefinition = {
  name: 'manage_mock',
  description: 'Manage a mock in the active session. Only kind electron is supported and requires apiName and funcName; network mocking is not implemented yet. For Electron: clear removes call history, reset also removes configured behavior and queued values, restore reinstates the original function and releases the mock.',
  annotations: { title: 'Manage Mock', destructiveHint: true },
  inputSchema: { ...targetSchema, action: actionSchema },
};
export const manageMockTool: ToolCallback = async (args: ManageArgs) => {
  try {
    const action = actionSchema.parse(args.action);
    return await withTarget(args, async ({ mocks, key }) => {
      const mock = mocks.get(key);
      if (!mock) throw new Error('mock not found; call mock first.');
      const method = { clear: 'mockClear', reset: 'mockReset', restore: 'mockRestore' } as const;
      await mock[method[action]]();
      if (action === 'restore') mocks.delete(key);
      return { content: [{ type: 'text' as const, text: `Electron mock ${action} completed: ${args.apiName}.${args.funcName}` }] };
    });
  } catch (error) { return errorResult(error); }
};
