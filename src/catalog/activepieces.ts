/**
 * Adapter that turns Activepieces "pieces" (MIT-licensed npm packages, `@activepieces/piece-*`) into hub
 * Toolkits. Pieces ship as self-contained bundles: we read their auth definitions and action props, convert
 * props to JSON Schema, and run actions with a minimal stand-in for the Activepieces engine context.
 *
 * Adding an integration = `npm i @activepieces/piece-<name>` and restart. Nothing else.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AuthScheme,
  TriggerDef,
  TriggerHooks,
  TriggerRuntime,
  WebhookPayload,
  ConnectionValue,
  ExecutionContext,
  FieldDef,
  JsonSchema,
  OAuth2Spec,
  OptionsResult,
  ToolDef,
  Toolkit,
} from './types.js';
import { ToolInputError } from './types.js';
import { providerFor, providerAuthorizeParams } from './providers.js';

const require = createRequire(import.meta.url);

type ApProp = {
  type: string;
  displayName?: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  options?: any;
  properties?: Record<string, ApProp>;
  props?: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, ApProp>>;
  refreshers?: string[];
};

type ApAction = {
  name: string;
  displayName: string;
  description?: string;
  props: Record<string, ApProp>;
  run(ctx: unknown): Promise<unknown>;
};

export type ApPiece = {
  displayName: string;
  description?: string;
  logoUrl?: string;
  categories?: string[];
  auth?: any;
  actions(): Record<string, ApAction>;
  triggers?(): Record<string, ApTrigger>;
};

type ApTrigger = {
  name: string;
  displayName: string;
  description?: string;
  type: string;
  props: Record<string, ApProp>;
  sampleData?: unknown;
  handshakeConfiguration?: { strategy: string; paramName?: string };
  renewConfiguration?: { strategy: string };
  onEnable(ctx: unknown): Promise<void>;
  onDisable(ctx: unknown): Promise<void>;
  run(ctx: unknown): Promise<unknown[]>;
  onHandshake?(ctx: unknown): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
  onRenew?(ctx: unknown): Promise<void>;
};

/** Trigger strategies the hub can run. APP_WEBHOOK needs one central app subscription per provider (not yet). */
const SUPPORTED_TRIGGER_TYPES = new Set(['POLLING', 'WEBHOOK']);

/** Display-only prop types that carry no input. */
const NON_INPUT = new Set(['MARKDOWN']);
const DYNAMIC_TYPES = new Set(['DROPDOWN', 'MULTI_SELECT_DROPDOWN', 'DYNAMIC']);

function describe(p: ApProp): string | undefined {
  const parts = [p.displayName, p.description].filter(Boolean);
  return parts.length ? parts.join(' — ') : undefined;
}

export function propToSchema(p: ApProp): JsonSchema {
  const base: JsonSchema = {};
  const d = describe(p);
  if (d) base.description = d;
  if (p.defaultValue !== undefined && typeof p.defaultValue !== 'function') base.default = p.defaultValue;
  switch (p.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
    case 'RICH_TEXT':
    case 'SECRET_TEXT':
      return { ...base, type: 'string' };
    case 'NUMBER':
      return { ...base, type: 'number' };
    case 'CHECKBOX':
      return { ...base, type: 'boolean' };
    case 'DATE_TIME':
      return { ...base, type: 'string', format: 'date-time' };
    case 'JSON':
      return { ...base, description: `${d ?? ''} (JSON value)`.trim() };
    case 'OBJECT':
      return { ...base, type: 'object', additionalProperties: true };
    case 'FILE':
      return {
        ...base,
        description: `${d ?? ''} (file: a URL, or {"filename": "...", "base64": "..."})`.trim(),
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: { filename: { type: 'string' }, base64: { type: 'string' } },
            required: ['base64'],
          },
        ],
      };
    case 'STATIC_DROPDOWN': {
      const values = (p.options?.options ?? []).map((o: any) => o.value);
      return values.length && values.every((v: unknown) => ['string', 'number'].includes(typeof v))
        ? { ...base, enum: values }
        : base;
    }
    case 'STATIC_MULTI_SELECT_DROPDOWN': {
      const values = (p.options?.options ?? []).map((o: any) => o.value);
      return { ...base, type: 'array', items: values.length ? { enum: values } : {} };
    }
    case 'ARRAY': {
      if (p.properties && Object.keys(p.properties).length) {
        return { ...base, type: 'array', items: propsToObjectSchema(p.properties) };
      }
      return { ...base, type: 'array', items: {} };
    }
    case 'DROPDOWN':
      return { ...base, description: `${d ?? ''} (dynamic: use list_options to get valid values)`.trim() };
    case 'MULTI_SELECT_DROPDOWN':
      return {
        ...base,
        type: 'array',
        description: `${d ?? ''} (dynamic: use list_options to get valid values)`.trim(),
      };
    case 'DYNAMIC':
      return {
        ...base,
        type: 'object',
        additionalProperties: true,
        description: `${d ?? ''} (dynamic fields: use list_options to get the sub-schema)`.trim(),
      };
    default:
      return base;
  }
}

export function propsToObjectSchema(props: Record<string, ApProp>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(props)) {
    if (NON_INPUT.has(p.type)) continue;
    properties[name] = propToSchema(p);
    if (p.required && p.defaultValue === undefined) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function fieldsFromProps(props: Record<string, ApProp> | undefined): FieldDef[] {
  if (!props) return [];
  return Object.entries(props)
    .filter(([, p]) => !NON_INPUT.has(p.type))
    .map(([name, p]) => ({
      name,
      displayName: p.displayName ?? name,
      description: p.description,
      required: !!p.required,
      secret: p.type === 'SECRET_TEXT',
      type:
        p.type === 'CHECKBOX'
          ? 'boolean'
          : p.type === 'NUMBER'
            ? 'number'
            : p.type === 'STATIC_DROPDOWN'
              ? 'select'
              : 'string',
      options:
        p.type === 'STATIC_DROPDOWN'
          ? (p.options?.options ?? []).map((o: any) => ({ label: o.label, value: String(o.value) }))
          : undefined,
      defaultValue: p.defaultValue,
    }));
}

function authSchemesFromPiece(piece: ApPiece): AuthScheme[] {
  const list: any[] = piece.auth === undefined ? [] : Array.isArray(piece.auth) ? piece.auth : [piece.auth];
  if (!list.length) return [{ type: 'NO_AUTH', displayName: 'No authentication', fields: [] }];
  const schemes: AuthScheme[] = [];
  for (const a of list) {
    switch (a.type) {
      case 'OAUTH2': {
        const extra = a.extra ?? {};
        const authorizeParams: Record<string, string> = {};
        // Activepieces keeps engine hints (grantType/responseType) in `extra`; only real URL params pass through.
        for (const [k, v] of Object.entries(extra)) {
          if (!['grantType', 'responseType'].includes(k) && typeof v === 'string') authorizeParams[k] = v;
        }
        const provider = providerFor(a.authUrl);
        const oauth2: OAuth2Spec = {
          authUrl: a.authUrl,
          tokenUrl: a.tokenUrl,
          scopes: a.scope ?? [],
          pkce: !!a.pkce,
          pkceMethod: a.pkceMethod === 'plain' ? 'plain' : 'S256',
          authorizeParams: { ...providerAuthorizeParams(provider), ...authorizeParams },
          clientAuth: a.authorizationMethod === 'HEADER' ? 'header' : 'body',
          provider,
        };
        schemes.push({
          type: 'OAUTH2',
          displayName: a.displayName ?? 'OAuth2',
          description: a.description,
          oauth2,
          fields: fieldsFromProps(a.props),
        });
        break;
      }
      case 'SECRET_TEXT':
        schemes.push({
          type: 'SECRET_TEXT',
          displayName: a.displayName ?? 'API key',
          description: a.description,
          fields: [
            {
              name: 'secret_text',
              displayName: a.displayName ?? 'API key',
              description: a.description,
              required: true,
              secret: true,
              type: 'string',
            },
          ],
        });
        break;
      case 'BASIC_AUTH':
        schemes.push({
          type: 'BASIC_AUTH',
          displayName: a.displayName ?? 'Username & password',
          description: a.description,
          fields: [
            {
              name: 'username',
              displayName: a.username?.displayName ?? 'Username',
              description: a.username?.description,
              required: true,
              secret: false,
              type: 'string',
            },
            {
              name: 'password',
              displayName: a.password?.displayName ?? 'Password',
              description: a.password?.description,
              required: true,
              secret: true,
              type: 'string',
            },
          ],
        });
        break;
      case 'CUSTOM_AUTH':
        schemes.push({
          type: 'CUSTOM_AUTH',
          displayName: a.displayName ?? 'Credentials',
          description: a.description,
          fields: fieldsFromProps(a.props),
        });
        break;
      default:
        // OIDC and future types are not supported yet; skip rather than offer a scheme we cannot complete.
        break;
    }
  }
  return schemes;
}

function pieceAuthFor(piece: ApPiece, type: string): any {
  const list: any[] = piece.auth === undefined ? [] : Array.isArray(piece.auth) ? piece.auth : [piece.auth];
  return list.find((a) => a.type === type);
}

/** Raw value an Activepieces `validate()` hook expects for each auth type. */
function validateArg(auth: ConnectionValue): unknown {
  switch (auth.type) {
    case 'SECRET_TEXT':
      return auth.secret_text;
    case 'BASIC_AUTH':
      return { username: auth.username, password: auth.password };
    case 'CUSTOM_AUTH':
      return auth.props;
    default:
      return auth;
  }
}

async function toFileArg(value: unknown, name: string): Promise<unknown> {
  if (value == null) return value;
  let filename: string;
  let data: Buffer;
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      const m = /^data:[^;]*;base64,(.*)$/s.exec(value);
      if (!m) throw new ToolInputError(`${name}: unsupported data URL`);
      data = Buffer.from(m[1], 'base64');
      filename = 'file';
    } else if (/^https?:\/\//.test(value)) {
      const res = await fetch(value);
      if (!res.ok) throw new ToolInputError(`${name}: could not download ${value} (HTTP ${res.status})`);
      data = Buffer.from(await res.arrayBuffer());
      filename = decodeURIComponent(new URL(value).pathname.split('/').pop() || 'file');
    } else {
      throw new ToolInputError(`${name}: expected a URL, a data: URL, or {filename, base64}`);
    }
  } else if (typeof value === 'object' && typeof (value as any).base64 === 'string') {
    data = Buffer.from((value as any).base64, 'base64');
    filename = (value as any).filename ?? 'file';
  } else {
    throw new ToolInputError(`${name}: expected a URL, a data: URL, or {filename, base64}`);
  }
  const extension = filename.includes('.') ? filename.split('.').pop() : undefined;
  return { filename, data, extension, base64: data.toString('base64') };
}

/** Apply defaults, coerce scalars and check required inputs — the parts of the AP engine's prop processing we need. */
export async function normalizeArgs(
  props: Record<string, ApProp>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  const unknown = Object.keys(args).filter((k) => !(k in props));
  if (unknown.length) throw new ToolInputError(`Unknown input(s): ${unknown.join(', ')}`);
  for (const [name, p] of Object.entries(props)) {
    if (NON_INPUT.has(p.type)) continue;
    let v = args[name];
    if (v === undefined || v === null || v === '') v = p.defaultValue;
    if ((v === undefined || v === null || v === '') && p.required) {
      missing.push(name);
      continue;
    }
    if (v !== undefined && v !== null) {
      if (p.type === 'NUMBER' && typeof v === 'string') {
        const n = Number(v);
        if (Number.isNaN(n)) throw new ToolInputError(`${name}: expected a number`);
        v = n;
      } else if (p.type === 'CHECKBOX' && typeof v === 'string') {
        v = v === 'true';
      } else if (p.type === 'FILE') {
        v = await toFileArg(v, name);
      } else if (p.type === 'JSON' && typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          /* pieces accept raw strings for JSON too */
        }
      }
    }
    out[name] = v;
  }
  if (missing.length) throw new ToolInputError(`Missing required input(s): ${missing.join(', ')}`);
  return out;
}

function buildContext(
  action: ApAction,
  auth: ConnectionValue | undefined,
  propsValue: Record<string, unknown>,
  ctx: ExecutionContext,
) {
  const runId = randomUUID();
  const unsupported = (what: string) => () => {
    throw new Error(`${what} is not supported when running actions through the hub`);
  };
  return {
    auth,
    propsValue,
    store: ctx.store,
    server: { apiUrl: `${ctx.publicUrl}/`, publicUrl: `${ctx.publicUrl}/`, token: '' },
    project: { id: ctx.tenantId, externalId: async () => undefined },
    connections: { get: async () => null },
    flows: {
      list: async () => ({ data: [], next: null, previous: null }),
      current: { id: 'hub', version: { id: 'hub' } },
    },
    step: { name: action.name },
    executionType: 'BEGIN',
    tags: { add: async () => undefined },
    output: { update: async () => undefined },
    files: {
      write: async ({ fileName, data }: { fileName: string; data: Buffer }) =>
        `data:application/octet-stream;name=${encodeURIComponent(fileName)};base64,${Buffer.from(data).toString('base64')}`,
    },
    run: {
      id: runId,
      canPause: false,
      stop: () => undefined,
      respond: () => undefined,
      pause: unsupported('Pausing a run'),
      createWaitpoint: unsupported('Waitpoints'),
      waitForWaitpoint: unsupported('Waitpoints'),
    },
    generateResumeUrl: unsupported('Resume URLs'),
  };
}

function triggerContext(
  trigger: ApTrigger,
  rt: TriggerRuntime,
  propsValue: Record<string, unknown>,
  payload?: WebhookPayload,
) {
  return {
    auth: rt.auth,
    propsValue,
    store: rt.store,
    webhookUrl: rt.webhookUrl,
    payload: payload ?? { body: {}, headers: {}, queryParams: {} },
    server: { apiUrl: `${rt.publicUrl}/`, publicUrl: `${rt.publicUrl}/`, token: '' },
    project: { id: rt.tenantId, externalId: async () => undefined },
    connections: { get: async () => null },
    flows: {
      list: async () => ({ data: [], next: null, previous: null }),
      current: { id: 'hub', version: { id: 'hub' } },
    },
    step: { name: trigger.name },
    setSchedule: () => undefined,
    isRepublish: false,
    run: { id: randomUUID() },
    files: {
      write: async ({ fileName, data }: { fileName: string; data: Buffer }) =>
        `data:application/octet-stream;name=${encodeURIComponent(fileName)};base64,${Buffer.from(data).toString('base64')}`,
    },
    app: {
      createListeners: () => {
        throw new Error('App-level webhook listeners are not supported by the hub');
      },
    },
  };
}

function handshakeMatches(cfg: ApTrigger['handshakeConfiguration'], p: WebhookPayload): boolean {
  if (!cfg || !cfg.paramName || cfg.strategy === 'NONE') return false;
  const name = cfg.paramName;
  switch (cfg.strategy) {
    case 'HEADER_PRESENT':
      return p.headers[name.toLowerCase()] !== undefined;
    case 'QUERY_PRESENT':
      return p.queryParams[name] !== undefined;
    case 'BODY_PARAM_PRESENT':
      return (
        !!p.body && typeof p.body === 'object' && (p.body as Record<string, unknown>)[name] !== undefined
      );
    default:
      return false;
  }
}

function pieceTriggers(
  slug: string,
  piece: ApPiece,
): { defs: TriggerDef[]; hooks: TriggerHooks } | undefined {
  const all = piece.triggers ? piece.triggers() : {};
  const usable = Object.values(all).filter((t) => SUPPORTED_TRIGGER_TYPES.has(t.type));
  if (!usable.length) return undefined;
  const byName = new Map(usable.map((t) => [t.name, t]));
  const get = (name: string) => {
    const t = byName.get(name);
    if (!t) throw new ToolInputError(`Unknown trigger "${name}" in toolkit "${slug}"`);
    return t;
  };
  const props = async (t: ApTrigger, rt: TriggerRuntime) => normalizeArgs(t.props, rt.config);
  return {
    defs: usable.map((t) => ({
      slug: `${slug}.${t.name}`,
      toolkit: slug,
      name: t.name,
      displayName: t.displayName,
      description: t.description || t.displayName,
      strategy: t.type as TriggerDef['strategy'],
      inputSchema: propsToObjectSchema(t.props),
      sampleData: t.sampleData,
      renews: !!t.onRenew && !!t.renewConfiguration && t.renewConfiguration.strategy !== 'NONE',
    })),
    hooks: {
      async enable(name, rt) {
        const t = get(name);
        await t.onEnable(triggerContext(t, rt, await props(t, rt)));
      },
      async disable(name, rt) {
        const t = get(name);
        await t.onDisable(triggerContext(t, rt, await props(t, rt)));
      },
      async run(name, rt, payload) {
        const t = get(name);
        const items = await t.run(triggerContext(t, rt, await props(t, rt), payload));
        return Array.isArray(items) ? items : [];
      },
      async handshake(name, rt, payload) {
        const t = get(name);
        if (!t.onHandshake || !handshakeMatches(t.handshakeConfiguration, payload)) return undefined;
        return t.onHandshake(triggerContext(t, rt, await props(t, rt), payload));
      },
      async renew(name, rt) {
        const t = get(name);
        if (t.onRenew) await t.onRenew(triggerContext(t, rt, await props(t, rt)));
      },
    },
  };
}

export function pieceToToolkit(slug: string, piece: ApPiece, version?: string): Toolkit {
  const actions = piece.actions();
  const triggers = pieceTriggers(slug, piece);
  const tools: ToolDef[] = Object.values(actions).map((a) => ({
    slug: `${slug}.${a.name}`,
    toolkit: slug,
    action: a.name,
    displayName: a.displayName,
    description: a.description || a.displayName,
    inputSchema: propsToObjectSchema(a.props),
    dynamicInputs: Object.entries(a.props)
      .filter(([, p]) => DYNAMIC_TYPES.has(p.type))
      .map(([n]) => n),
  }));

  const getAction = (name: string): ApAction => {
    const a = actions[name];
    if (!a) throw new ToolInputError(`Unknown action "${name}" in toolkit "${slug}"`);
    return a;
  };

  return {
    slug,
    name: piece.displayName,
    description: piece.description ?? '',
    logoUrl: piece.logoUrl,
    categories: piece.categories ?? [],
    source: 'activepieces',
    version,
    authSchemes: authSchemesFromPiece(piece),
    tools,
    triggers: triggers?.defs,
    triggerHooks: triggers?.hooks,

    async execute(actionName, args, auth, ctx) {
      const action = getAction(actionName);
      const propsValue = await normalizeArgs(action.props, args);
      return action.run(buildContext(action, auth, propsValue, ctx));
    },

    async listOptions(actionName, input, args, auth, ctx): Promise<OptionsResult> {
      const action = getAction(actionName);
      const prop = action.props[input];
      if (!prop) throw new ToolInputError(`Unknown input "${input}"`);
      const propCtx = {
        server: { apiUrl: `${ctx.publicUrl}/`, publicUrl: `${ctx.publicUrl}/`, token: '' },
        project: { id: ctx.tenantId, externalId: async () => undefined },
        flows: {
          list: async () => ({ data: [], next: null, previous: null }),
          current: { id: 'hub', version: { id: 'hub' } },
        },
        connections: { get: async () => null },
        searchValue: typeof args.searchValue === 'string' ? args.searchValue : undefined,
      };
      const fnArgs = { ...args, auth };
      if (prop.type === 'DROPDOWN' || prop.type === 'MULTI_SELECT_DROPDOWN') {
        const res = await prop.options(fnArgs, propCtx);
        return { options: res?.options ?? [], placeholder: res?.placeholder };
      }
      if (prop.type === 'STATIC_DROPDOWN' || prop.type === 'STATIC_MULTI_SELECT_DROPDOWN') {
        return { options: prop.options?.options ?? [] };
      }
      if (prop.type === 'DYNAMIC' && prop.props) {
        const sub = await prop.props(fnArgs, propCtx);
        return { schema: propsToObjectSchema(sub ?? {}) };
      }
      throw new ToolInputError(`Input "${input}" has no runtime options`);
    },

    async validate(auth) {
      const def = pieceAuthFor(piece, auth.type);
      if (!def?.validate) return { valid: true };
      try {
        const res = await def.validate({ auth: validateArg(auth), server: { apiUrl: '', publicUrl: '' } });
        return res?.valid === false
          ? { valid: false, error: res.error ?? 'Invalid credentials' }
          : { valid: true };
      } catch (e) {
        return { valid: false, error: (e as Error).message };
      }
    },

    async identify(auth) {
      const def = pieceAuthFor(piece, auth.type);
      if (!def?.getConnectionIdentifier) return undefined;
      try {
        const id = await def.getConnectionIdentifier({ auth });
        return typeof id === 'string' ? id : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Discover every installed `@activepieces/piece-*` package. */
export function loadInstalledPieces(nodeModules = join(process.cwd(), 'node_modules')): Toolkit[] {
  const dir = join(nodeModules, '@activepieces');
  if (!existsSync(dir)) return [];
  const toolkits: Toolkit[] = [];
  for (const name of readdirSync(dir)
    .filter((d) => d.startsWith('piece-'))
    .sort()) {
    const slug = name.slice('piece-'.length);
    try {
      const mod = require(join(dir, name));
      const piece = Object.values(mod).find((v: any) => v && typeof v.actions === 'function') as
        ApPiece | undefined;
      if (!piece) continue;
      const pkg = JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8'));
      toolkits.push(pieceToToolkit(slug, piece, pkg.version));
    } catch (e) {
      console.warn(`[catalog] skipping @activepieces/${name}: ${(e as Error).message}`);
    }
  }
  return toolkits;
}
