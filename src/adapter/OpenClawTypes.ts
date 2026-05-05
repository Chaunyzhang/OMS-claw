export interface OpenClawToolResponse {
  content: Array<{ type: "text"; text: string }>;
}

export interface OpenClawToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<OpenClawToolResponse> | OpenClawToolResponse;
}

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
  registerTool?: (tool: OpenClawToolDefinition, opts?: Record<string, unknown>) => void;
  registerContextEngine?: (id: string, factory: () => Record<string, unknown>) => void;
  registerMemoryCapability?: (capability: Record<string, unknown>) => void;
}
