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

/** Where an operator registers each provider's OAuth app, shown in the dashboard's one-time setup. */
export const PROVIDER_SETUP: Record<string, { name: string; consoleUrl: string; note?: string }> = {
  github: { name: 'GitHub', consoleUrl: 'https://github.com/settings/applications/new' },
  google: {
    name: 'Google',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials/oauthclient',
    note: 'Create a "Web application" client. Enable the APIs you need (Gmail, Drive, Calendar…) in the same project.',
  },
  slack: { name: 'Slack', consoleUrl: 'https://api.slack.com/apps?new_app=1' },
  atlassian: {
    name: 'Atlassian',
    consoleUrl: 'https://developer.atlassian.com/console/myapps/create-3lo-app/',
    note: 'Add the Jira and Confluence API permissions, then set the callback URL under Authorization.',
  },
  linkedin: { name: 'LinkedIn', consoleUrl: 'https://www.linkedin.com/developers/apps/new' },
  facebook: {
    name: 'Meta (Facebook and Instagram)',
    consoleUrl: 'https://developers.facebook.com/apps/creation/',
    note: 'Add "Facebook Login for Business" and put the callback URL under Valid OAuth Redirect URIs.',
  },
  reddit: {
    name: 'Reddit',
    consoleUrl: 'https://www.reddit.com/prefs/apps',
    note: 'Choose the "web app" type.',
  },
  zoom: {
    name: 'Zoom',
    consoleUrl: 'https://marketplace.zoom.us/develop/create',
    note: 'Choose "General App" (user-managed).',
  },
  todoist: { name: 'Todoist', consoleUrl: 'https://developer.todoist.com/appconsole.html' },
};
