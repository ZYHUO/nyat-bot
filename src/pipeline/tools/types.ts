// ────────────────────────────────────────
// Tool System — Types
// ────────────────────────────────────────

export interface ToolResult {
  toolName: string;
  query: string;
  result: string;
}

export interface ToolConfig {
  searxngUrl?: string;
  fetchGatewayUrl?: string;
  fetchWorkerUrl?: string;
  webFetchUserAgent: string;
  ipQualityApiUrl?: string;
  timerApiUrl?: string;
  timerCallbackUrl?: string;
  commonApiKey?: string;
}
