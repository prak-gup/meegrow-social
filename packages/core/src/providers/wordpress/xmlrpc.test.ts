import { describe, expect, it } from 'vitest';
import {
  asArray,
  asId,
  asStruct,
  decodeMethodResponse,
  encodeMethodCall,
  escapeXmlText,
  XmlRpcParseError,
  type XmlRpcValue,
} from './xmlrpc.js';

/**
 * The XML-RPC codec. Response fixtures are written out by hand in the layout WordPress's own
 * serialiser produces (`IXR_Value::getXml` / `IXR_Error::getXml` in wp-includes/IXR) — they are
 * DOCUMENTATION-BUILT, not recorded: no request was made to any site.
 */

const response = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<methodResponse>\n  <params>\n    <param>\n      <value>\n      ${inner}\n      </value>\n    </param>\n  </params>\n</methodResponse>\n`;

const value = (xml: string): XmlRpcValue => {
  const decoded = decodeMethodResponse(xml);
  if (decoded.fault) throw new Error('expected a value, got a fault');
  return decoded.value;
};

const refused = (xml: string): string => {
  try {
    decodeMethodResponse(xml);
  } catch (err) {
    expect(err).toBeInstanceOf(XmlRpcParseError);
    return (err as Error).message;
  }
  throw new Error('expected the response to be refused');
};

describe('encodeMethodCall', () => {
  it('writes a methodCall with each scalar in its own type', () => {
    expect(encodeMethodCall('wp.getPost', [1, 'priya', true, 2.5, null])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<methodCall><methodName>wp.getPost</methodName><params>' +
        '<param><value><int>1</int></value></param>' +
        '<param><value><string>priya</string></value></param>' +
        '<param><value><boolean>1</boolean></value></param>' +
        '<param><value><double>2.5</double></value></param>' +
        '<param><value><nil/></value></param>' +
        '</params></methodCall>',
    );
  });

  it('escapes markup in strings and in member names, so content cannot become structure', () => {
    const xml = encodeMethodCall('wp.newPost', [
      { post_title: 'Fish & <Chips>', 'a<b': '</string></value><value><int>9</int>' },
    ]);
    expect(xml).toContain('<string>Fish &amp; &lt;Chips&gt;</string>');
    expect(xml).toContain('<name>a&lt;b</name>');
    expect(xml).toContain('&lt;/string&gt;&lt;/value&gt;&lt;value&gt;&lt;int&gt;9&lt;/int&gt;');
    // Exactly one <int>-free struct: the injected "value" stayed text.
    expect(xml.match(/<int>/g)).toBeNull();
  });

  it('survives a password made of everything XML treats specially', () => {
    const password = `p&ss<w>rd"'; ]]> <!-- &amp; &#x41; é\u{1F600}`;
    const xml = encodeMethodCall('wp.getProfile', [1, 'u', password]);
    expect(xml).not.toContain('<!--');
    expect(xml).not.toContain(']]>');
    // Round-trip through the decoder: what the site would read is what was typed.
    const echoed = xml
      .replace('<methodCall><methodName>wp.getProfile</methodName>', '<methodResponse>')
      .replace('</methodCall>', '</methodResponse>')
      .replace(
        /<params>.*<param>(<value><string>p.*<\/string><\/value>)<\/param><\/params>/s,
        '<params><param>$1</param></params>',
      );
    expect(value(echoed)).toBe(password);
  });

  it('keeps a carriage return and drops characters XML cannot carry', () => {
    expect(escapeXmlText('a\r\nb')).toBe('a&#13;\nb');
    expect(escapeXmlText('a\u0000b\u000bc\u001fd\uFFFE')).toBe('abcd');
    expect(escapeXmlText('lone \ud83d surrogate')).toBe('lone  surrogate');
    expect(escapeXmlText('tab\there \u{1F600}')).toBe('tab\there \u{1F600}');
  });

  it('writes structs, arrays and base64, leaving undefined members out', () => {
    const xml = encodeMethodCall('wp.uploadFile', [
      {
        name: 'a.jpg',
        bits: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        overwrite: undefined,
        terms: { category: [3, 7] },
        empty: [],
      },
    ]);
    expect(xml).toContain(
      '<member><name>bits</name><value><base64>/9j/4A==</base64></value></member>',
    );
    expect(xml).not.toContain('overwrite');
    expect(xml).toContain(
      '<member><name>category</name><value><array><data>' +
        '<value><int>3</int></value><value><int>7</int></value></data></array></value></member>',
    );
    expect(xml).toContain(
      '<member><name>empty</name><value><array><data></data></array></value></member>',
    );
  });

  it('sends an integer too big for <int> as a double, and refuses what cannot be a number', () => {
    expect(encodeMethodCall('m', [2 ** 31])).toContain('<double>2147483648</double>');
    expect(encodeMethodCall('m', [-(2 ** 31) + 1])).toContain('<int>-2147483647</int>');
    expect(() => encodeMethodCall('m', [Number.NaN])).toThrow(TypeError);
    expect(() => encodeMethodCall('m', [Infinity])).toThrow(TypeError);
  });

  it('refuses a method name that is not one', () => {
    for (const bad of ['', 'wp.newPost</methodName>', 'a b', 'x'.repeat(101)]) {
      expect(() => encodeMethodCall(bad, [])).toThrow(TypeError);
    }
  });

  it('refuses a value nested without end', () => {
    let deep: XmlRpcValue = 'x';
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => encodeMethodCall('m', [deep])).toThrow(/nested too deeply/);
  });
});

describe('decodeMethodResponse — what WordPress sends', () => {
  it('reads a string id (wp.newPost answers with the post id as a string)', () => {
    expect(value(response('<string>1284</string>'))).toBe('1284');
  });

  it('reads every scalar type', () => {
    expect(value(response('<int>42</int>'))).toBe(42);
    expect(value(response('<i4>-7</i4>'))).toBe(-7);
    expect(value(response('<boolean>1</boolean>'))).toBe(true);
    expect(value(response('<boolean>0</boolean>'))).toBe(false);
    expect(value(response('<double>0.5</double>'))).toBe(0.5);
    expect(value(response('<dateTime.iso8601>20261011T09:30:00</dateTime.iso8601>'))).toBe(
      '20261011T09:30:00',
    );
    expect(value(response('<nil/>'))).toBeNull();
    expect(value(response('<string></string>'))).toBe('');
    expect(value(response('<string/>'))).toBe('');
  });

  it('reads base64, with the line breaks a serialiser may add', () => {
    const decoded = value(response('<base64>/9j/\n4A==</base64>'));
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect([...(decoded as Buffer)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect((value(response('<base64></base64>')) as Buffer).byteLength).toBe(0);
  });

  it('treats a value with no type element as a string, exactly as sent', () => {
    expect(
      value(
        '<methodResponse><params><param><value>plain text</value></param></params></methodResponse>',
      ),
    ).toBe('plain text');
    expect(
      value('<methodResponse><params><param><value>  </value></param></params></methodResponse>'),
    ).toBe('  ');
    expect(
      value('<methodResponse><params><param><value></value></param></params></methodResponse>'),
    ).toBe('');
    expect(value('<methodResponse><params><param><value/></param></params></methodResponse>')).toBe(
      '',
    );
  });

  it('decodes the five predefined entities and numeric references, and nothing else', () => {
    expect(
      value(response('<string>Ecolive &amp; Co &lt;b&gt; &quot;x&quot; &apos;y&apos;</string>')),
    ).toBe('Ecolive & Co <b> "x" \'y\'');
    // htmlspecialchars() writes an apostrophe as &#039;.
    expect(value(response('<string>It&#039;s &#x1F600; &#233;</string>'))).toBe("It's \u{1F600} é");
    // An escaped ampersand is decoded once, never twice.
    expect(value(response('<string>&amp;lt;script&amp;gt;</string>'))).toBe('&lt;script&gt;');
  });

  it('reads a struct of mixed members (wp.getProfile)', () => {
    const profile = asStruct(
      value(
        response(`<struct>
  <member><name>user_id</name><value><string>7</string></value></member>
  <member><name>username</name><value><string>priya</string></value></member>
  <member><name>display_name</name><value><string>Priya Editor</string></value></member>
  <member><name>roles</name><value><array><data>
  <value><string>editor</string></value>
</data></array></value></member>
</struct>`),
      ),
    )!;
    expect(profile.user_id).toBe('7');
    expect(profile.display_name).toBe('Priya Editor');
    expect(profile.roles).toEqual(['editor']);
  });

  it('reads nested arrays of structs and an empty array', () => {
    const terms = value(
      response(`<array><data>
  <value><struct>
  <member><name>term_id</name><value><string>3</string></value></member>
  <member><name>name</name><value><string>News</string></value></member>
</struct></value>
  <value><struct>
  <member><name>term_id</name><value><string>9</string></value></member>
  <member><name>name</name><value><string>Eco &amp; tips</string></value></member>
</struct></value>
</data></array>`),
    );
    expect(asArray(terms)!.map((t) => asStruct(t)!.name)).toEqual(['News', 'Eco & tips']);
    expect(value(response('<array><data>\n</data></array>'))).toEqual([]);
    expect(value(response('<array><data/></array>'))).toEqual([]);
    expect(value(response('<struct>\n</struct>'))).toEqual({});
  });

  it('returns a fault as a fault, with its code and text', () => {
    const fault = decodeMethodResponse(`<?xml version="1.0" encoding="UTF-8"?>
<methodResponse>
  <fault>
    <value>
      <struct>
        <member>
          <name>faultCode</name>
          <value><int>403</int></value>
        </member>
        <member>
          <name>faultString</name>
          <value><string>Incorrect username or password.</string></value>
        </member>
      </struct>
    </value>
  </fault>
</methodResponse>
`);
    expect(fault).toEqual({
      fault: true,
      code: 403,
      message: 'Incorrect username or password.',
    });
  });

  it('accepts a byte-order mark and whitespace before the declaration', () => {
    expect(value(`${String.fromCharCode(0xfeff)}${response('<int>1</int>')}`)).toBe(1);
    expect(value(`\n  ${response('<int>1</int>')}`)).toBe(1);
  });

  it('keeps a member named __proto__ as a plain key', () => {
    const struct = asStruct(
      value(
        response(
          '<struct><member><name>__proto__</name><value><struct>' +
            '<member><name>polluted</name><value><boolean>1</boolean></value></member>' +
            '</struct></value></member></struct>',
        ),
      ),
    )!;
    expect(Object.keys(struct)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(struct)).toBeNull();
  });
});

describe('decodeMethodResponse — hostile and broken input', () => {
  const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<methodResponse><params><param><value><string>&lol3;</string></value></param></params></methodResponse>`;

  const XXE = `<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<methodResponse><params><param><value><string>&xxe;</string></value></param></params></methodResponse>`;

  it.each([
    ['an entity-expansion bomb', BILLION_LAUGHS],
    ['an external entity (XXE)', XXE],
    [
      'an external DTD',
      '<!DOCTYPE methodResponse SYSTEM "https://evil.test/x.dtd"><methodResponse><params><param><value>x</value></param></params></methodResponse>',
    ],
    [
      'a parameter entity',
      '<!DOCTYPE r [<!ENTITY % p SYSTEM "http://169.254.169.254/">%p;]><methodResponse/>',
    ],
  ])('refuses %s outright, before reading anything else', (_name, xml) => {
    expect(refused(xml)).toMatch(/DOCTYPE/);
  });

  it('refuses an entity it was never told about instead of looking it up', () => {
    expect(refused(response('<string>&xxe;</string>'))).toMatch(/entity/);
    expect(refused(response('<string>&nbsp;</string>'))).toMatch(/entity/);
    expect(refused(response('<string>AT&T</string>'))).toMatch(/entity/);
    expect(refused(response('<string>&#0;</string>'))).toMatch(/character reference/);
    expect(refused(response('<string>&#xD800;</string>'))).toMatch(/character reference/);
    expect(refused(response('<string>&#99999999;</string>'))).toMatch(/entity|character reference/);
  });

  it.each([
    ['a comment', response('<string>a</string><!-- hi -->')],
    ['a CDATA section', response('<string><![CDATA[<b>]]></string>')],
    ['a processing instruction', response('<string>a</string><?php echo 1; ?>')],
    ['a second XML declaration', `${response('<int>1</int>')}<?xml version="1.0"?>`],
    ['a tag with an attribute', response('<string xml:space="preserve">a</string>')],
    ['an element XML-RPC does not define', response('<script>alert(1)</script>')],
    ['a namespaced element', response('<ex:nil/>')],
    ['an unclosed element', '<methodResponse><params><param><value><string>a</string>'],
    ['mismatched closing tags', response('<string>a</int>')],
    ['markup inside a scalar', response('<int><int>1</int></int>')],
    ['text next to a typed value', response('junk<int>1</int>')],
    ['two values in one param', response('<int>1</int></value><value><int>2</int>')],
    ['content after the response', `${response('<int>1</int>')}<methodResponse/>`],
    ['trailing text', `${response('<int>1</int>')}Warning: something`],
    ['an integer that is not one', response('<int>12abc</int>')],
    ['an integer beyond what a number holds', response('<int>99999999999999999</int>')],
    ['a boolean that is not 0 or 1', response('<boolean>true</boolean>')],
    ['a double that is not one', response('<double>1e</double>')],
    ['base64 that is not base64', response('<base64>!!!!</base64>')],
    ['an array without <data>', response('<array><value><int>1</int></value></array>')],
    [
      'a struct member without a name',
      response('<struct><member><value><int>1</int></value></member></struct>'),
    ],
    [
      'a fault that is not a struct',
      '<methodResponse><fault><value><int>3</int></value></fault></methodResponse>',
    ],
    [
      'a fault without a numeric code',
      '<methodResponse><fault><value><struct><member><name>faultCode</name><value><string>x</string></value></member></struct></value></fault></methodResponse>',
    ],
    ['a methodCall', '<methodCall><methodName>x</methodName></methodCall>'],
    ['nothing', ''],
    ['an HTML page', '<!DOCTYPE html><html><body>Access denied</body></html>'],
    ['an HTML page without a doctype', '<html><head><title>403 Forbidden</title></head></html>'],
    [
      'a PHP warning printed before the XML',
      `<br />\n<b>Warning</b>: foo in bar.php\n${response('<int>1</int>')}`,
    ],
    ['plain text', 'XML-RPC server accepts POST requests only.'],
    ['JSON', '{"code":"rest_no_route"}'],
  ])('refuses %s', (_name, xml) => {
    refused(xml);
  });

  it('refuses nesting beyond its depth cap', () => {
    const depth = 60;
    const deep =
      '<array><data><value>'.repeat(depth) +
      '<int>1</int>' +
      '</value></data></array>'.repeat(depth);
    expect(refused(response(deep))).toMatch(/nested too deeply/);
  });

  it('refuses a response with more elements than its cap, and one that is too long', () => {
    const many = `<array><data>${'<value><int>1</int></value>'.repeat(70_000)}</data></array>`;
    expect(refused(response(many))).toMatch(/too many elements/);
    expect(refused(response(`<string>${'a'.repeat(8 * 1024 * 1024)}</string>`))).toMatch(
      /too long/,
    );
  });

  it('never repeats the response in the error it throws', () => {
    const secret = 'hunter2-reflected-by-the-site';
    const message = refused(response(`<string>${secret}</string><bogus/>`));
    expect(message).not.toContain(secret);
  });

  it('is not slowed to a crawl by pathological input', () => {
    const started = Date.now();
    refused(`<methodResponse>${'<'.repeat(200_000)}`);
    refused(`<methodResponse><params><param><value><string>${'&'.repeat(200_000)}</string>`);
    refused(`<methodResponse ${' '.repeat(200_000)}x>`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('value helpers', () => {
  it('asId accepts an id as WordPress sends it — string or int — and nothing else', () => {
    expect(asId('1284')).toBe(1284);
    expect(asId(1284)).toBe(1284);
    for (const bad of ['0', '', '-1', '12a', ' 12', '1.5', 0, -3, 1.5, true, null, undefined, []]) {
      expect(asId(bad as XmlRpcValue)).toBeNull();
    }
  });

  it('asStruct and asArray only pass what they name', () => {
    expect(asStruct({ a: 1 })).toEqual({ a: 1 });
    expect(asStruct([1])).toBeNull();
    expect(asStruct(Buffer.from('x'))).toBeNull();
    expect(asStruct(null)).toBeNull();
    expect(asStruct('x')).toBeNull();
    expect(asArray([1])).toEqual([1]);
    expect(asArray({ a: 1 })).toBeNull();
  });
});
