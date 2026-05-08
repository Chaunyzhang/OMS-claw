export interface OpenClawToolResponse {
  content: Array<{ type: "text"; text: string }>;
}

export interface OpenClawToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<OpenClawToolResponse> | OpenClawToolResponse;
}

export type OpenClawToolFactory = (
  ctx: Record<string, unknown>
) => OpenClawToolDefinition | null | undefined | Promise<OpenClawToolDefinition | null | undefined>;

export interface OpenClawPluginApi {
  id?: string;
  name?: string;
  version?: string;
  source?: string;
  rootDir?: string;
  pluginConfig?: Record<string, unknown>;
  logger?: {
    debug?: (message: string, metadata?: Record<string, unknown>) => void;
    info?: (message: string, metadata?: Record<string, unknown>) => void;
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
    error?: (message: string, metadata?: Record<string, unknown>) => void;
  };
  registerTool?: (tool: OpenClawToolDefinition | OpenClawToolFactory, opts?: Record<string, unknown>) => void;
  registerContextEngine?: (id: string, factory: () => Record<string, unknown>) => void;
  registerMemoryCapability?: (capability: Record<string, unknown>) => void;
  on?: (
    eventName: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>,
    opts?: Record<string, unknown>
  ) => void;
}
