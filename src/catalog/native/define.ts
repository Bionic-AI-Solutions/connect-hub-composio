import type {
  AuthScheme,
  ConnectionValue,
  ExecutionContext,
  JsonSchema,
  ToolAnnotations,
  Toolkit,
} from '../types.js';
import { ToolInputError } from '../types.js';

export interface NativeTool {
  name: string;
  displayName: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  run(args: Record<string, any>, auth: ConnectionValue | undefined, ctx: ExecutionContext): Promise<unknown>;
}

export interface NativeToolkitDef {
  slug: string;
  name: string;
  description: string;
  logoUrl?: string;
  categories: string[];
  authSchemes: AuthScheme[];
  tools: NativeTool[];
  validate?: Toolkit['validate'];
  identify?: Toolkit['identify'];
}

function checkRequired(schema: JsonSchema, args: Record<string, unknown>) {
  const missing = (schema.required ?? []).filter(
    (k: string) => args[k] === undefined || args[k] === null || args[k] === '',
  );
  if (missing.length) throw new ToolInputError(`Missing required input(s): ${missing.join(', ')}`);
  const known = Object.keys(schema.properties ?? {});
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) throw new ToolInputError(`Unknown input(s): ${unknown.join(', ')}`);
}

export function defineToolkit(def: NativeToolkitDef): Toolkit {
  const byName = new Map(def.tools.map((t) => [t.name, t]));
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    logoUrl: def.logoUrl,
    categories: def.categories,
    source: 'native',
    authSchemes: def.authSchemes,
    tools: def.tools.map((t) => ({
      slug: `${def.slug}.${t.name}`,
      toolkit: def.slug,
      action: t.name,
      displayName: t.displayName,
      description: t.description,
      inputSchema: { additionalProperties: false, ...t.inputSchema },
      dynamicInputs: [],
      annotations: t.annotations,
    })),
    async execute(action, args, auth, ctx) {
      const tool = byName.get(action);
      if (!tool) throw new ToolInputError(`Unknown action "${action}" in toolkit "${def.slug}"`);
      checkRequired(tool.inputSchema, args);
      return tool.run(args, auth, ctx);
    },
    validate: def.validate,
    identify: def.identify,
  };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function httpJson(
  url: string,
  init: RequestInit & { query?: Record<string, unknown> } = {},
): Promise<any> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== '')
      u.searchParams.set(k, Array.isArray(v) ? v.join(';') : String(v));
  }
  const res = await fetch(u, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok)
    throw new ProviderError(
      `${init.method ?? 'GET'} ${u.pathname} failed with HTTP ${res.status}`,
      res.status,
      body,
    );
  return body;
}

export function bearer(auth: ConnectionValue | undefined): string {
  if (!auth) throw new ToolInputError('This tool needs a connected account');
  if (auth.type === 'OAUTH2') return `Bearer ${auth.access_token}`;
  if (auth.type === 'SECRET_TEXT') return `Bearer ${auth.secret_text}`;
  throw new ToolInputError(`Unsupported auth type ${auth.type} for this tool`);
}
