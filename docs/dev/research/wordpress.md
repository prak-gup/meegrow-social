# WordPress — Research Note and Decisions

_Research for the `wordpress` provider (blog articles). Compiled 2026-10-11 from WordPress's public
developer documentation and WordPress core's source. **No request was made to any WordPress site**:
everything below is read from documentation and source, and the provider's tests replay fixtures
built from those shapes (marked documentation-built). §8 is what a first live connect must confirm._

> **Headline:** a self-hosted WordPress site can be connected with **no app registration and no
> password typed into our app**. WordPress core (5.6+) has an authorization screen that issues an
> _application password_ and redirects back with it. The cost is that the redirect carries the
> credential itself in the query string, so the callback is handled very differently from an OAuth
> one (§3).

---

## 1. Scope

In: self-hosted WordPress, and any WordPress that exposes the core REST API (`wp/v2`) with
Application Passwords, served over https. Create an article — now, scheduled, or as a draft in our
app.

Out, with what each would take: WordPress.com OAuth (§9.1), update and delete after publish (§9.2),
analytics (§9.3), multisite, uploading inline images.

## 2. The connect flow

Sources: [Application Passwords integration guide][guide],
[`wp-admin/authorize-application.php`][authorize-src], [`auth-app.js`][authapp-src],
[REST API discovery][discovery].

1. **The person enters the site address.** There is no central login to redirect to.
2. **Discovery** (`WordPressClient.discover`), two unauthenticated requests:
   - `HEAD {site}` — the front page carries `Link: <…/wp-json/>; rel="https://api.w.org/"`. A site
     without pretty permalinks advertises `…/?rest_route=/` instead; both forms are handled. With
     no Link header we try `/wp-json/`, then `/?rest_route=/`.
   - `GET {root}?_fields=name,url,home,namespaces,authentication` — the index. `namespaces` must
     contain `wp/v2`. `authentication["application-passwords"].endpoints.authorization` is the
     authorize screen's URL; the guide says to read it from here rather than guess, and that an
     empty `authentication` means application passwords are unavailable ("perhaps because the
     request is not over https or it has been intentionally disabled").
3. **Redirect** the person to that URL with:
   - `app_name` (required) — `Meegrow Social`; becomes the name of the password on their profile.
   - `app_id` (recommended) — must be a UUID or WordPress refuses the request ("The application ID
     must be a UUID."). We send one fixed UUID so a site owner can find everything we were given.
   - `success_url` — `{APP_URL}/connect/callback?state={flowId}`.
   - `reject_url` — the same with `&error=access_denied`.
   - WordPress rejects an `http:` redirect URL ("The URL must be served over a secure connection")
     unless the site is a local environment or the host is `127.0.0.1` / `[::1]`
     (`wp_is_authorize_application_redirect_url_valid`, since 6.3.2). **Our `APP_URL` must be
     https**, which it is in production.
4. **The person logs in to their own site and approves.** WordPress creates the password and
   redirects to `success_url` with three parameters appended: `site_url`, `user_login`,
   `password`. Both the no-JS path (`add_query_arg`) and the JS path (`? `/`&` chosen by whether
   the URL already has a query) preserve our `state`.
5. **Rejection** sends them to `reject_url` as given. If application passwords are unavailable for
   that user, the "Go Back" link is `reject_url` with `error=disabled`.
6. **Verification** — we call `GET /wp/v2/users/me?context=edit` with the credentials and require
   `capabilities.edit_posts` and `capabilities.publish_posts`. Only then is a connection created.

Requests are authenticated with HTTP Basic (`user_login:password`) per the guide. Application
passwords are available "to all users on sites served over SSL/HTTPS" by default
(`wp_is_application_passwords_supported()` is `is_ssl() || local environment`), which is why an
`http://` site is refused before any request with a message saying so.

### How it fits our connect model

| Our model               | WordPress                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth_flows` row       | Same table, same single-use `state`. `code_verifier` holds the provider's flow context: which site this flow was started for. No secret. |
| `startConnect`          | Takes `{ siteUrl }` (new, optional). `POST /v1/connections/:provider/start`.                                                            |
| `handleCallback`        | Receives the callback query; no `code`.                                                                                                |
| Invite proof cookie     | Required for **every** WordPress flow, dashboard ones too (see §3).                                                                    |
| Connection row          | `externalId` = site address, `displayName` = site name, `accessToken` = encrypted JSON `{siteUrl, apiRoot, username, password}`.        |
| Token model             | `one-time`, no expiry — like a Facebook Page token. A revoked password surfaces as 401 → needs reconnect.                               |
| Invite link             | Works. The landing page asks the client for their site address (`connectInput` on the invite view).                                     |

**No migration.** Two additive, optional members on `SocialProvider`: `connectInput` and
`credentialInCallback`.

## 3. Security review — where the application password travels and rests

| Stage                                 | Where the secret is                                               | What protects it                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WordPress → browser → our callback    | Query string of `GET /connect/callback`, over TLS                 | Unavoidable: it is how WordPress delivers it.                                                                                                                                                  |
| Our callback handler                  | In memory                                                         | Answered with a **303 to `/connect/done`** that carries only a sealed result — no page is ever rendered at the secret-bearing URL. `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. |
| Verification                          | `Authorization: Basic` to the site, over TLS, through `safeFetch` | Sent only to the REST root recorded when the flow **started**, never to an address from the callback. Redirects are never followed with credentials.                                          |
| At rest                               | `connections.access_token`                                        | AES-256-GCM via the existing `encryptToken` (`TOKEN_ENCRYPTION_KEY`). The username is inside the same ciphertext.                                                                              |
| `oauth_flows`                         | Never written there                                               | The flow row holds the site address only.                                                                                                                                                      |
| API responses, MCP, the dashboard     | Never returned                                                    | `ConnectionView` has no token field.                                                                                                                                                           |
| Publishing                            | Decrypted in the worker, sent as Basic auth through `safeFetch`   | Same guard on every request.                                                                                                                                                                   |

**What is logged.** Nothing of the callback. Fastify's logger is off (`logger: false`). The
request-log hook records only authenticated requests, and `/connect/callback` is unauthenticated;
it records the route _pattern_, and its fallback for an unmatched path now strips the query string
(a hardening made in this build — before it, an authenticated 404 logged its full URL). No error
of the credential branch is rethrown, so nothing reaches an error page. Error messages built by the
provider never include the username, the password or the stored blob (asserted in tests).

**Outside this app's control:** the reverse proxy and the browser. `deploy/Caddyfile.snippet` has
no `log` directive, and Caddy writes no access log without one — **confirm on the box** (§8). The
secret is in the browser's address bar for the instant between WordPress's redirect and ours; the
303 keeps it out of the rendered page's history entry in current browsers, which is the standard
mitigation, not a guarantee.

**Forged callbacks.** Anyone can type a URL at `/connect/callback`. What stops it attaching a site
to somebody's workspace:

1. `state` must be a UUID naming a `pending`, unexpired flow (10 minutes).
2. The request must carry the **proof cookie** of that flow — an HttpOnly, SameSite=Lax HMAC of
   the flow id, set on the browser that started the flow. For OAuth providers only invite flows
   need it; for WordPress every flow does, because there is no code exchange for a forgery to fail
   at, and the flow id is not secret (it is in the `success_url` the site is sent). Wrong or
   missing proof burns the flow.
3. The flow is **claimed atomically before the provider is asked anything** — one attempt per
   flow. A replayed, raced, or retried callback finds nothing.
4. `site_url` must equal the site the flow was started for (scheme, host, port, path; trailing
   slash and host case aside).
5. The credentials must work against that site's REST root, for a user who can publish.
6. The workspace is the flow's; nothing in the callback can name another.

The result page `/connect/done` is public and reads its result from the URL, so the result is
sealed with an HMAC (`signConnectOutcome`); an unsealed or altered link can only produce the
generic failure text. Failure reasons are a fixed vocabulary (`CONNECT_FAILURE_MESSAGES`), never
text from a query string.

**Residual risks, stated plainly.** (a) A site the person names is trusted to be theirs: a
malicious site can learn the flow id and present its own credentials, which connects _that_ site
— exactly what was asked for. (b) An application password is as powerful as its user and cannot be
scoped by core; connecting as an Administrator hands over administrator-level REST access. The
dialog asks for "someone who can publish posts"; recommend a dedicated Author or Editor account in
onboarding. (c) Reconnecting creates a new connection row rather than replacing the old one — the
existing behaviour for every provider.

## 4. SSRF — `packages/core/src/net/safe-fetch.ts`

The site address is user input that our server then calls. One utility, used for every request the
provider makes (discovery, verification, publishing, and downloading the featured image):

- **https only**, no credentials in the URL, **port 443 only** (overridable per call; a guard that
  lets any port through is a port scanner).
- Internal-looking names refused without a lookup: single-label names, `localhost`, `.local`,
  `.internal`, `.intranet`, `.lan`, `.home`, `.corp`, `.home.arpa`.
- **IP ranges refused**, IPv4: `0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16`
  (link-local, cloud metadata), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`,
  `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` (multicast), `240/4`
  (reserved, broadcast). IPv6: only global unicast `2000::/3` is allowed, minus documentation and
  Teredo; IPv4-mapped, NAT64 and 6to4 addresses are judged by the IPv4 address they embed;
  IPv4-compatible addresses and zone ids are refused.
- **Encodings:** the WHATWG URL parser folds decimal (`2130706433`), hex (`0x7f000001`), octal
  (`017700000001`) and short (`127.1`) IPv4 forms into dotted decimal before the range check, and
  the tests pin that for each form.
- The name is resolved **once**; **every** returned address must be public; the socket is
  **pinned** to the validated address through a `lookup` override, so a second DNS answer cannot
  swap it (DNS rebinding). TLS still verifies the certificate against the hostname.
- **Redirects** are never followed by the socket layer. `maxRedirects` (default 0) follows GET/HEAD
  only, each hop re-validated from scratch; `Authorization` never crosses origins. The provider
  uses 3 for discovery and image download and **0 for anything carrying the password**.
- Response size and total time are capped (2 MB / 15 s by default; one deadline across redirects).

**Finding, not fixed here:** `registerMediaFromUrl` (MCP `register_media_from_url`, REST
`POST /v1/media/register`) calls a bare `fetch` on a caller-supplied URL — the same vector, with
no guard. It should move onto `safeFetch`. It was left alone because that changes what the tool
accepts (http URLs, non-443 ports, hosts on a private network that a producer may be using today)
and needs the owner's call.

**Dev limitation:** with the disk storage driver, media URLs are `http://localhost:…`, which the
guard refuses — a featured image cannot be sent to WordPress from a local dev setup.

## 5. What an article is in our model

| WordPress field          | Ours                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `title`                  | `options.title` (arm `wordpress`), required, ≤ 300.                                             |
| `content`                | the variant's `caption`, **Markdown**, converted to HTML server-side.                           |
| `status`                 | `options.status`: `publish` (default) / `draft` / `pending` / `private`.                        |
| `slug`, `excerpt`        | `options.slug`, `options.excerpt`, optional.                                                    |
| `categories`, `tags`     | `options.categories`, `options.tags` — each a list of term ids or names.                        |
| `featured_media`         | the first image in `media`, uploaded to the site's library first.                               |
| `date`                   | never sent.                                                                                   |

**Body format: Markdown, converted by us, raw HTML escaped.** WordPress filters post content by
the author's capability, and Editors and Administrators have `unfiltered_html` on a single site —
so a `<script>` sent with their credentials would be stored as a script. Since an API key, an MCP
agent or a pasted document can put anything in the body, nothing a caller writes is allowed to
become markup: `articleMarkdownToHtml` (`packages/contracts/src/article-markdown.ts`, no
dependency) builds a fixed set of tags itself, escapes every attribute, and allows only http(s),
mailto and site-relative links and https images. The same function renders the Composer's preview,
so the preview is what is sent. Subset: headings, paragraphs, one-level lists, quotes, fenced code,
rules, bold, italic, inline code, links, images. Not supported: tables, nested lists, footnotes,
raw HTML, Gutenberg block markup (the article arrives as classic content; the block editor offers
"Convert to blocks").

**Length.** A social caption is capped at 5000; an article is not a caption. A WordPress
_variant's own_ `caption` may run to 100 000 characters; the shared group caption stays at 5000
because every other variant inherits it. The Composer puts a long body on the variant
automatically.

**Scheduling: ours, not WordPress's `future`.** One scheduler means the article is on the
Calendar, can be edited or cancelled until it goes, is retried and swept like every other post,
and its failure is visible here. Handing it to WordPress as `future` would make us report
"published" for something that has not happened, and WP-Cron only fires on site traffic — missed
schedules are a well-known WordPress failure that we could neither see nor retry. So `future` is
not offered and `date` is never sent. `options.status` answers a different question: what state
the article is created in when we send it. `draft`/`pending` hand it to the site's editors; our
post still reads `published` (sent), and the event log carries a notice that it is not public.

**Terms.** A tag name that does not exist is created (what WordPress's editor does). A category
name that does not exist fails the post: a typo must not quietly become a new category on a
client's site. Lookup is `GET /wp/v2/{tags|categories}?search=`, matched on the exact name.

**Featured image.** Downloaded from our stored media URL through `safeFetch` (≤ 20 MB; JPEG, PNG,
GIF, WebP), then `POST /wp/v2/media` with the raw bytes and `Content-Type` +
`Content-Disposition: attachment; filename="…"` — the two headers
[`WP_REST_Attachments_Controller`][attachments-src] requires for a raw upload. Everything that can
be refused (terms, image) happens before the article is created.

## 6. Provider contract fit

| Method                                  | WordPress                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `generateAuthUrl`                       | Discovery + the authorize URL. Takes `siteUrl`.                                                         |
| `authenticate`                          | Validates the callback, verifies the credentials, returns them packed as the access token.             |
| `listAccounts`                          | Not implemented: one site is one account (`isBetweenSteps: false`). Multisite is out of scope.         |
| `refreshToken`                          | Throws `ProviderAuthError`: an application password cannot be refreshed.                                |
| `assertPublishable`                     | One article; title; non-empty body ≤ 100 000; at most one media item and it must be an image.          |
| `post`                                  | Creates the post. `releaseUrl` = the post's `link`; `externalPostId` = its id.                         |
| `postAnalytics` / `accountAnalytics`    | Return `[]`. WordPress core has no analytics API (§9.3).                                               |

### Errors

| WordPress answers                                                              | We raise                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 401 (`incorrect_password`, `invalid_username`, `rest_not_logged_in`, …)        | `ProviderAuthError` → needs reconnect                                                         |
| 403 with a WordPress `code` (`rest_cannot_create`, `rest_cannot_publish`, …)   | `ProviderAuthError`                                                                          |
| 403 that is not JSON (a firewall page)                                         | `ProviderBadRequestError`, naming a firewall or security plugin                                |
| 404 / `rest_no_route`                                                          | `ProviderBadRequestError`, naming a disabled or restricted REST API                           |
| other 4xx                                                                      | `ProviderBadRequestError` with WordPress's `message` and the offending `data.params`           |
| 429, 5xx, connection failure, timeout before the request was sent              | `ProviderTransientError` (retried)                                                            |
| a 3xx on an authenticated call                                                 | `ProviderBadRequestError`: the site's address changed; reconnect                              |

**One deliberate departure from "timeouts are transient".** WordPress has no idempotency key. If
the `POST /wp/v2/posts` request was written to the socket and the answer never arrived, or arrived
as 2xx that is not JSON (PHP notices printed into the response are common), the article may exist.
Retrying would publish it twice on a client's site, so that one case is a final failure whose
message says to check the site first. The same timeout on a read, or before anything was sent, is
retried as usual. A 5xx on the create is still retried, per the brief — WordPress can return 500
_after_ saving when a plugin's hook fails, so this can still duplicate; see §8.

Sites where the REST API or application passwords are turned off get specific messages at connect
time: REST locked to logged-in users, no REST API found, `wp/v2` missing, application passwords
unavailable (naming Wordfence and Solid Security, which disable them by default), authorize screen
on another host, the site reporting a different address.

## 7. What is built

- **Contracts:** `wordpress` identifier, the options arm, `startConnectInput`, `connectInput` on
  the provider and invite views, `CAPTION_MAX` / `ARTICLE_BODY_MAX`, `articleMarkdownToHtml`.
- **Core:** `net/safe-fetch.ts`; `providers/wordpress/{client,wordpress}.ts`; connect service
  support for a site address, browser-bound flows and the sealed callback outcome; registration
  behind `WORDPRESS_ENABLED=true` (off by default).
- **API:** `POST /v1/connections/:provider/start`; the credential-bearing callback; `/connect/done`.
- **MCP:** no new tools — `create_post` / `add_to_queue` / `validate_post` / `update_post` take an
  article through `options`. See `MCP.md`.
- **Web:** a WordPress entry on Connections with a site-address dialog; the invite landing asks a
  client for their address; the Composer shows Title and article settings, names the text box for
  what is selected, and previews the article; Content and Calendar show the title.

## 8. Live bring-up checklist

Nothing here has run against a real site. Before `WORDPRESS_ENABLED=true` in production, on a
throwaway WordPress (6.x, https, pretty permalinks on), then on a real client site:

**Connect**

- [ ] Discovery: the front page sends the `Link` header on a `HEAD`; some hosts and CDNs answer
      HEAD differently from GET, or strip the header — confirm the `/wp-json/` fallback covers it.
- [ ] The index honours `_fields` and `authentication.application-passwords.endpoints.authorization`
      is present and on the same host.
- [ ] The authorize screen accepts our `app_id`, `success_url` and `reject_url` and shows
      "Meegrow Social".
- [ ] After Approve, the browser lands on `/connect/callback` **with `state` intact** and
      `site_url`, `user_login`, `password` appended; `site_url` equals the index's `url` exactly.
- [ ] The popup still has `window.opener` after visiting the site (a
      `Cross-Origin-Opener-Policy` header on wp-admin would sever it). If severed, the result page
      reads "Connected" but the Connections page does not refresh itself — the dialog's copy
      already says to press Refresh.
- [ ] The proof cookie arrives on the callback (SameSite=Lax, top-level GET, same site as
      `APP_URL`).
- [ ] `GET /wp/v2/users/me?context=edit` returns `capabilities` for an application-password
      request. If it returns 401 `rest_not_logged_in` with a valid password, the web server is
      dropping the `Authorization` header (common on Apache CGI/FastCGI) — a site-side fix.
- [ ] Reject sends back `error=access_denied`; a user without application passwords sends
      `error=disabled`.
- [ ] A site with Wordfence (default settings) produces the "Application Passwords are not
      available" message.
- [ ] A site without pretty permalinks connects through `?rest_route=/`.
- [ ] `connections.access_token` is ciphertext; nothing in `event_logs` or the Caddy logs contains
      the password. **Check the box's actual Caddyfile has no `log` for this site**, or add one
      that drops the query string for `/connect/callback`.
- [ ] The invite link path, opened in a browser with no session.

**Publish**

- [ ] A text-only article: appears with the title, the body renders as intended under the site's
      theme (classic content, `wpautop`), and `link` is the public permalink.
- [ ] `status: draft` creates a draft; what `link` is for a draft (expected: a `?p=` URL that is
      not public) and how that reads in our Content list.
- [ ] Featured image: the upload is accepted with our headers, the file name is kept, and the
      image shows as featured. Check the site's upload size limit against real media.
- [ ] Tags by name are found and created; an unknown category fails with our message; an Author
      (not Editor) can create tags.
- [ ] A scheduled article goes out at the time and appears on the Calendar.
- [ ] Revoke the application password on the site, publish: the post fails with the auth message
      and the connection reads "Needs reconnect".
- [ ] A slow site: confirm 30 s (API) and 90 s (upload) are enough, and what a real timeout on the
      create looks like. **Check for a duplicate after any 5xx on create.**
- [ ] A site behind Cloudflare or a WAF: confirm our user agent is not challenged.

Then re-record the fixtures in `providers/wordpress/wordpress.test.ts` from what was observed.

## 9. Not built, and what each needs

### 9.1 WordPress.com (OAuth2)

WordPress.com sites do not use application passwords for this; they use OAuth2 against
`public-api.wordpress.com` ([docs][wpcom-oauth]). It needs: an application registered at
developer.wordpress.com (client id and secret, our redirect URI); a second auth mode — a normal
code-exchange provider with no site address and no credential in the callback, most simply a
second provider (`wordpress-com`) sharing the article options arm and `articleMarkdownToHtml`; a
client for the WordPress.com REST API (`/rest/v1.1/sites/{site}/posts/new` or the `wp/v2` proxy
under `/wp/v2/sites/{site}`); and a site picker (`isBetweenSteps`) because one account can own
several sites. The token model there is a long-lived bearer token. Nothing in this build blocks
it: the options arm, the converter, the Composer and the list rendering are provider-agnostic.

### 9.2 Update and delete after publish

The competitor offers them. Our post lifecycle only edits before publish, for every platform.
WordPress supports both (`POST /wp/v2/posts/{id}`, `DELETE /wp/v2/posts/{id}` — trash by default,
`?force=true` to delete). It would need: two optional methods on `SocialProvider`
(`updatePublished`, `deletePublished`) and lifecycle decisions that are not WordPress-specific —
whether a published post becomes editable here, what status a deleted one has, whether the edit
history is kept, and what an edit means for a group whose other variants (Instagram, Facebook)
cannot be edited. We already store what the calls need (`externalPostId`). That is a product
decision for all providers, so it was reported rather than built.

### 9.3 Analytics

WordPress core exposes no views or visitors over REST; the only per-post number is the comment
count, which is not worth polling every site for. Both analytics methods return nothing, so the
Analytics pages show no data for WordPress rather than invented numbers. Options later: Jetpack
Stats (requires Jetpack on the site and a WordPress.com connection, i.e. §9.1's OAuth, then
`/sites/{site}/stats/post/{id}`), or Google Site Kit / Search Console / GA4 (a Google OAuth scope
and property mapping per site — the GA4 route overlaps with the Google client we already have).
Either is a per-site dependency the client has to install or grant.

## 10. Sources

- [Application Passwords: Integration Guide][guide] — parameters, the `authentication` key, https.
- [`wp-admin/authorize-application.php`][authorize-src] — what is appended to `success_url`, the
  reject path, `error=disabled`.
- [`wp-admin/includes/user.php`][user-src] — `wp_is_authorize_application_password_request_valid`,
  UUID `app_id`, redirect URL scheme rules.
- [`wp-admin/js/auth-app.js`][authapp-src] — the JS approve path.
- [`wp-includes/user.php`][wpuser-src] — `wp_authenticate_application_password` error codes;
  `wp_is_application_passwords_supported`.
- [`class-wp-rest-server.php`][server-src] — `get_index` fields.
- [REST API Handbook: Discovery][discovery]; [Authentication][auth]; [Posts][posts]; [Media][media];
  [Tags][tags]; [Users][users].
- [`class-wp-rest-attachments-controller.php`][attachments-src] — raw upload headers.
- [`class-wp-rest-terms-controller.php`][terms-src] — `term_exists` carries the existing `term_id`.
- [`wp-includes/rest-api.php`][restapi-src] — `rest_add_application_passwords_to_index`.
- [WordPress.com OAuth2][wpcom-oauth].

[guide]: https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/
[authorize-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-admin/authorize-application.php
[user-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-admin/includes/user.php
[authapp-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/js/_enqueues/admin/auth-app.js
[wpuser-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/user.php
[server-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/rest-api/class-wp-rest-server.php
[attachments-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/rest-api/endpoints/class-wp-rest-attachments-controller.php
[terms-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/rest-api/endpoints/class-wp-rest-terms-controller.php
[restapi-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/rest-api.php
[discovery]: https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/
[auth]: https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/
[posts]: https://developer.wordpress.org/rest-api/reference/posts/
[media]: https://developer.wordpress.org/rest-api/reference/media/
[tags]: https://developer.wordpress.org/rest-api/reference/tags/
[users]: https://developer.wordpress.org/rest-api/reference/users/
[wpcom-oauth]: https://developer.wordpress.com/docs/oauth2/
