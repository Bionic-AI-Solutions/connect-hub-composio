# Provider verification checklist

The platform-managed OAuth apps (`OAUTH_<PROVIDER>_*`) are shared by every client tenant, so each provider has to
approve them for public use. Until it does, only test users you add can sign in. Approval takes from days to
several weeks, so start early. A client that brings its own OAuth app (`POST /v1/auth-configs`) goes through these
reviews itself.

Every app needs the same basics first:

- A public homepage, privacy policy and terms of service on your domain. The privacy policy must say exactly what
  data is read, why, how it is stored (encrypted at rest, per tenant) and how users can revoke access and have data
  deleted.
- The redirect URI `https://connect.baisoln.com/oauth/callback`.
- A verified domain and a monitored support email.
- A short screen recording of the full flow: a user starts in Paperclip, signs in with the provider, grants consent,
  and an agent uses the data. Most reviews ask for one.

## Google (Gmail, Drive, Sheets, Docs, Slides, Forms, Calendar, Contacts, Tasks, YouTube, Analytics, Search Console)

1. In Google Cloud, create the OAuth client (Web application) and configure the consent screen as **External**.
2. Enable each API used: Gmail, Drive, Sheets, Docs, Slides, Forms, Calendar, People, Tasks, YouTube Data v3,
   Analytics Admin, Analytics Data, Search Console, Business Profile.
3. Ask only for the scopes the enabled toolkits need. The Activepieces pieces request their own scopes (see
   `npm run catalog:list -- --tools` and each toolkit's auth scheme). A tenant can narrow them with
   `POST /v1/auth-configs {"scopes": [...]}`.
4. **Sensitive scopes** (Calendar, Contacts, YouTube, Analytics) need app verification: brand review, scope
   justification, demo video. It usually takes a few days to a few weeks.
5. **Restricted scopes** (Gmail read/modify/compose, full Drive) also need a yearly CASA security assessment by an
   approved assessor. Expect several weeks and an assessor fee. To avoid it, prefer narrower scopes where the
   toolkit allows (`drive.file` instead of `drive`, `gmail.send` only).
6. Business Profile API access is granted separately through Google's access request form.

## Meta (Facebook Pages, Instagram Business)

1. Create a Meta app of type **Business** and add Facebook Login for Business plus the Instagram Graph API.
2. Complete **Business Verification** for the company that owns the app.
3. Submit **App Review** for each permission used (for example `pages_manage_posts`, `pages_read_engagement`,
   `instagram_basic`, `instagram_content_publish`, `business_management`), with a screencast per permission
   showing its use.
4. Switch the app to Live mode once approved. Data Use Checkup has to be renewed every year.

## LinkedIn

1. Create the app on a LinkedIn company page you administer and verify it.
2. Add the products: **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** (self-serve).
3. Posting as an organization or reading page analytics needs **Community Management API** access, which LinkedIn
   grants on application to registered legal entities with a demo. Expect several weeks.

## Slack

1. Create the app and add the bot and user scopes the `slack` toolkit requests.
2. Enable public distribution. A Slack Marketplace listing is optional but needs its own review.

## GitHub

GitHub OAuth apps need no review. For organizations that restrict OAuth apps, an org admin approves the app once.
GitHub Apps (also supported) give finer, per-repository permissions.

## Atlassian

1. In the Atlassian developer console, create an OAuth 2.0 (3LO) integration with the Jira and Confluence scopes
   listed in `src/catalog/native/atlassian.ts`, and set the callback URL.
2. Set **Distribution** to *Sharing* so users outside your own Atlassian organization can authorize it. Give a
   vendor name, privacy policy and personal-data declaration.

## Reddit, Todoist, Zoom

- **Reddit**: register a "web app". Commercial use of the Data API needs a separate agreement with Reddit.
- **Todoist**: register the app in the App Management console. No review is needed.
- **Zoom**: create a General App. Publishing to the Zoom Marketplace for other accounts needs Zoom's app review
  (security questionnaire and a test account).
