/**
 * The hub's catalog model. Every integration — whether adapted from an Activepieces piece or written
 * natively — is normalized into a Toolkit so the rest of the system never cares where it came from.
 */

export type AuthSchemeType = 'OAUTH2' | 'SECRET_TEXT' | 'BASIC_AUTH' | 'CUSTOM_AUTH' | 'NO_AUTH';

export interface FieldDef {
  name: string;
  displayName: string;
  description?: string;
  required: boolean;
  /** Secret fields are rendered as password inputs and never echoed back. */
  secret: boolean;
  type: 'string' | 'number' | 'boolean' | 'select';
  options?: { label: string; value: string }[];
  defaultValue?: unknown;
}

export interface OAuth2Spec {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce: boolean;
  pkceMethod: 'S256' | 'plain';
  /** Extra query params appended to the authorize URL. */
  authorizeParams: Record<string, string>;
  /** How client credentials are sent to the token endpoint. */
  clientAuth: 'body' | 'header';
  /** Token endpoint body encoding. Most providers take form-encoded; Atlassian documents JSON. */
  tokenFormat?: 'form' | 'json';
  /** Provider family used to look up platform-managed OAuth apps (google, github, facebook…). */
  provider: string;
}

export interface AuthScheme {
  type: AuthSchemeType;
  displayName: string;
  description?: string;
  oauth2?: OAuth2Spec;
  /** Form fields: the secret for SECRET_TEXT, username/password for BASIC_AUTH, props for CUSTOM_AUTH, and
   *  OAuth2 connection props (e.g. a tenant subdomain substituted into authUrl). */
  fields: FieldDef[];
}

export type JsonSchema = Record<string, any>;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  /** Globally unique: `<toolkit>.<action>`. */
  slug: string;
  toolkit: string;
  action: string;
  displayName: string;
  description: string;
  inputSchema: JsonSchema;
  /** Inputs whose allowed values come from the provider at runtime (call listOptions). */
  dynamicInputs: string[];
  /** Explicit MCP annotations; inferred from the action name when absent (see annotations.ts). */
  annotations?: ToolAnnotations;
  /** The piece's own label for the action, when it has one (Activepieces `classification`). */
  classification?: 'READ' | 'SEARCH' | 'WRITE' | 'DESTRUCTIVE';
}

/** Stored credential. Mirrors the Activepieces AppConnectionValue shapes so pieces consume it unchanged. */
export type ConnectionValue =
  | { type: 'SECRET_TEXT'; secret_text: string }
  | { type: 'BASIC_AUTH'; username: string; password: string }
  | { type: 'CUSTOM_AUTH'; props: Record<string, unknown> }
  | { type: 'NO_AUTH' }
  | {
      type: 'OAUTH2';
      access_token: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      claimed_at: number;
      scope?: string;
      client_id: string;
      client_secret: string;
      token_url: string;
      redirect_url: string;
      data: Record<string, any>;
      props?: Record<string, unknown>;
    };

export interface ExecutionContext {
  tenantId: string;
  userId: string;
  connectedAccountId?: string;
  publicUrl: string;
  store: {
    get<T>(key: string): Promise<T | null>;
    put<T>(key: string, value: T): Promise<T>;
    delete(key: string): Promise<void>;
  };
}

export interface OptionsResult {
  /** For dropdowns. */
  options?: { label: string; value: unknown }[];
  /** For dynamic inputs: the sub-schema the input expands into, given the other arguments. */
  schema?: JsonSchema;
  placeholder?: string;
}

export interface Toolkit {
  slug: string;
  name: string;
  description: string;
  logoUrl?: string;
  categories: string[];
  source: 'activepieces' | 'native';
  version?: string;
  authSchemes: AuthScheme[];
  tools: ToolDef[];
  execute(
    action: string,
    args: Record<string, unknown>,
    auth: ConnectionValue | undefined,
    ctx: ExecutionContext,
  ): Promise<unknown>;
  listOptions?(
    action: string,
    input: string,
    args: Record<string, unknown>,
    auth: ConnectionValue | undefined,
    ctx: ExecutionContext,
  ): Promise<OptionsResult>;
  /** Optional credential check run when a non-OAuth account is created. */
  validate?(auth: ConnectionValue): Promise<{ valid: boolean; error?: string }>;
  /** Optional human label for the account (email, login, workspace). */
  identify?(auth: ConnectionValue): Promise<string | undefined>;
  /** Event sources (new email, new PR…). Absent when the toolkit has none. */
  triggers?: TriggerDef[];
  triggerHooks?: TriggerHooks;
}

export type TriggerStrategy = 'POLLING' | 'WEBHOOK';

export interface TriggerDef {
  /** Globally unique: `<toolkit>.<trigger>`. */
  slug: string;
  toolkit: string;
  name: string;
  displayName: string;
  description: string;
  strategy: TriggerStrategy;
  inputSchema: JsonSchema;
  sampleData?: unknown;
  /** Webhook triggers whose provider subscription expires and must be renewed periodically. */
  renews?: boolean;
}

export interface TriggerRuntime {
  auth: ConnectionValue | undefined;
  config: Record<string, unknown>;
  store: ExecutionContext['store'];
  /** Public URL the provider should call (webhook triggers). */
  webhookUrl: string;
  tenantId: string;
  publicUrl: string;
}

export interface WebhookPayload {
  body: unknown;
  rawBody?: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}

export interface TriggerHooks {
  /** Validate inputs and register with the provider (webhooks) or set the polling baseline. */
  enable(trigger: string, rt: TriggerRuntime): Promise<void>;
  disable(trigger: string, rt: TriggerRuntime): Promise<void>;
  /** Polling: fetch new items since the last run. Webhook: turn one delivery into zero or more events. */
  run(trigger: string, rt: TriggerRuntime, payload?: WebhookPayload): Promise<unknown[]>;
  /** Provider verification requests (e.g. challenge echo). Returns undefined when this request is not one. */
  handshake?(
    trigger: string,
    rt: TriggerRuntime,
    payload: WebhookPayload,
  ): Promise<{ status: number; body?: unknown; headers?: Record<string, string> } | undefined>;
  renew?(trigger: string, rt: TriggerRuntime): Promise<void>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
