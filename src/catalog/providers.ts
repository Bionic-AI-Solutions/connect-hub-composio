/**
 * OAuth provider families. A platform-managed OAuth app is configured once per family
 * (OAUTH_GOOGLE_CLIENT_ID/SECRET covers Gmail, Drive, Sheets, YouTube, Analytics…).
 */
const HOST_TO_PROVIDER: [RegExp, string][] = [
  [/(^|\.)google\.com$/, 'google'],
  [/(^|\.)github\.com$/, 'github'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'facebook'],
  [/(^|\.)slack\.com$/, 'slack'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)todoist\.com$/, 'todoist'],
  [/(^|\.)zoom\.us$/, 'zoom'],
  [/(^|\.)atlassian\.com$/, 'atlassian'],
  [/(^|\.)stackexchange\.com$/, 'stackexchange'],
  [/(^|\.)stackoverflow\.com$/, 'stackexchange'],
  [/(^|\.)microsoft(online)?\.com$/, 'microsoft'],
];

export function providerFor(authUrl: string): string {
  let host: string;
  try {
    host = new URL(authUrl.replace(/\{[^}]+\}/g, 'x')).hostname;
  } catch {
    return 'unknown';
  }
  for (const [re, name] of HOST_TO_PROVIDER) if (re.test(host)) return name;
  // Fall back to the registrable domain's first label: api.hubspot.com -> hubspot
  const parts = host.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : host;
}

/** Provider quirks needed to get long-lived (refreshable) tokens. */
export function providerAuthorizeParams(provider: string): Record<string, string> {
  switch (provider) {
    case 'google':
      return { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' };
    case 'reddit':
      return { duration: 'permanent' };
    case 'atlassian':
      return { audience: 'api.atlassian.com', prompt: 'consent' };
    default:
      return {};
  }
}
