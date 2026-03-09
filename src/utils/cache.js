/**
 * Cloudflare Zone Cache Purge API helper.
 * Called after backend writes to R2, to invalidate CDN edge caches for specific URLs.
 * Docs: https://developers.cloudflare.com/api/resources/cache/methods/purge/
 */

/**
 * Purge specific URLs from Cloudflare's CDN cache.
 * @param {string[]} urls - Full URLs to purge (e.g. ["https://myproject.885201314.xyz/"])
 */
async function purgeCacheUrls(urls) {
    if (!urls || urls.length === 0) return;
    if (!process.env.CF_ZONE_ID || !process.env.CF_API_TOKEN) {
        console.warn('[cache] CF_ZONE_ID or CF_API_TOKEN not set — skipping purge');
        return;
    }

    const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/purge_cache`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ files: urls }),
        }
    );

    const json = await res.json();
    if (!res.ok || !json.success) {
        // Non-fatal: log and continue. Cache will expire naturally.
        console.error('[cache] Purge failed:', JSON.stringify(json.errors));
    } else {
        console.log(`[cache] Purged ${urls.length} URL(s)`);
    }
}

module.exports = { purgeCacheUrls };
