# List sorting and Google OAuth testing

Set `GOOGLE_OAUTH_TESTING=true` on the API process while the Google OAuth consent app is in Testing mode. It defaults to false. No schema migration is required. YouTube and Google Business Profile connections then report an expected consent expiry seven days after their stored connection creation time, warn during the final two days, and require reconnection once that date passes. Refreshing an access token does not extend this consent deadline. The Connections screen identifies this as “Google app in testing”. This is an expected deadline, not a live check of Google's grant state; earlier revocation still requires a platform operation to detect.

Disable this switch after moving the OAuth app into production. No compose or environment files are changed by this feature.

## Sorting decisions

All list sort choices live in URL query parameters and invalid values use the list default. Native select controls reuse the existing filter pill, with selected options as visible labels. Table headers and controls share their sort state.

- Analytics returns the complete matching report inventory, sorted in core before the UI's “Show more” slices. The former 1,000-row response cap is removed; database reads already loaded the complete period. Responses and CSV files may therefore be larger. Missing metrics stay last in both directions, with publish date descending and ID as tie-breaks. The heading is “Posts” for date sorting and “Top posts” for metric sorting. Platform breakdown and raw metrics sort their complete in-memory report tables.
- Content retains its validated API `order` enum and sorts by real publish/scheduled time and ID before SQL limit/offset. The URL's `sort=newest|oldest` maps to that existing contract. Imported posts already store platform publication time. Metrics are fetched only for loaded cards, so metric sorts are deliberately omitted.
- Blog loads all API pages into one inventory before filtering, sorting, and display paging. Draft date ordering uses modification time. Its controls and sortable headers share URL state.
- Connections, Clients, Overview's clients, and API keys receive complete arrays and sort in memory. Client numeric ties use name then workspace ID; account ties use newest connection then ID. API keys default to newest creation time.

Verification does not establish live platform metrics, actual Google consent revocation, production response size/performance, or database query execution. Integration tests and platform/database/Redis access are excluded from this run.
