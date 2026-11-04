/**
 * MCP tool annotations. MCP clients such as Paperclip use them to classify risk: readOnlyHint=true → read,
 * destructiveHint=true → destructive (quarantined until an operator approves), otherwise write.
 *
 * Many pieces label each action (READ, SEARCH, WRITE, DESTRUCTIVE); we use that label, and otherwise infer
 * from the action name. The inference errs towards caution:
 * anything not clearly a read is a write, and generic escape hatches (custom API calls, raw queries) are never
 * marked read-only because they can do anything.
 */
import type { ToolAnnotations, ToolDef } from './types.js';

const DESTRUCTIVE = new Set([
  'delete',
  'remove',
  'destroy',
  'purge',
  'archive',
  'trash',
  'revoke',
  'cancel',
  'unpublish',
  'ban',
  'kick',
  'clear',
  'erase',
  'wipe',
  'terminate',
  'deactivate',
  'disable',
  'unsubscribe',
  'uninstall',
  'reject',
  'close',
  'lock',
  'block',
  'mute',
  'leave',
  'unshare',
  'detach',
  'drop',
  'truncate',
  'void',
  'refund',
]);
const READ = new Set([
  'get',
  'list',
  'search',
  'find',
  'read',
  'fetch',
  'query',
  'lookup',
  'describe',
  'check',
  'count',
  'retrieve',
  'download',
  'export',
  'view',
  'show',
  'watch',
  'poll',
  'info',
  'details',
  'information',
  'stats',
  'report',
  'metadata',
  'preview',
  'verify',
  'validate',
  'whoami',
  'me',
]);
/** A read verb only counts when no write verb appears anywhere ("find_or_create_row" is a write). */
const WRITE = new Set([
  'create',
  'add',
  'insert',
  'update',
  'upsert',
  'set',
  'send',
  'post',
  'upload',
  'publish',
  'reply',
  'edit',
  'move',
  'copy',
  'rename',
  'assign',
  'invite',
  'share',
  'run',
  'start',
  'trigger',
  'append',
  'write',
  'save',
  'approve',
  'merge',
  'mark',
  'complete',
  'schedule',
  'subscribe',
  'follow',
  'like',
  'comment',
  'react',
]);
/** Start paid work (e.g. an Apify scrape run) even when the piece labels them READ, so never read-only. */
const STARTS_WORK = new Set(['scrape', 'crawl']);
/** Generic actions that can perform arbitrary operations. */
const ESCAPE_HATCH =
  /(custom_api_call|custom_api|raw_graphql|graphql_query|raw_request|run_query|execute_query|sql)/i;

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function inferAnnotations(
  tool: Pick<ToolDef, 'action' | 'displayName' | 'toolkit' | 'classification'>,
): ToolAnnotations {
  const title = tool.displayName;
  if (ESCAPE_HATCH.test(tool.action)) {
    return { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  const w = [...words(tool.action), ...words(tool.displayName)];
  // Drop a leading toolkit prefix such as "github_create_issue".
  const tk = new Set(words(tool.toolkit));
  const verbs = w.filter((x) => !tk.has(x));
  // The piece's own label wins when it says destructive or read; a destructive verb still wins over a
  // read or write label (caution), so "WRITE leave_channel" stays destructive.
  if (tool.classification === 'DESTRUCTIVE' || verbs.some((x) => DESTRUCTIVE.has(x))) {
    return { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  if (
    (tool.classification === 'READ' || tool.classification === 'SEARCH') &&
    !verbs.some((x) => STARTS_WORK.has(x))
  ) {
    return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  if (tool.classification === 'WRITE') {
    return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  const first = verbs[0];
  if (first && READ.has(first) && !verbs.some((x) => WRITE.has(x))) {
    return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}

export function annotationsFor(tool: ToolDef): ToolAnnotations {
  return {
    ...inferAnnotations(tool),
    ...(tool.annotations ?? {}),
    title: tool.annotations?.title ?? tool.displayName,
  };
}
