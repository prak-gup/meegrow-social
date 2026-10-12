/** Hand-written, synthetic fixtures. No client content or credentials. */
export const articleFixtures = [
  '<h2>Classic article</h2><p>Hello &amp; welcome. नमस्ते 😀</p><ul><li>First</li><li>Second</li></ul><blockquote><p>A quote</p></blockquote>',
  '<!-- wp:paragraph --><p>नमस्ते &amp; friends 😀</p><!-- /wp:paragraph -->\n\n<!-- wp:heading {"level":2} --><h2>Heading</h2><!-- /wp:heading -->\n<!-- wp:list --><ul><!-- wp:list-item --><li>One</li><!-- /wp:list-item --></ul><!-- /wp:list -->',
  '<!-- wp:image {"id":12} --><figure class="wp-block-image"><img src="https://example.invalid/image.jpg" alt="A landscape"><figcaption>Caption</figcaption></figure><!-- /wp:image -->',
  '<!-- wp:quote --><blockquote><p>A quotation</p></blockquote><!-- /wp:quote -->',
  '<p>Before gallery</p>\n<!-- wp:gallery {"ids":[1,2]} --><figure class="wp-block-gallery"><img src="https://example.invalid/one.jpg"></figure><!-- /wp:gallery -->\n<p>After gallery</p>',
  '<p>Before embed</p><!-- wp:embed {"url":"https://example.invalid/video"} --><figure class="wp-block-embed"><div>https://example.invalid/video</div></figure><!-- /wp:embed --><p>After embed</p>',
  '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><p>Left</p></div><!-- /wp:column --></div><!-- /wp:columns -->',
  '<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link" href="https://example.invalid">Read more</a></div><!-- /wp:button --></div><!-- /wp:buttons -->',
  '<p>Before shortcode</p>[gallery ids="1,2"]<p>After shortcode</p>',
  '<!-- wp:html --><div style="color: red" class="custom-card"><p>Custom HTML</p><iframe src="https://example.invalid/embed"></iframe></div><!-- /wp:html -->',
  '<table><tbody><tr><th>Term</th><th>Meaning</th></tr><tr><td>नमस्ते</td><td>Hello &amp; welcome 😀</td></tr></tbody></table>',
  '<p>Entities: &nbsp; &copy; &#x1f600; &lt;literal&gt; &quot;quoted&quot;</p>',
  '<p>First</p>\n<iframe src="https://example.invalid/embed"></iframe>\n<p>Last</p>',
];
