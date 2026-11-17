# Site Search Indexer & Custom Search Migration Bridge

Build a clean, domain-scoped JSON search index from publisher-hosted `llms.txt` / `llms-full.txt`, sitemaps, Schema.org JSON-LD, Open Graph tags, and standard HTML metadata. Designed as a deterministic alternative foundation for site-search and RAG pipelines—not a Google SERP scraper.

## Quick start

1. Open this repository in a Codespace.
2. Run `npm install` and `npm run build`.
3. Set `APIFY_TOKEN` in your environment if running on the Apify platform; local runs can use the Apify CLI or `npm run dev` with Apify local storage configured.
4. Provide one or more start URLs such as `https://example.com/`.

The Actor checks the standard manifest paths, parses sitemap URLs and robots.txt sitemap declarations, and fetches HTML, XHTML, Markdown, and plain-text resources on each starting hostname. It does not execute JavaScript or scrape search-engine results pages.

## Input form layout

The Console form is organized into **Index sources**, **Limits and output**, **Incremental updates**, and **Network behavior**. Defaults are deliberately bounded: 100 pages, 6,000 content characters per page, sequential requests, a 20-second request timeout, and a 2 GB Actor memory default. Input limits are checked again by the runtime.

- **Start URLs**: required list of HTTP(S) pages/site roots (up to 20 are used).
- **Maximum pages**: unique page-fetch cap (1–500).
- **Include readable page content** and **Maximum content characters per page**: opt into bounded text extraction.
- **Indexing mode**: Full index or only new/changed records.
- **Previous index JSON URL**: in Changes mode, optional public JSON array or `{ "items": [...] }` containing prior `url` and `contentHash` fields.
- **Request timeout** and **HTTP User-Agent**: network controls.

## Output

Each default-dataset item is a page record with canonical URL, hostname, title, description, bounded text, SHA-256 content hash, discovery source, JSON-LD objects, selected Open Graph metadata, language, last-modified header, and indexed timestamp. The `OUTPUT` key-value record contains run counts and domains. The output schema and dataset schema are in `.actor/`.

Use the dataset API's JSON format for an API response, for example:

```text
GET https://api.apify.com/v2/datasets/{datasetId}/items?format=json
```

This produces JSON items suitable for a lightweight retriever. The implementation is an indexing/migration bridge; a dedicated full-text retrieval API, OAuth source integrations, and n8n/LangGraph adapters are future integration work.

## Incremental runs

Pass the previous run's dataset JSON URL as `previousIndexUrl` and select **Only new or changed pages**. The Actor compares canonical URL and `contentHash`, emitting only pages with new or changed hashes. Deleted pages are not emitted as tombstones; consumers can reconcile against a full index when needed. The supplied previous-index URL must be publicly readable.

## Pricing setup

`pricing.json` is a ready-to-review pay-per-event proposal containing the event **name**, **title**, **description**, and USD **price** for each event. It includes the Actor's page and completion events plus Apify's optional runtime-generated actor-start and default-dataset-item events.

Pricing is not activated by committing this file: configure it in the Actor's Apify Console pricing settings (or through the supported Actor API) and review all prices before publishing. The code calls `Actor.charge()` for `page-indexed` and `index-completed` only when the platform provides PPE configuration. The default dataset item event and Actor-start event are platform-managed. Prices are illustrative starting points, not a financial recommendation.

## Safety and operational notes

- Only HTTP(S) and the exact hostname of each start URL are permitted for discovered links and redirects; local/private IP ranges and reserved local names are rejected.
- Redirects are capped, response sizes are bounded, requests are sequential, and page count/content lengths are capped.
- The Actor does not bypass access controls or anti-bot measures. Respect publisher terms, robots guidance, and applicable law; request failures are logged and skipped.
- This implementation is metadata/content indexing, not a guarantee of full-text search relevance. Consumers can use `content`, `title`, and `description` to build their own search/RAG index.

## Files

- `.actor/actor.json` — Actor definition, 0.0 version, 2 GB default memory, and embedded Console input schema.
- `.actor/input_schema.json` — standalone copy of the input form schema for ease of review.
- `.actor/dataset_schema.json` and `.actor/output_schema.json` — dataset and run output contracts.
- `pricing.json` — suggested PPE event definitions for Apify Console configuration.
- `.devcontainer/devcontainer.json` — Codespaces Node/TypeScript setup.

## Commands

```bash
npm install
npm run build
npm start
```

The Dockerfile uses Apify's Node 20 Actor image and compiles TypeScript during the image build. Node 20+ is supported.
