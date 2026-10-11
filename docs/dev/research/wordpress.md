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

> **Second transport (added 2026-10-11):** a site whose host switches Application Passwords off
> cannot use any of the above. It can be connected with a WordPress **username and login
> password over XML-RPC** instead — §11. That one _does_ store a login password, and §11.3 is its
> security review.

---

## 1. Scope

In: self-hosted WordPress, and any WordPress that exposes the core REST API (`wp/v2`) with
Application Passwords, served over https. Create an article — now, scheduled, or as a draft in our
app.

Out, with what each would take: WordPress.com OAuth (§9.1), update and delete after publish (§9.2),
analytics (§9.3), a plugin API-key transport (§11.9), multisite, uploading inline images.

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

**Separate addresses.** WordPress has two address settings: WordPress Address (`siteurl` — where
wp-admin, the authorize screen and `xmlrpc.php` live) and Site Address (`home` — what visitors
see, and what the REST root is built from). They may be on different hosts. Discovery used to
refuse any second host; it now accepts one **only on mutual evidence** (§11.4), so such a site can
be entered by either address.

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

XML-RPC sources are listed with §11.

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

## 11. Username and password over XML-RPC

_Added 2026-10-11. Like the rest of this note: **no request was made to any WordPress site**. The
shapes come from the XML-RPC WordPress API reference and WordPress core's source (§11.10), and the
tests replay fixtures built from them (marked documentation-built). §11.7 is what a first live
connect must confirm._

### 11.1 Why

The first site anyone tried to connect could not use §2 at all:

- its REST index reports `authentication: []` and the Application Passwords section is absent
  from `profile.php` — the host disables the feature (`501 application_passwords_disabled`);
- its two addresses are on different hosts, and discovery refused that outright — entering the
  public address said "enter the other one", and entering the other one said "different host";
- `xmlrpc.php` answers on both addresses.

Neither a new password nor anything the client can click fixes the first point. XML-RPC is the
one core interface left that authenticates without the `Authorization` header.

### 11.2 The transport ladder

| Order | Transport                                   | Credential                              | Works when                                                    | Cannot do                                             |
| ----- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| 1     | REST + Application Password (`rest`)        | a password WordPress issues for THIS app | application passwords enabled; https                          | —                                                     |
| 2     | XML-RPC + login password (`xmlrpc`)         | the user's real login password          | `xmlrpc.php` reachable and enabled                            | plugin-owned meta (§11.8); scoped or revocable access |
| 3     | A plugin with its own API-key header (§11.9) | a key the plugin issues                 | the client installs the plugin                                | not built                                             |

`rest` stays the recommendation wherever the site offers it: the credential is separate from the
person's login, is named on their profile, and can be revoked without changing a password. The
dialog selects it by default and only offers `xmlrpc` first when approval is unavailable.

The transport is recorded **inside the encrypted credential** (`transport: 'rest' | 'xmlrpc'`);
`WordPressProvider.post` dispatches on it. A credential written before this existed has no
`transport` and reads as `rest`. **No migration:** the method is also copied, in the clear, to the
existing `connections.meta` JSON column (`{ method: 'password', endpoint }`) so a list can show it
without decrypting anything. Rolling back to a build without XML-RPC leaves such a connection
unreadable to that build ("stored credentials are unreadable — reconnect"), not broken data.

### 11.3 Security review — where the LOGIN password travels and rests

This is a weaker arrangement than §3 and the dialog says so before a field can be typed in: it is
the password that user signs in with, it cannot be scoped, and revoking it means changing it.

| Stage                         | Where the secret is                                              | What protects it                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser                       | React state of the form                                          | Cleared when the site refuses it and when the request succeeds; gone when the dialog closes. Not written to storage. `autocomplete="off"` — a browser may still offer to save it.              |
| Browser → our API             | JSON body of `POST /v1/connections/:provider/password`, over TLS | Sent once. Session or API key required; a cookie-authenticated request from another origin is refused. Never in a URL.                                                                       |
| Our API handler               | In memory                                                        | See "what is logged" below.                                                                                                                                                                  |
| Our API → the site            | Parameters of an XML-RPC `methodCall`, over TLS, via `safeFetch` | Sent only to the endpoint sealed by the site check (§11.5). https only, port 443, public addresses, pinned DNS. **Redirects are never followed.** No `Authorization` header is involved.       |
| At rest                       | `connections.access_token`                                       | AES-256-GCM via the existing `encryptToken`. The username is inside the same ciphertext. `connections.meta` holds the method and the endpoint only.                                           |
| API responses, MCP, dashboard | Never returned                                                   | The route answers `{ connectionId, displayName, externalId, endpoint }` or `{ error, code }`. `ConnectionView` has no token field.                                                            |
| Publishing                    | Decrypted in the worker, sent as XML-RPC parameters              | Same guard on every request.                                                                                                                                                                 |

**What is logged.** Nothing of the body. Fastify's logger is off; the request-log hook records
the route _pattern_ and the status. Three places that would otherwise repeat a password back, and
what closes each (all asserted in `apps/api/src/wordpress-password.test.ts`):

1. **A validation error.** A zod error can quote the value it rejected. The route answers a body
   that fails validation with one fixed sentence.
2. **Fastify's default error handler**, which answers with `error.message` — and a JSON parse
   error's message quotes the body it could not parse. The route has its own `errorHandler` that
   answers a fixed sentence. Removing it makes two tests fail (checked).
3. **The site itself.** A fault's text is the one string here this app did not write, and the
   site has just been sent the password. The stored password is removed from any fault text
   before it can reach a post's error or the event log. Connect-time failures never carry site
   text at all: they are codes from `CONNECT_FAILURE_MESSAGES`.

**Brute force.** This server is the one sending the guess, at a site that never asked to be
tested. `beginSiteLoginAttempt` counts before the site is asked anything, in the existing attempt
store (Redis in production, in-process fallback):

| Counted per                                  | Limit        | Stops                                                  |
| -------------------------------------------- | ------------ | ------------------------------------------------------ |
| site (host the login goes to), all callers   | 5 an hour    | anyone getting more than 120 guesses a day at one site |
| caller (user, or an API key's client)        | 10 an hour   | one account spraying a password across many sites      |
| client address                               | 20 an hour   | the same from one address across accounts              |

Only a login the site **accepted** gives its attempt back, and it never clears a counter (or one
known login would buy unlimited guesses at another). A wrong password, a firewall page and a site
that did not answer all stay counted — each is a request made at somebody's login. The cost: five
failures lock everyone out of connecting that site for up to an hour.

**Residual risks, stated plainly.** (a) A login password is as powerful as its user; an
Administrator's is the whole site, including its users and plugins. The form says to create a
dedicated Editor or Author. Nothing here can enforce that — an administrator's login is accepted.
(b) There is nothing on the site that names this app; "revoke" means changing that user's
password or deleting the user. (c) Two-factor plugins generally do not apply to XML-RPC, which is
why many hosts and security plugins block it; a site that does will show as "blocked". (d) The
site check and the login are unauthenticated-then-authenticated requests our server makes on an
operator's say-so, to any public https host — the same exposure as §2's discovery, now including
one login attempt, bounded by the limits above. (e) API keys can call the route, like the other
connect routes; it is not exposed over MCP.

**Invite links: not offered.** A client opening an invite link is not asked for a password. The
public invite path still offers approval only, and there is no public route that accepts a login
(asserted). If their site cannot be approved, the operator connects it from the dashboard. Whether
a client should ever type a WordPress password into our page is a product decision that was left
open rather than defaulted to yes.

### 11.4 Address handling

`WordPressClient.inspect` replaces the dead ends. A second host is accepted only on **mutual
evidence**, never on one side's say-so:

- the entered host's front page advertises a REST root on another host **and** the index served
  there names the entered host as its `url` or `home`; or
- the index names another host **and** that host's own front page advertises the _same_ REST
  root.

Every one of those requests is a new address to the SSRF guard (§4). A host that fails the test
is never contacted with credentials, and its claimed address is not shown as the site's. For
approval, the authorize screen must be on a confirmed host. For XML-RPC, candidates are tried in
this order, each probed **without credentials** (`system.listMethods`):

1. `xmlrpc.php` under the address the person entered;
2. `xmlrpc.php` under the WordPress Address, if confirmed and different;
3. only when the REST index could not say where WordPress lives: the `<link rel="EditURI">` on
   the entered page (`rsd_link()`), **same host only**.

After a login succeeds, the site's own `home_url` / `blog_url` (`wp.getOptions`) are used for the
connection's address only where they agree with a host already confirmed.

### 11.5 The connect flow

1. `POST /v1/connections/:provider/site-check { siteUrl }` → what §11.4 found: approval available
   or why not, a login possible or why not, both addresses, and the exact endpoint a login would
   be sent to. When a login is possible the answer carries a **ticket**: that endpoint, sealed
   (HMAC, its own key label) for this workspace and provider, good for 15 minutes.
2. The dialog shows the endpoint and the warning copy, then
   `POST /v1/connections/:provider/password { ticket, username, password }`.
3. Core opens the ticket (wrong workspace, altered, expired → `check_expired`, nothing contacted),
   counts the attempt, then `wp.getProfile` at the sealed endpoint. So the address the password
   goes to is always one this server found and the person was shown — never one from a request
   body, and never the result of a second, different discovery.
4. **Capability.** XML-RPC has no "what can I do" call. `wp.getProfile` returns roles;
   `administrator`, `editor` and `author` are accepted, `contributor` and `subscriber` refused.
   **A user with only custom roles is refused too** — what such a role allows cannot be read, and
   the alternative is finding out at publish time.
5. `wp.getOptions` for the site's title and addresses (best effort), then the connection is
   created with `meta.method = 'password'`. The Connections row reads "WordPress · password · …".

### 11.6 Publishing

Same article model, same `articleMarkdownToHtml`, same rules as §5–§6, carried by `wp.newPost`.

| Ours                 | XML-RPC                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| title, body, status  | `post_title`, `post_content`, `post_status` (`publish` / `draft` / `pending` / `private`)            |
| slug, excerpt        | `post_name`, `post_excerpt`                                                                          |
| categories           | **`terms.category` — ids.** Names are looked up with `wp.getTerms`; an unknown one fails the post.   |
| tags                 | `terms_names.post_tag` (created if missing, as REST does); numeric ids go in `terms.post_tag`        |
| featured image       | `wp.uploadFile` (base64 in the request), then `post_thumbnail`                                       |

- **`terms_names` is never used for categories**: it would create one from a typo, and it faults
  on a name that appears twice in the hierarchy.
- **`overwrite` is never sent to `wp.uploadFile`**: with it WordPress deletes an existing
  attachment of the same name on a live site.
- **Read-back.** `wp.newPost` answers with an id and nothing else, and an id says a post was
  made, not what was stored. The post is read back with `wp.getPost`; the permalink, the status,
  the featured image and the terms reported come from that. A difference becomes a notice on the
  event log. An id whose post is not there is a failure. If the read-back itself fails, the post
  is reported as created with a notice that it is **not confirmed** — it must not be retried.
- **Duplicate safety** is §6's rule unchanged: no answer after the create was sent, or a 2xx that
  is not XML-RPC, is final ("may or may not have been created — check the site"). A 5xx is
  retried, with §6's caveat.
- **Errors.** WordPress sends faults with HTTP 200 (405 for "XML-RPC services are disabled").
  Fault 403 "Incorrect username or password" → needs reconnect. 403 is also used for refused
  arguments and its text is translated, so an unrecognised 403 is settled by one `wp.getProfile`
  call, where 403 can only mean the login. Fault 401 → the user may not do this (auth). 405, a
  firewall page, a missing endpoint → final, with the cause named.
- **Upload size.** The image travels base64-encoded inside the request, about a third larger. PHP
  discards a body over `post_max_size` and WordPress then reports malformed XML; that fault on an
  upload is reported as "probably larger than the site's upload limit".

### 11.7 Live bring-up checklist — `https://jaipureyedental.com/blog`

Nothing here has run. On that site (admin at `https://blog.jaipureyedental.com`, Hostinger):

**Before**

- [ ] In WordPress, create a user for this (Editor or Author), not the administrator account.
      Note whose byline articles should carry — see §11.8.

**Site check**

- [ ] Enter the **public** address. Expect: approval "not available", both addresses shown, a
      login offered at `https://jaipureyedental.com/blog/xmlrpc.php`.
- [ ] Enter the **admin** address. Expect the same site, a login offered at
      `https://blog.jaipureyedental.com/xmlrpc.php`. Neither should be an error.
- [ ] Does the admin host's front page really send the `Link` header on a `HEAD`? If a CDN strips
      it, the public address shows "says its address is … enter that instead" — the mutual check
      failing safe. Record which.
- [ ] `system.listMethods` is answered without credentials and lists `wp.newPost`. If Hostinger
      or a plugin hides it, the state is "unknown" and a login is still offered — confirm.

**Login**

- [ ] The right login connects; the row reads "WordPress · password".
- [ ] A wrong password says "did not accept that username and password" and the field empties.
      Check the site's own login limiter did not lock our server's address after it.
- [ ] `wp.getProfile` returns `roles` for that user. A Contributor is refused.
- [ ] `wp.getOptions` returns `blog_title`, `home_url`, `blog_url`; the connection's address is the
      public one.
- [ ] `connections.access_token` is ciphertext; `connections.meta` has the method and endpoint
      only; nothing in `event_logs` or the Caddy logs contains the password.
- [ ] Six wrong logins in an hour: the sixth is refused by us and never reaches the site.

**Publish**

- [ ] A draft first (`status: draft`). The read-back returns a `link` — record what it is for a
      draft — and the event log carries the "not public" notice.
- [ ] A published article: the body renders as intended and `link` is the public permalink under
      `/blog/`.
- [ ] A category by name that exists is attached; a misspelt one fails **without** creating a
      category. (This site has 51 categories, some near-duplicates and some that belong to
      another business — pick names from the list, do not invent.)
- [ ] A new tag is created; an existing one is reused.
- [ ] Featured image: uploaded once, attached, and nothing in the library was overwritten. Try
      one near the host's `post_max_size`.
- [ ] Change the user's password on the site, publish: the post fails with the auth message and
      the connection reads "Needs reconnect".
- [ ] Open the article in wp-admin: the SEO plugin's panel is **empty**. That is §11.8, not a bug.

Then re-record the fixtures in `providers/wordpress/wordpress.xmlrpc.test.ts`.

### 11.8 What XML-RPC cannot do

- **Plugin-owned SEO fields.** `wp.newPost` accepts `custom_fields`, returns a post id, and
  silently stores nothing for keys a plugin registered with its own auth callback (Rank Math's
  title, description and focus keyword are the known case). This build sends no `custom_fields`
  at all rather than appear to. An article arrives with its SEO panel unfilled.
- **Authorship.** The article is published as the connected user. Publishing as a named author
  (`post_author`) needs `edit_others_posts` and an author option the article model does not have.
  Until then the dedicated user's display name is the byline — choose it deliberately.
- **Scoped or revocable access**, and anything on the site that names this app.
- **Capabilities.** Only roles can be read (§11.5).
- Multisite, and a site whose character set is not UTF-8 (responses are decoded as UTF-8).

### 11.9 Not built: a plugin API-key transport

A plugin that authenticates with its own header (Royal MCP's `X-Royal-MCP-API-Key` is the one
seen working on this site) passes hosts that disable application passwords _and_ strip
`Authorization`, and writes plugin-owned meta server-side, where §11.8's wall does not apply. It
would need:

- a third `transport` value and credential shape (`{ endpoint, apiKey }`) — the union in
  `client.ts` and the dispatch in `post()` are already shaped for it;
- a third connect method in the dialog: the client installs the plugin and pastes a key. A key is
  a better secret than a login password (issued for this, revocable on its own) but the plugin
  grants broad control of the install, which the copy must say;
- a client for that plugin's API and a **capability probe at connect** (can it write SEO fields,
  upload media, set terms) so a post that needs one says so before publish;
- the same read-back rule: write the SEO fields, read them back, fail naming the ones that did
  not persist;
- SEO fields in the article options arm — which is what makes it worth building at all;
- a decision on depending on a third-party plugin per client site.

### 11.10 Sources (XML-RPC)

- [XML-RPC WordPress API][xmlrpc-api] and its pages for [Posts][xmlrpc-posts]
  (`wp.newPost`, `wp.getPost`), [Taxonomies][xmlrpc-tax] (`wp.getTerms`), [Media][xmlrpc-media]
  (`wp.uploadFile`), [Users][xmlrpc-users] (`wp.getProfile`, `wp.getUsersBlogs`) and
  [Options][xmlrpc-options] (`wp.getOptions`).
- [`class-wp-xmlrpc-server.php`][xmlrpc-src] — the methods, their fault codes, `login()`,
  `_insert_post` (terms and `terms_names`), the 405 for a disabled server.
- [`wp-includes/IXR/`][ixr-src] — the wire layout the fixtures are written in.
- [XML-RPC specification][xmlrpc-spec].
- [`rsd_link()`][rsd-src] — the `EditURI` link.

[xmlrpc-api]: https://codex.wordpress.org/XML-RPC_WordPress_API
[xmlrpc-posts]: https://codex.wordpress.org/XML-RPC_WordPress_API/Posts
[xmlrpc-tax]: https://codex.wordpress.org/XML-RPC_WordPress_API/Taxonomies
[xmlrpc-media]: https://codex.wordpress.org/XML-RPC_WordPress_API/Media
[xmlrpc-users]: https://codex.wordpress.org/XML-RPC_WordPress_API/Users
[xmlrpc-options]: https://codex.wordpress.org/XML-RPC_WordPress_API/Options
[xmlrpc-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/class-wp-xmlrpc-server.php
[ixr-src]: https://github.com/WordPress/wordpress-develop/tree/trunk/src/wp-includes/IXR
[xmlrpc-spec]: http://xmlrpc.com/spec.md
[rsd-src]: https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/general-template.php
