# Site Search Indexer — llms.txt & Schema.org to Clean JSON

Build a domain-scoped, structured JSON search index from **publisher-hosted manifests** — `llms.txt`, `llms-full.txt`, sitemaps, Schema.org JSON-LD, Open Graph, and standard HTML metadata. No SERP scraping, no anti-bot friction, no layout-churn breakage.

Designed as a deterministic replacement foundation for site-search and RAG pipelines, and a practical migration path off the **Google Custom Search JSON API**, which shuts down **January 1, 2027**.

---

## Why this Actor

| Problem | This Actor |
|---|---|
| Google CSE JSON API shuts down Jan 1, 2027 | Domain-scoped index you own, from the site's own manifests |
| SERP scraping breaks on layout changes and anti-bot walls | Reads publisher-sanctioned `llms.txt` / sitemaps only |
| LLM pipelines need grounded, current facts | Returns bounded, hashable page text ready for retrieval |
| Existing crawlers return raw HTML | Returns clean JSON: title, description, content, JSON-LD, Open Graph |

---

## Quick start

1. Click **Try for free** on this page.
2. Enter one or more start URLs — for example `https://docs.yourcompany.com/`.
3. Set **Maximum pages** (start with 5–10 for a trial).
4. Click **Start**.

The Actor checks the standard manifest paths first (`/llms-full.txt`, `/llms.txt`), then sitemaps and `robots.txt` declarations, and fetches HTML, Markdown, and plain-text resources **only on the starting hostname**. It does not execute JavaScript and never touches search-engine results pages.

**First run is free** up to the free-tier page limit.

---

## Inputs

Grouped in the Console as *Index sources*, *Limits and output*, *Incremental updates*, and *Network behavior*.

| Input | Default | Notes |
|---|---|---|
| **Start URLs** *(required)* | — | HTTP(S) pages or site roots. All discovered links stay on the same hostname. |
| **Maximum pages** | 100 | Hard cap on unique pages emitted (1–500). |
| **Include readable page content** | on | Extracts bounded text per page. |
| **Maximum content characters** | 6,000 | Per-page text cap when content is enabled. |
| **Indexing mode** | Full | `Full` emits everything; `Changes` emits only new/changed pages. |
| **Previous index JSON URL** | — | In `Changes` mode, a public JSON array (or `{ items: [...] }`) with prior `url` and `contentHash` fields. |
| **Request timeout** | 20 s | Applies to every request. |
| **HTTP User-Agent** | `SiteSearchIndexer/1.0` | Identify your client; respect each site's terms and `robots` policy. |

All limits are enforced again at runtime, not only in the form.

---

## Output

Each dataset item is one page:

```json
{
  "url": "https://hono.dev/docs/concepts/routers",
  "domain": "hono.dev",
  "title": "Routers - Hono",
  "description": "Web framework built on Web Standards...",
  "content": "The routers are the most important features for Hono...",
  "contentHash": "ddeb066d4ca7833224907f11b374b6d5...",
  "sourceType": "llms-full.txt",
  "language": "en-US",
  "structuredData": [],
  "openGraph": { "og:type": "website", "og:image": "https://hono.dev/images/hono-title.png" },
  "lastModified": null,
  "indexedAt": "2026-11-17T15:57:55.480Z"
}