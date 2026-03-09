/**
 * Project routes
 * POST /api/project/render — Render user page and write to R2 (replaces Worker /admin/render-page)
 * GET  /api/project/:subdomain — Get project config from KV
 */
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { r2Put, r2Get } = require('../utils/r2');
const { kvGet, kvPut } = require('../utils/kv');
const { injectData } = require('../utils/html');
const { purgeCacheUrls } = require('../utils/cache');

const router = express.Router();

const BASE_DOMAIN = '885201314.xyz';

// ── Helper: append projectId to template user index in KV ──────────────────
async function addToUserIndex(templateName, subdomain) {
    const key = `__users__${templateName}`;
    const existing = (await kvGet(key)) ?? [];
    const list = Array.isArray(existing) ? existing : [];
    if (!list.includes(subdomain)) {
        list.push(subdomain);
        await kvPut(key, list);
    }
}

// ── POST /api/project/render ───────────────────────────────────────────────
// Public endpoint: no admin key required.
// Abuse protection (Cloudflare Turnstile) to be added in P2.
router.post('/render', async (req, res) => {
    try {
        const { subdomain, type, data = {} } = req.body ?? {};

        if (!subdomain || !type) {
            return res.status(400).json({ error: '`subdomain` and `type` are required' });
        }
        if (!/^[a-z0-9-]+$/.test(subdomain)) {
            return res
                .status(400)
                .json({ error: '`subdomain` must be lowercase alphanumeric and hyphens only' });
        }

        // 1. Load template metadata from KV
        const meta = await kvGet(`__tmpl__${type}`);
        if (!meta) {
            return res.status(404).json({ error: `Template '${type}' not found in KV` });
        }

        // 2. Fetch template HTML + schema from R2
        const [htmlBuf, schemaBuf] = await Promise.all([
            r2Get(`templates/${type}/${meta.version}/index.html`),
            r2Get(`templates/${type}/${meta.version}/schema.json`),
        ]);
        if (!htmlBuf) {
            return res
                .status(404)
                .json({ error: `Template HTML not found in R2 for type='${type}' version='${meta.version}'` });
        }

        const schema = schemaBuf ? JSON.parse(schemaBuf.toString('utf-8')) : null;

        // 3. Render HTML with user data
        const rendered = injectData(htmlBuf.toString('utf-8'), data, schema);

        // 4. Check if this is an update (project already existed)
        const isUpdate = !!(await kvGet(subdomain));

        // 5. Overwrite R2 page (zero-garbage strategy — always same key)
        await r2Put(`pages/${subdomain}.html`, Buffer.from(rendered, 'utf-8'), 'text/html;charset=UTF-8');

        // 6. Persist user config in KV
        await kvPut(subdomain, { type, data });

        // 7. Register user in template's user index
        await addToUserIndex(type, subdomain);

        // 8. Purge CDN cache if this is an update
        if (isUpdate) {
            const pageUrl = `https://${subdomain}.${BASE_DOMAIN}/`;
            await purgeCacheUrls([pageUrl]);
        }

        const pageUrl = `https://${subdomain}.${BASE_DOMAIN}/`;
        const previewUrl = `${pageUrl}?preview=${Date.now()}`;

        return res.json({
            success: true,
            subdomain,
            type,
            url: pageUrl,
            previewUrl,
            isUpdate,
        });
    } catch (err) {
        console.error('[project/render]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/project/:subdomain ────────────────────────────────────────────
router.get('/:subdomain', requireAdmin, async (req, res) => {
    try {
        const { subdomain } = req.params;
        const config = await kvGet(subdomain);
        if (!config) return res.status(404).json({ error: 'Project not found' });
        return res.json({ success: true, subdomain, config });
    } catch (err) {
        console.error('[project/get]', err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
