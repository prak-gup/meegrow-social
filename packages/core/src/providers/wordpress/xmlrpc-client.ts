import {
  ConnectError,
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import { safeFetch, type SafeResponse } from '../../net/safe-fetch.js';
import {
  API_MAX_BYTES,
  API_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  maybeCreated,
  plainText,
  transportFailure,
  UPLOAD_TIMEOUT_MS,
  USER_AGENT,
  type WordPressFetch,
} from './client.js';
import {
  asArray,
  asId,
  asStruct,
  decodeMethodResponse,
  encodeMethodCall,
  XmlRpcParseError,
  type XmlRpcStruct,
  type XmlRpcValue,
} from './xmlrpc.js';

/**
 * WordPress's XML-RPC API (`xmlrpc.php`) for the wordpress provider: the transport for sites where
 * Application Passwords are switched off. Methods, shapes and sources are in
 * docs/dev/research/wordpress.md §11; NOTHING here has run against a real site.
 *
 * Every call carries the user's login name and password as its first parameters — XML-RPC has no
 * other way to authenticate. So, without exception:
 *  - POST only, through `safeFetch` (https only, port 443, public addresses, pinned DNS);
 *  - `maxRedirects` is never set: a request carrying the password is never replayed anywhere else,
 *    and a 3xx is an error to report, not an instruction to follow;
 *  - no error built here contains the username, the password or the request body.
 */

/** Who to log in as, and where. `endpoint` is the full `…/xmlrpc.php` URL. */
export interface XmlRpcLogin {
  endpoint: string;
  username: string;
  password: string;
}

/**
 * The first parameter of every `wp.*` method. A single site ignores it; multisite (out of scope)
 * picks the blog by the URL, not by this.
 */
const BLOG_ID = 1;

/** WordPress's own roles that carry `publish_posts` (wp-admin/includes/schema.php). */
const PUBLISHING_ROLES = new Set(['administrator', 'editor', 'author']);

/** What a call came back as, before anyone decides what it means. */
type Outcome =
  | { type: 'value'; value: XmlRpcValue }
  /** A well-formed XML-RPC fault. `status` is the HTTP status it arrived with. */
  | { type: 'fault'; code: number; message: string; status: number }
  /** An HTTP error with no XML-RPC answer in it. */
  | { type: 'http'; status: number }
  /** A success status, but the body is not XML-RPC: a firewall page, PHP output, a login form. */
  | { type: 'garbled'; status: number }
  | { type: 'redirect' };

export interface XmlRpcCallOptions {
  timeoutMs?: number;
  /** See `WordPressRequest.creates`: a call that makes something and cannot be told "retry". */
  creates?: string;
  /**
   * True for a method whose only possible fault 403 is "Incorrect username or password." — a login
   * check. For any other method a 403 is ambiguous (WordPress also uses it for "Invalid post
   * type." and friends), and its text is translated on a non-English site, so the client settles
   * it by asking again with a method where 403 can only mean one thing.
   */
  loginOnly?: boolean;
}

/** What unauthenticated probing learned about an `xmlrpc.php`. */
export type XmlRpcEndpointState =
  /** Answers XML-RPC and lists the methods publishing needs. */
  | 'available'
  /** Answers XML-RPC but would not list its methods; a login may still work. */
  | 'unknown'
  /** WordPress says XML-RPC is switched off (fault or HTTP 405). */
  | 'disabled'
  /** Something in front of WordPress answered instead: a firewall, a security plugin. */
  | 'blocked'
  | 'not_found'
  | 'unreachable';

export interface XmlRpcProfile {
  userId: number | null;
  username: string;
  displayName: string;
  roles: string[];
}

export interface XmlRpcSiteOptions {
  title: string;
  /** Site Address (`home`): what visitors type. */
  homeUrl: string | null;
  /** WordPress Address (`siteurl`): where wp-admin and xmlrpc.php live. */
  siteUrl: string | null;
}

/** What `wp.getPost` says is stored. Used to confirm a write, never assumed from the request. */
export interface XmlRpcStoredPost {
  id: number;
  status: string;
  type: string;
  link: string | null;
  /** The attachment id of the featured image, or null when the post has none. */
  thumbnailId: number | null;
  /** Term ids by taxonomy, as stored. */
  terms: Record<string, number[]>;
}

const REQUIRED_METHODS = ['wp.newPost', 'wp.getPost', 'wp.getProfile'];

/**
 * A fault's own text, for a person to read. It is the one thing here this app did not write, and
 * the site that wrote it has just been sent the password — so a site (or a plugin's debug output)
 * that repeats the request back must not get the password into a post's error or the event log.
 */
function says(fault: { code: number; message: string }, secret?: string): string {
  const raw = secret ? fault.message.split(secret).join('[removed]') : fault.message;
  const text = plainText(raw);
  return text ? `WordPress says: ${text} [${fault.code}]` : `XML-RPC fault ${fault.code}`;
}

const DISABLED =
  'XML-RPC is switched off on this site — by WordPress, a security plugin or the host. Turn it ' +
  'back on for xmlrpc.php, or connect the site another way.';
const BLOCKED =
  'Something in front of WordPress answered instead of xmlrpc.php — a firewall or security ' +
  'plugin is blocking XML-RPC requests from this server.';

export class WordPressXmlRpcClient {
  private readonly fetchImpl: WordPressFetch;

  constructor(config: { fetchImpl?: WordPressFetch } = {}) {
    this.fetchImpl = config.fetchImpl ?? ((url, options) => safeFetch(url, options));
  }

  /** One POST to `xmlrpc.php`. Throws only for a request that produced no answer at all. */
  private async exchange(
    endpoint: string,
    method: string,
    params: readonly XmlRpcValue[],
    options: XmlRpcCallOptions,
  ): Promise<Outcome> {
    let response: SafeResponse;
    try {
      // No maxRedirects: the password is in the body, and it goes to this address or nowhere.
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset=utf-8',
          accept: 'text/xml',
          'user-agent': USER_AGENT,
        },
        body: encodeMethodCall(method, params),
        timeoutMs: options.timeoutMs ?? API_TIMEOUT_MS,
        maxResponseBytes: API_MAX_BYTES,
      });
    } catch (err) {
      throw transportFailure(err, options.creates);
    }
    if (response.status >= 300 && response.status < 400) return { type: 'redirect' };
    // WordPress answers a fault with HTTP 200 — except "XML-RPC services are disabled", which it
    // sends as HTTP 405 with the fault still in the body. So the body is read at any status.
    try {
      const decoded = decodeMethodResponse(response.body.toString('utf8'));
      return decoded.fault
        ? { type: 'fault', code: decoded.code, message: decoded.message, status: response.status }
        : response.status < 300
          ? { type: 'value', value: decoded.value }
          : { type: 'http', status: response.status };
    } catch (err) {
      if (!(err instanceof XmlRpcParseError)) throw err;
      return response.status < 300
        ? { type: 'garbled', status: response.status }
        : { type: 'http', status: response.status };
    }
  }

  /**
   * Call a method as a user. Returns the decoded value; every other outcome throws from the
   * provider taxonomy:
   *  - wrong username or password → auth (the saved login no longer works: reconnect);
   *  - fault 401, "you are not allowed to…" → auth (reconnect as a user who may);
   *  - XML-RPC switched off, a firewall, a missing endpoint, a refused argument → bad request;
   *  - fault 500, HTTP 429/5xx, no answer before the request was sent → transient.
   */
  async call(
    login: XmlRpcLogin,
    method: string,
    params: readonly XmlRpcValue[],
    options: XmlRpcCallOptions = {},
  ): Promise<XmlRpcValue> {
    const outcome = await this.exchange(
      login.endpoint,
      method,
      [BLOG_ID, login.username, login.password, ...params],
      options,
    );
    if (outcome.type === 'value') return outcome.value;
    if (
      outcome.type === 'fault' &&
      outcome.code === 403 &&
      (await this.isLoginFailure(login, outcome.message, options))
    ) {
      throw new ProviderAuthError(
        'The site no longer accepts the saved username and password. ' +
          `${says(outcome, login.password)}. Reconnect the site.`,
      );
    }
    throw failure(outcome, method, options.creates, login.password);
  }

  private async isLoginFailure(
    login: XmlRpcLogin,
    message: string,
    options: XmlRpcCallOptions,
  ): Promise<boolean> {
    if (options.loginOnly || /incorrect username or password/i.test(message)) return true;
    // Ambiguous: ask once more with a method that can only answer 403 for a bad login.
    const check = await this.exchange(
      login.endpoint,
      'wp.getProfile',
      [BLOG_ID, login.username, login.password, ['user_id']],
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
    ).catch(() => null);
    return check?.type === 'fault' && check.code === 403;
  }

  /**
   * Is there a working XML-RPC server at `endpoint`? Asked without credentials
   * (`system.listMethods`), so the person can be told BEFORE they type a password anywhere.
   */
  async probe(endpoint: string): Promise<XmlRpcEndpointState> {
    let outcome: Outcome;
    try {
      outcome = await this.exchange(endpoint, 'system.listMethods', [], {
        timeoutMs: DISCOVERY_TIMEOUT_MS,
      });
    } catch {
      return 'unreachable';
    }
    switch (outcome.type) {
      case 'value': {
        const methods = asArray(outcome.value);
        if (!methods) return 'blocked';
        return REQUIRED_METHODS.every((m) => methods.includes(m)) ? 'available' : 'disabled';
      }
      case 'fault':
        // A site may hide its method list (-32601) and still accept a login.
        return outcome.code === 405 ? 'disabled' : 'unknown';
      case 'http':
        if (outcome.status === 405) return 'disabled';
        if (outcome.status === 404 || outcome.status === 410) return 'not_found';
        return outcome.status >= 500 || outcome.status === 429 ? 'unreachable' : 'blocked';
      case 'garbled':
        return 'blocked';
      case 'redirect':
        return 'not_found';
    }
  }

  /**
   * Check a username and password the person typed, and that the user can publish. Used at connect
   * time only, so every failure is a `ConnectError` from the fixed vocabulary — never WordPress's
   * own text, and never anything that was submitted.
   *
   * XML-RPC has no "what can I do" call. `wp.getProfile` returns the user's roles, and the three
   * roles WordPress ships that can publish are accepted; a contributor or subscriber is refused,
   * and so is a user with only custom roles, because what such a role allows cannot be read.
   */
  async verifyLogin(login: XmlRpcLogin): Promise<XmlRpcProfile> {
    let outcome: Outcome;
    try {
      outcome = await this.exchange(
        login.endpoint,
        'wp.getProfile',
        [BLOG_ID, login.username, login.password, ['user_id', 'username', 'display_name', 'roles']],
        { timeoutMs: DISCOVERY_TIMEOUT_MS },
      );
    } catch (err) {
      throw new ConnectError(err instanceof ProviderTransientError ? 'site_unreachable' : 'failed');
    }
    if (outcome.type !== 'value') throw new ConnectError(connectFailure(outcome));
    const profile = asStruct(outcome.value);
    if (!profile) throw new ConnectError('xmlrpc_blocked');
    const roles = (asArray(profile.roles) ?? []).filter((r): r is string => typeof r === 'string');
    if (!roles.some((role) => PUBLISHING_ROLES.has(role))) {
      throw new ConnectError('role_cannot_publish');
    }
    return {
      userId: asId(profile.user_id),
      username: typeof profile.username === 'string' ? profile.username : login.username,
      displayName: plainText(profile.display_name),
      roles,
    };
  }

  /** The site's name and its two addresses, as the logged-in site itself reports them. */
  async siteOptions(login: XmlRpcLogin): Promise<XmlRpcSiteOptions> {
    const value = await this.call(login, 'wp.getOptions', [['blog_title', 'home_url', 'blog_url']]);
    const options = asStruct(value) ?? {};
    const read = (name: string): string | null => {
      const option = asStruct(options[name])?.value;
      return typeof option === 'string' && option !== '' ? option : null;
    };
    return {
      title: plainText(read('blog_title')),
      homeUrl: read('home_url'),
      siteUrl: read('blog_url'),
    };
  }

  /**
   * The id of the term with exactly this name (case aside), or null. `search` is a substring
   * match, like the REST one, so the exact comparison is done here.
   */
  async findTerm(
    login: XmlRpcLogin,
    taxonomy: 'category' | 'post_tag',
    name: string,
  ): Promise<number | null> {
    const value = await this.call(login, 'wp.getTerms', [
      taxonomy,
      { search: name, number: 100, hide_empty: false },
    ]);
    const wanted = name.trim().toLowerCase();
    for (const item of asArray(value) ?? []) {
      const term = asStruct(item);
      if (term && plainText(term.name).toLowerCase() === wanted) return asId(term.term_id);
    }
    return null;
  }

  /**
   * Upload a file to the media library. `overwrite` is deliberately never sent: with it WordPress
   * DELETES an existing attachment of the same name, on somebody's live site.
   */
  async uploadFile(
    login: XmlRpcLogin,
    file: { name: string; type: string; bits: Buffer },
  ): Promise<number> {
    let value: XmlRpcValue;
    try {
      value = await this.call(
        login,
        'wp.uploadFile',
        [{ name: file.name, type: file.type, bits: file.bits }],
        { timeoutMs: UPLOAD_TIMEOUT_MS },
      );
    } catch (err) {
      // PHP discards a request body over its `post_max_size`, and WordPress then reports the
      // empty body as malformed XML. For an upload that almost always means "too big".
      if (err instanceof XmlRpcFaultError && err.code === -32700) {
        throw new ProviderBadRequestError(
          'The site could not read the featured image upload — the image is probably larger ' +
            'than the site’s upload limit (PHP post_max_size). Use a smaller image.',
        );
      }
      throw err;
    }
    const id = asId(asStruct(value)?.id) ?? asId(asStruct(value)?.attachment_id);
    if (id === null) {
      throw new ProviderBadRequestError('WordPress did not return an id for the uploaded image');
    }
    return id;
  }

  /** Create a post. Returns its id — which says WordPress made one, not what it stored. */
  async newPost(login: XmlRpcLogin, content: XmlRpcStruct): Promise<number> {
    const value = await this.call(login, 'wp.newPost', [content], { creates: 'The article' });
    const id = asId(value);
    if (id === null) {
      throw new ProviderBadRequestError(
        'WordPress accepted the article but did not say which one it is — check the site before ' +
          'retrying, so it is not published twice.',
      );
    }
    return id;
  }

  /** What the site has stored for a post, or null when it says there is no such post. */
  async getPost(login: XmlRpcLogin, id: number): Promise<XmlRpcStoredPost | null> {
    let value: XmlRpcValue;
    try {
      value = await this.call(login, 'wp.getPost', [
        id,
        ['post_id', 'post_status', 'post_type', 'link', 'post_thumbnail', 'terms'],
      ]);
    } catch (err) {
      if (err instanceof XmlRpcFaultError && err.code === 404) return null;
      throw err;
    }
    const post = asStruct(value);
    const storedId = asId(post?.post_id);
    if (!post || storedId === null) return null;
    const terms: Record<string, number[]> = {};
    for (const item of asArray(post.terms) ?? []) {
      const term = asStruct(item);
      const termId = asId(term?.term_id);
      if (!term || termId === null || typeof term.taxonomy !== 'string') continue;
      (terms[term.taxonomy] ??= []).push(termId);
    }
    // `post_thumbnail` is the attachment as a struct, or an empty array when there is none.
    const thumbnail = asStruct(post.post_thumbnail);
    return {
      id: storedId,
      status: typeof post.post_status === 'string' ? post.post_status : '',
      type: typeof post.post_type === 'string' ? post.post_type : '',
      link: typeof post.link === 'string' && post.link !== '' ? post.link : null,
      thumbnailId: asId(thumbnail?.attachment_id) ?? asId(thumbnail?.id),
      terms,
    };
  }
}

/**
 * A fault WordPress sent that is a bad request in the taxonomy, with its code kept for callers
 * that branch on it (a missing post, an unreadable upload).
 */
export class XmlRpcFaultError extends ProviderBadRequestError {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Map a non-value outcome onto the provider error taxonomy. Wrong-login is handled by `call`. */
function failure(
  outcome: Exclude<Outcome, { type: 'value' }>,
  method: string,
  creates?: string,
  secret?: string,
): Error {
  const tail = creates ? ` ${maybeCreated(creates)}` : '';
  switch (outcome.type) {
    case 'redirect':
      return new ProviderBadRequestError(
        'The site answered an XML-RPC request with a redirect, so its address has changed. ' +
          'Reconnect the site using its current https address.',
      );
    case 'garbled':
      return new ProviderBadRequestError(
        'The site answered, but not with the XML-RPC WordPress sends (a firewall, a security ' +
          `plugin or a PHP error is adding output to xmlrpc.php).${tail}`,
      );
    case 'http':
      if (outcome.status === 405) return new ProviderBadRequestError(DISABLED);
      if (outcome.status === 403 || outcome.status === 401) {
        return new ProviderBadRequestError(BLOCKED);
      }
      if (outcome.status === 404 || outcome.status === 410) {
        return new ProviderBadRequestError(
          'There is no xmlrpc.php at the address this site was connected with. Reconnect the site.',
        );
      }
      if (outcome.status === 429 || outcome.status >= 500) {
        return new ProviderTransientError(`The site answered HTTP ${outcome.status}.`);
      }
      return new ProviderBadRequestError(`The site answered HTTP ${outcome.status}.`);
    case 'fault':
      if (outcome.code === 405) return new XmlRpcFaultError(405, DISABLED);
      if (outcome.code === 401) {
        return new ProviderAuthError(
          `The connected WordPress user is not allowed to do this. ${says(outcome, secret)}. ` +
            'Reconnect with a user who can publish posts.',
        );
      }
      if (outcome.code === -32601) {
        return new XmlRpcFaultError(
          outcome.code,
          `The site has switched off the XML-RPC method ${method} — a security plugin is ` +
            'restricting XML-RPC.',
        );
      }
      if (outcome.code === 500) return new ProviderTransientError(says(outcome, secret));
      return new XmlRpcFaultError(outcome.code, says(outcome, secret));
  }
}

/** The same outcomes, as the fixed vocabulary a connect attempt answers with. */
function connectFailure(outcome: Exclude<Outcome, { type: 'value' }>): ConnectError['code'] {
  switch (outcome.type) {
    case 'redirect':
      return 'site_moved';
    case 'garbled':
      return 'xmlrpc_blocked';
    case 'http':
      if (outcome.status === 405) return 'xmlrpc_disabled';
      if (outcome.status === 404 || outcome.status === 410) return 'xmlrpc_not_found';
      return outcome.status === 429 || outcome.status >= 500
        ? 'site_unreachable'
        : 'xmlrpc_blocked';
    case 'fault':
      // `wp.getProfile` has exactly one 403: "Incorrect username or password."
      if (outcome.code === 403) return 'login_rejected';
      if (outcome.code === 405) return 'xmlrpc_disabled';
      if (outcome.code === 401) return 'role_cannot_publish';
      if (outcome.code === 500) return 'site_unreachable';
      return 'xmlrpc_blocked';
  }
}
