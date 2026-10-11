/**
 * XML-RPC wire format (http://xmlrpc.com/spec.md), as much of it as WordPress's `xmlrpc.php`
 * speaks: encode a `methodCall`, decode a `methodResponse` or its `fault`.
 *
 * Written here rather than taken from a package for one reason: the response is text from a site
 * somebody typed in, and a general XML parser is the classic way to turn that into a problem —
 * entity expansion ("billion laughs"), external entities (XXE: reading local files, calling
 * internal addresses), DTD fetches. This decoder has no such machinery to misuse:
 *
 *  - `<!` in any form — DOCTYPE, ENTITY, CDATA, comments — is refused outright;
 *  - the only entities understood are XML's five predefined ones and numeric character
 *    references; any other `&name;` is refused, never looked up;
 *  - the only processing instruction allowed is one leading `<?xml … ?>`;
 *  - tags carry no attributes and must be ones XML-RPC defines;
 *  - nesting depth, node count and input length are capped.
 *
 * Anything it does not recognise is an `XmlRpcParseError`, never a guess.
 */

export type XmlRpcValue =
  | string
  | number
  | boolean
  | null
  | Buffer
  | XmlRpcValue[]
  | { [member: string]: XmlRpcValue | undefined };

/** A decoded struct. Null-prototype, so a member named `__proto__` is only ever a key. */
export type XmlRpcStruct = { [member: string]: XmlRpcValue | undefined };

/** The response was not well-formed XML-RPC. Never includes the text that failed to parse. */
export class XmlRpcParseError extends Error {}

export type XmlRpcResponse =
  { fault: false; value: XmlRpcValue } | { fault: true; code: number; message: string };

const MAX_INPUT_CHARS = 8 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 200_000;

// --- Encoding -----------------------------------------------------------------------------------

/** Characters XML 1.0 cannot carry at all, even escaped, and halves of a broken surrogate pair. */
const UNENCODABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text → XML character data. `&`, `<` and `>` are escaped; a carriage return is written as a
 * character reference, because an XML parser folds a raw one into a line feed; characters XML 1.0
 * has no way to carry are dropped.
 */
export function escapeXmlText(text: string): string {
  return text
    .replace(UNENCODABLE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

function encodeValue(value: XmlRpcValue, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('XML-RPC value is nested too deeply');
  if (value === null) return '<value><nil/></value>';
  if (typeof value === 'string') return `<value><string>${escapeXmlText(value)}</string></value>`;
  if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('XML-RPC cannot carry a non-finite number');
    // <int> is a signed 32-bit integer in the spec; anything else travels as a double.
    return Number.isInteger(value) && Math.abs(value) <= 0x7fffffff
      ? `<value><int>${value}</int></value>`
      : `<value><double>${value}</double></value>`;
  }
  if (Buffer.isBuffer(value)) return `<value><base64>${value.toString('base64')}</base64></value>`;
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map((v) => encodeValue(v, depth + 1)).join('')}</data></array></value>`;
  }
  const members = Object.entries(value)
    .filter((entry): entry is [string, XmlRpcValue] => entry[1] !== undefined)
    .map(
      ([name, member]) =>
        `<member><name>${escapeXmlText(name)}</name>${encodeValue(member, depth + 1)}</member>`,
    );
  return `<value><struct>${members.join('')}</struct></value>`;
}

/** A complete `methodCall` document. Struct members that are `undefined` are left out. */
export function encodeMethodCall(method: string, params: readonly XmlRpcValue[]): string {
  if (!/^[A-Za-z0-9_.:/]{1,100}$/.test(method)) {
    throw new TypeError('not an XML-RPC method name');
  }
  const body = params.map((p) => `<param>${encodeValue(p, 0)}</param>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<methodCall><methodName>${method}</methodName><params>${body}</params></methodCall>`
  );
}

// --- Tokenising ---------------------------------------------------------------------------------

type Tag = { kind: 'open' | 'close' | 'empty'; name: string };
type Token = Tag | { kind: 'text'; text: string };

const TAGS = new Set([
  'methodResponse',
  'params',
  'param',
  'fault',
  'value',
  'struct',
  'member',
  'name',
  'array',
  'data',
  'string',
  'int',
  'i4',
  'i8',
  'boolean',
  'double',
  'dateTime.iso8601',
  'base64',
  'nil',
]);

const PREDEFINED: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

const fail = (what: string): never => {
  throw new XmlRpcParseError(`not a valid XML-RPC response: ${what}`);
};

/** Character data → text. Only predefined entities and numeric references; nothing is looked up. */
function decodeText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&<]{0,12});?/g, (whole, body: string) => {
    if (!whole.endsWith(';')) return fail('an unterminated entity');
    const named = PREDEFINED[body];
    if (named !== undefined) return named;
    const numeric = /^#(?:(\d{1,7})|x([0-9a-fA-F]{1,6}))$/.exec(body);
    if (!numeric) return fail('an entity that is not predefined');
    const point = numeric[1] !== undefined ? Number(numeric[1]) : parseInt(numeric[2]!, 16);
    const valid =
      point === 0x9 ||
      point === 0xa ||
      point === 0xd ||
      (point >= 0x20 && point <= 0xd7ff) ||
      (point >= 0xe000 && point <= 0xfffd) ||
      (point >= 0x10000 && point <= 0x10ffff);
    if (!valid) return fail('a character reference outside XML');
    return String.fromCodePoint(point);
  });
}

function tokenize(xml: string): Token[] {
  if (xml.length > MAX_INPUT_CHARS) fail('too long');
  const tokens: Token[] = [];
  let pos = xml.charCodeAt(0) === 0xfeff ? 1 : 0;

  // One XML declaration, only at the very start (whitespace before it is tolerated).
  const prolog = /\s*<\?xml\s[^<>?]{0,200}\?>/y;
  prolog.lastIndex = pos;
  if (prolog.test(xml)) pos = prolog.lastIndex;

  const tag = /<(\/?)([A-Za-z][A-Za-z0-9.]{0,30})\s*(\/?)>/y;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt !== pos) {
      const end = lt === -1 ? xml.length : lt;
      tokens.push({ kind: 'text', text: decodeText(xml.slice(pos, end)) });
      pos = end;
      continue;
    }
    const next = xml[pos + 1];
    if (next === '!') fail('a DOCTYPE, entity declaration, comment or CDATA section');
    if (next === '?') fail('a processing instruction');
    tag.lastIndex = pos;
    const match = tag.exec(xml);
    if (!match) return fail('a malformed tag, or a tag with attributes');
    const [, closing, name, selfClosing] = match as unknown as [string, string, string, string];
    if (!TAGS.has(name)) fail('an element XML-RPC does not define');
    if (closing && selfClosing) fail('a malformed tag');
    tokens.push({ kind: closing ? 'close' : selfClosing ? 'empty' : 'open', name });
    if (tokens.length > MAX_NODES) fail('too many elements');
    pos = tag.lastIndex;
  }
  return tokens;
}

// --- Parsing ------------------------------------------------------------------------------------

const BLANK = /^[ \t\r\n]*$/;

class Reader {
  private at = 0;

  constructor(private readonly tokens: Token[]) {}

  /** The next token that is not whitespace between elements, without consuming it. */
  peek(): Token | undefined {
    let i = this.at;
    while (i < this.tokens.length) {
      const token = this.tokens[i]!;
      if (token.kind !== 'text' || !BLANK.test(token.text)) return token;
      i++;
    }
    return undefined;
  }

  /** Consume the next structural token; text that is not whitespace is an error here. */
  next(): Tag {
    while (this.at < this.tokens.length) {
      const token = this.tokens[this.at++]!;
      if (token.kind !== 'text') return token;
      if (!BLANK.test(token.text)) fail('text where an element was expected');
    }
    return fail('it ends early');
  }

  open(name: string): void {
    const token = this.next();
    if (token.kind !== 'open' || token.name !== name) fail(`<${name}> was expected`);
  }

  close(name: string): void {
    const token = this.next();
    if (token.kind !== 'close' || token.name !== name) fail(`</${name}> was expected`);
  }

  /** The character data up to `</name>`, exactly as sent. An element inside it is an error. */
  textUntilClose(name: string): string {
    const token = this.tokens[this.at];
    if (token?.kind === 'text') {
      this.at++;
      const end = this.tokens[this.at++];
      if (end?.kind !== 'close' || end.name !== name) fail(`</${name}> was expected`);
      return token.text;
    }
    this.at++;
    if (token?.kind !== 'close' || token.name !== name) fail(`</${name}> was expected`);
    return '';
  }

  /** `<value>` holding bare text is a string (the spec's default type). Null if it is not that. */
  bareString(): string | null {
    const first = this.tokens[this.at];
    const second = this.tokens[this.at + 1];
    if (first?.kind === 'close' && first.name === 'value') {
      this.at += 1;
      return '';
    }
    if (first?.kind === 'text' && second?.kind === 'close' && second.name === 'value') {
      this.at += 2;
      return first.text;
    }
    return null;
  }

  done(): boolean {
    return this.peek() === undefined;
  }
}

function scalar(type: string, text: string): XmlRpcValue {
  switch (type) {
    case 'string':
    case 'dateTime.iso8601':
      // A date stays the text WordPress sent (`20261011T09:30:00`): nothing here needs it parsed.
      return text;
    case 'int':
    case 'i4':
    case 'i8': {
      const trimmed = text.trim();
      if (!/^[+-]?\d{1,16}$/.test(trimmed)) return fail('an integer that is not one');
      const n = Number(trimmed);
      return Number.isSafeInteger(n) ? n : fail('an integer out of range');
    }
    case 'boolean': {
      const trimmed = text.trim();
      if (trimmed !== '0' && trimmed !== '1') return fail('a boolean that is not 0 or 1');
      return trimmed === '1';
    }
    case 'double': {
      const trimmed = text.trim();
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
        return fail('a double that is not one');
      }
      return Number(trimmed);
    }
    case 'base64': {
      const packed = text.replace(/[ \t\r\n]+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(packed) || packed.length % 4 !== 0) {
        return fail('base64 that is not base64');
      }
      return Buffer.from(packed, 'base64');
    }
    default:
      return fail('an unexpected element inside <value>');
  }
}

function parseStruct(reader: Reader, depth: number): XmlRpcStruct {
  const struct = Object.create(null) as XmlRpcStruct;
  for (;;) {
    const token = reader.next();
    if (token.kind === 'close' && token.name === 'struct') return struct;
    if (token.kind !== 'open' || token.name !== 'member') fail('<member> was expected');
    reader.open('name');
    const name = reader.textUntilClose('name');
    struct[name] = parseValue(reader, depth + 1);
    reader.close('member');
  }
}

function parseArray(reader: Reader, depth: number): XmlRpcValue[] {
  const items: XmlRpcValue[] = [];
  const data = reader.next();
  if (data.name !== 'data' || data.kind === 'close') fail('<data> was expected');
  if (data.kind === 'open') {
    for (;;) {
      const token = reader.peek();
      if (token?.kind === 'close' && token.name === 'data') {
        reader.next();
        break;
      }
      items.push(parseValue(reader, depth + 1));
    }
  }
  reader.close('array');
  return items;
}

function parseValue(reader: Reader, depth: number): XmlRpcValue {
  if (depth > MAX_DEPTH) fail('nested too deeply');
  const start = reader.next();
  if (start.name !== 'value' || start.kind === 'close') fail('<value> was expected');
  if (start.kind === 'empty') return '';
  const bare = reader.bareString();
  if (bare !== null) return bare;

  const type = reader.next();
  if (type.kind === 'close') return fail('a type element was expected inside <value>');
  let value: XmlRpcValue;
  if (type.kind === 'empty') {
    if (type.name === 'nil') value = null;
    else if (type.name === 'struct') value = Object.create(null) as XmlRpcStruct;
    else if (type.name === 'string' || type.name === 'base64') value = scalar(type.name, '');
    else value = fail('an empty element that needs content');
  } else if (type.name === 'struct') value = parseStruct(reader, depth);
  else if (type.name === 'array') value = parseArray(reader, depth);
  else value = scalar(type.name, reader.textUntilClose(type.name));
  reader.close('value');
  return value;
}

/**
 * Decode a `methodResponse`. A fault is returned, not thrown: it is a well-formed answer, and what
 * it means is the caller's to decide. Everything else that is not exactly a response throws
 * `XmlRpcParseError`.
 */
export function decodeMethodResponse(xml: string): XmlRpcResponse {
  const reader = new Reader(tokenize(xml));
  reader.open('methodResponse');
  const kind = reader.next();
  let response: XmlRpcResponse;
  if (kind.kind === 'open' && kind.name === 'fault') {
    const detail = parseValue(reader, 0);
    reader.close('fault');
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
      return fail('a fault that is not a struct');
    }
    const { faultCode, faultString } = detail as XmlRpcStruct;
    if (typeof faultCode !== 'number' || !Number.isInteger(faultCode)) {
      return fail('a fault without a numeric code');
    }
    response = {
      fault: true,
      code: faultCode,
      message: typeof faultString === 'string' ? faultString : '',
    };
  } else if (kind.kind === 'open' && kind.name === 'params') {
    reader.open('param');
    const value = parseValue(reader, 0);
    reader.close('param');
    reader.close('params');
    response = { fault: false, value };
  } else {
    return fail('<params> or <fault> was expected');
  }
  reader.close('methodResponse');
  if (!reader.done()) fail('content after the response');
  return response;
}

/** Narrowing helpers for decoded values: a site's answer is checked, never assumed. */
export function asStruct(value: XmlRpcValue | undefined): XmlRpcStruct | null {
  return value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
    ? (value as XmlRpcStruct)
    : null;
}

export function asArray(value: XmlRpcValue | undefined): XmlRpcValue[] | null {
  return Array.isArray(value) ? value : null;
}

/** WordPress sends ids as strings in some methods and ints in others; both mean the same id. */
export function asId(value: XmlRpcValue | undefined): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) return Number(value);
  return null;
}
