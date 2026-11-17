import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_HTML_BYTES = 5_000_000;
const MAX_PREVIOUS_BYTES = 10_000_000;
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

type Input = {
    startUrls?: string[];
    maxPages?: number;
    includeContent?: boolean;
    maxContentChars?: number;
    changeMode?: 'full' | 'changes';
    previousIndexUrl?: string;
    requestTimeoutSecs?: number;
    userAgent?: string;
};

type IndexRecord = {
    url: string;
    domain: string;
    title: string;
    description: string;
    content: string;
    contentHash: string;
    sourceType: string;
    language?: string;
    structuredData: unknown[];
    openGraph: Record<string, string>;
    lastModified?: string;
    indexedAt: string;
};

type Candidate = { url: string; sourceType: string; domain: string };

function isPrivateIPv4(host: string): boolean {
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || a >= 224;
}

function isPrivateIPv6(host: string): boolean {
    const value = host.toLowerCase().replace(/^\[|\]$/g, '');
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
        value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
        value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
}

function validateUrl(raw: string): URL {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed.');
    const host = url.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
        throw new Error('Local and reserved hostnames are not allowed.');
    }
    if (isIP(host) === 4 && isPrivateIPv4(host)) throw new Error('Private or reserved IP addresses are not allowed.');
    if (isIP(host) === 6 && isPrivateIPv6(host)) throw new Error('Private or reserved IP addresses are not allowed.');
    url.username = '';
    url.password = '';
    url.hash = '';
    return url;
}

async function fetchBounded(rawUrl: string, options: { timeoutMs: number; userAgent: string; maxBytes: number; allowedHost?: string }): Promise<{ text: string; response: Response }> {
    let current = validateUrl(rawUrl);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
        if (options.allowedHost && current.hostname.toLowerCase() !== options.allowedHost.toLowerCase()) {
            throw new Error('Redirect left the permitted hostname.');
        }
        const response = await fetch(current, {
            headers: { 'user-agent': options.userAgent, accept: 'text/html,application/xhtml+xml,text/plain,application/xml,application/json,*/*;q=0.5' },
            redirect: 'manual',
            signal: AbortSignal.timeout(options.timeoutMs),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) throw new Error(`Redirect from ${current.href} has no location.`);
            current = validateUrl(new URL(location, current).href);
            continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${current.href}`);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > options.maxBytes) throw new Error('Response exceeds the configured safety size limit.');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > options.maxBytes) throw new Error('Response exceeds the configured safety size limit.');
        return { text: buffer.toString('utf8'), response };
    }
    throw new Error('Too many redirects.');
}

async function fetchManifest(origin: string, allowedHost: string, options: { timeoutMs: number; userAgent: string }): Promise<{ text: string; sourceType: string } | undefined> {
    for (const name of ['llms-full.txt', 'llms.txt'] as const) {
        try {
            const { text } = await fetchBounded(new URL(`/${name}`, origin).href, {
                ...options, maxBytes: MAX_MANIFEST_BYTES, allowedHost,
            });
            log.info(`Using ${name} for ${origin}`);
            return { text, sourceType: name };
        } catch (error) {
            log.info(`${name} not usable for ${origin}: ${String(error)}`);
        }
    }
    return undefined;
}

function canonicalUrl(raw: string): string {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
}

function sameSiteLink(raw: string, base: URL, allowedHost: string): string | undefined {
    try {
        const parsed = validateUrl(new URL(raw, base).href);
        if (parsed.hostname.toLowerCase() !== allowedHost.toLowerCase()) return undefined;
        return canonicalUrl(parsed.href);
    } catch { return undefined; }
}

function manifestLinks(text: string, base: URL, allowedHost: string, sourceType: string): Candidate[] {
    const found = new Set<string>();
    const markdownLink = /\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/gi;
    const bareUrl = /https?:\/\/[^\s<>"')\]]+/gi;
    for (const match of text.matchAll(markdownLink)) {
        const link = sameSiteLink(match[1]!, base, allowedHost);
        if (link) found.add(link);
    }
    for (const match of text.matchAll(bareUrl)) {
        const link = sameSiteLink(match[0]!, base, allowedHost);
        if (link) found.add(link);
    }
    return [...found].map((url) => ({ url, sourceType, domain: allowedHost }));
}

function sitemapLinks(xml: string, base: URL, allowedHost: string): string[] {
    const matches = xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi);
    const urls = new Set<string>();
    for (const match of matches) {
        const link = sameSiteLink(match[1]!.trim(), base, allowedHost);
        if (link) urls.add(link);
    }
    return [...urls];
}

function resourceFormat(url: string, contentType: string): 'html' | 'text' | undefined {
    const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
    if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';
    if (mediaType === 'text/markdown' || mediaType === 'text/x-markdown' || mediaType === 'text/plain') return 'text';

    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() ?? '';
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
    const genericType = !mediaType || mediaType === 'application/octet-stream' || mediaType === 'binary/octet-stream';
    if (!genericType) return undefined;
    if (['html', 'htm'].includes(extension)) return 'html';
    if (['md', 'markdown', 'txt'].includes(extension) || !extension) return 'text';
    return undefined;
}

function extractRecord(body: string, finalUrl: string, domain: string, sourceType: string, format: 'html' | 'text', includeContent: boolean, maxContentChars: number, lastModified?: string): IndexRecord {
    if (format === 'text') {
        const lines = body.split(/\r?\n/);
        const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line.trim()))?.trim().replace(/^#{1,6}\s+/, '');
        const firstLine = lines.find((line) => line.trim())?.trim() ?? '';
        const title = heading || firstLine.replace(/^[-*+]\s+/, '').slice(0, 200);
        const description = lines.find((line) => line.trim() && line.trim() !== firstLine && !/^#{1,6}\s/.test(line.trim()))?.trim() ?? '';
        const content = includeContent
            ? body.replace(/```[^\n]*\n?/g, '').replace(/`([^`]+)`/g, '$1').replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, maxContentChars)
            : '';
        const normalized = [title, description, content].join('\n').trim();
        const contentHash = createHash('sha256').update(normalized || canonicalUrl(finalUrl)).digest('hex');
        return {
            url: canonicalUrl(finalUrl), domain, title, description, content, contentHash, sourceType,
            structuredData: [], openGraph: {}, ...(lastModified ? { lastModified } : {}), indexedAt: new Date().toISOString(),
        };
    }

    const $ = cheerio.load(body);
    $('script, style, noscript, template, svg, nav, footer, header, aside, form').remove();
    const meta = (selector: string) => $(selector).first().attr('content')?.trim() ?? '';
    const title = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || $('title').first().text().trim();
    const description = meta('meta[name="description"]') || meta('meta[property="og:description"]') || meta('meta[name="twitter:description"]');
    const openGraph: Record<string, string> = {};
    for (const key of ['og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:site_name']) {
        const value = meta(`meta[property="${key}"]`);
        if (value) openGraph[key] = value;
    }
    const structuredData: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, node) => {
        const raw = $(node).text().trim();
        if (!raw) return;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) structuredData.push(...parsed);
            else structuredData.push(parsed);
        } catch { /* Ignore malformed publisher JSON-LD and keep indexing the page. */ }
    });
    const content = includeContent ? $('body').text().replace(/\s+/g, ' ').trim().slice(0, maxContentChars) : '';
    const normalized = [title, description, content].join('\n').trim();
    const contentHash = createHash('sha256').update(normalized || canonicalUrl(finalUrl)).digest('hex');
    const language = $('html').attr('lang')?.trim();
    return {
        url: canonicalUrl(finalUrl), domain, title, description, content, contentHash, sourceType,
        ...(language ? { language } : {}), structuredData, openGraph,
        ...(lastModified ? { lastModified } : {}), indexedAt: new Date().toISOString(),
    };
}

async function loadPreviousIndex(url: string | undefined, options: { timeoutMs: number; userAgent: string }): Promise<Map<string, string>> {
    if (!url) return new Map();
    const { text } = await fetchBounded(url, { ...options, maxBytes: MAX_PREVIOUS_BYTES });
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown[] })?.items;
    if (!Array.isArray(rows)) throw new Error('Previous index must be a JSON array or an object with an items array.');
    const previous = new Map<string, string>();
    for (const row of rows) {
        if (row && typeof row === 'object' && 'url' in row && 'contentHash' in row) {
            previous.set(canonicalUrl(String((row as { url: string }).url)), String((row as { contentHash: string }).contentHash));
        }
    }
    return previous;
}

await Actor.main(async () => {
    const input = (await Actor.getInput<Input>()) ?? {};
    const startUrls = (input.startUrls ?? []).slice(0, 20);
    if (!startUrls.length) throw new Error('Provide at least one Start URL.');
    const maxPages = Math.max(1, Math.min(500, Math.floor(input.maxPages ?? 100)));
    const maxContentChars = Math.max(500, Math.min(20_000, Math.floor(input.maxContentChars ?? 6000)));
    const timeoutMs = Math.max(5, Math.min(60, input.requestTimeoutSecs ?? 20)) * 1000;
    const userAgent = (input.userAgent || 'SiteSearchIndexer/1.0').slice(0, 200);
    const fetchOptions = { timeoutMs, userAgent };
    const previous = input.changeMode === 'changes' ? await loadPreviousIndex(input.previousIndexUrl, fetchOptions) : new Map<string, string>();
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const add = (candidate: Candidate) => {
        if (candidates.length < maxPages && !seen.has(candidate.url)) {
            seen.add(candidate.url);
            candidates.push(candidate);
        }
    };
    const startDomains = new Set<string>();
    for (const rawStart of startUrls) {
        let start: URL;
        try { start = validateUrl(rawStart); }
        catch (error) { log.warning(`Ignoring invalid start URL: ${String(error)}`); continue; }
        const domain = start.hostname.toLowerCase();
        startDomains.add(domain);
        add({ url: canonicalUrl(start.href), sourceType: 'start-url', domain });
        const manifest = await fetchManifest(start.origin, domain, fetchOptions);
        if (manifest) {
            for (const candidate of manifestLinks(manifest.text, start, domain, manifest.sourceType)) add(candidate);
        }
        const sitemapUrls = new Set([new URL('/sitemap.xml', start.origin).href]);
        try {
            const robots = await fetchBounded(new URL('/robots.txt', start.origin).href, { ...fetchOptions, maxBytes: MAX_MANIFEST_BYTES, allowedHost: domain });
            for (const match of robots.text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) {
                try {
                    const sitemapUrl = validateUrl(match[1]!).href;
                    if (new URL(sitemapUrl).hostname.toLowerCase() === domain) sitemapUrls.add(sitemapUrl);
                } catch { /* Ignore cross-domain and unsafe sitemap directives. */ }
            }
        } catch { /* robots.txt is optional */ }
        for (const sitemapUrl of sitemapUrls) {
            try {
                const { text } = await fetchBounded(sitemapUrl, { ...fetchOptions, maxBytes: MAX_MANIFEST_BYTES, allowedHost: domain });
                for (const url of sitemapLinks(text, start, domain)) add({ url, sourceType: 'sitemap', domain });
            } catch (error) { log.info(`No usable sitemap at ${sitemapUrl}: ${String(error)}`); }
        }
    }
    if (!startDomains.size || !candidates.length) throw new Error('No valid start URLs could be indexed.');

    let fetched = 0;
    let emitted = 0;
    let failed = 0;
    for (const candidate of candidates) {
        try {
            const { text, response } = await fetchBounded(candidate.url, { ...fetchOptions, maxBytes: MAX_HTML_BYTES, allowedHost: candidate.domain });
            const contentType = response.headers.get('content-type') ?? '';
            const format = resourceFormat(candidate.url, contentType);
            if (!format) {
                log.info(`Skipping unsupported resource ${candidate.url} (${contentType || 'unknown content type'})`);
                continue;
            }
            fetched += 1;
            const record = extractRecord(text, candidate.url, candidate.domain, candidate.sourceType, format, input.includeContent !== false, maxContentChars, response.headers.get('last-modified') ?? undefined);
            if (input.changeMode === 'changes' && previous.get(record.url) === record.contentHash) continue;
            await Actor.pushData(record);
            emitted += 1;
            if (process.env.APIFY_ACTOR_PRICING_INFO) await Actor.charge({ eventName: 'page-indexed', count: 1 });
        } catch (error) {
            failed += 1;
            log.warning(`Could not index ${candidate.url}: ${String(error)}`);
        }
    }
    if (process.env.APIFY_ACTOR_PRICING_INFO) await Actor.charge({ eventName: 'index-completed', count: 1 });
    const summary = {
        status: 'SUCCEEDED',
        startUrls,
        domains: [...startDomains],
        discoveredPages: candidates.length,
        fetchedPages: fetched,
        emittedPages: emitted,
        failedPages: failed,
        unchangedPages: Math.max(0, fetched - emitted - failed),
        changeMode: input.changeMode ?? 'full',
        completedAt: new Date().toISOString(),
        datasetUrl: 'See the default dataset for page records.',
    };
    await Actor.setValue('OUTPUT', summary);
    log.info(`Indexing complete: emitted ${emitted} page records from ${fetched} fetched pages.`);
});
