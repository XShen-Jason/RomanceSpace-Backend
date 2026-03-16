/**
 * Template routes
 * POST /api/template/upload  — Upload a new template (multipart/form-data)
 * GET  /api/template/list    — List all registered templates
 * GET  /api/template/preview/:name — Preview a template with default data
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAdmin } = require('../middleware/auth');
const { r2Put, r2Get } = require('../utils/r2');
const { kvGet, kvPut, kvList } = require('../utils/kv');
const { makeVersion } = require('../utils/mime');
const { injectData } = require('../utils/html');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

let cachedTemplates = null;

// Path where the static template list JSON is written.
// Nginx serves this file directly at /templates.json — sub-5ms, zero Node.js overhead.
const STATIC_TEMPLATE_FILE = process.env.STATIC_TEMPLATE_PATH ?? '/opt/cache/templates.json';

/** Rebuilds the on-disk templates.json from the in-memory cache (or KV if cold). */
async function rebuildStaticTemplateList() {
    try {
        // Ensure the cache is populated
        if (!cachedTemplates) {
            const keys = await kvList('__tmpl__');
            const metas = await Promise.all(keys.map((k) => kvGet(k)));
            cachedTemplates = metas.filter(Boolean);
        }
        const payload = JSON.stringify({ success: true, templates: cachedTemplates });
        const dir = path.dirname(STATIC_TEMPLATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATIC_TEMPLATE_FILE, payload, 'utf-8');
        console.log(`[template/list] Static file updated: ${STATIC_TEMPLATE_FILE} (${cachedTemplates.length} templates)`);
    } catch (err) {
        // Non-fatal: the API endpoint is still available as fallback
        console.error('[template/list] Failed to write static file:', err.message);
    }
}

// ── GitHub Reverse Sync Helper ────────────────────────────────────────────────
/**
 * Commits multiple files to the GitHub templates repository.
 * Each file in the `files` array should have `fieldname` (relative path) and `buffer`.
 */
async function commitToGitHub(templateName, files) {
    const repoOwner = process.env.TEMPLATES_REPO_OWNER;
    const repoName = process.env.TEMPLATES_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;

    if (!repoOwner || !repoName || !token) {
        console.warn('[commitToGitHub] Missing env vars (OWNER/NAME/TOKEN), skipping GitHub commit.');
        return;
    }

    const headers = {
        'Authorization': `token ${token}`,
        'User-Agent': 'RomanceSpace-Backend',
        'Accept': 'application/vnd.github.v3+json'
    };

    console.log(`[github] Syncing template '${templateName}' to GitHub...`);

    for (const file of files) {
        const filePath = `src/${templateName}/${file.fieldname}`;
        const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;

        try {
            // 1. Get existing file SHA if it exists
            let sha = null;
            const getRes = await fetch(apiUrl, { headers });
            if (getRes.ok) {
                const data = await (getRes.json());
                sha = data.sha;
            }

            // 2. Put file content (Base64 encoded)
            const putRes = await fetch(apiUrl, {
                method: 'PUT',
                headers,
                body: JSON.stringify({
                    message: `Admin UI: Updated template '${templateName}' - ${file.fieldname}`,
                    content: file.buffer.toString('base64'),
                    sha: sha ?? undefined
                })
            });

            if (!putRes.ok) {
                const errData = await putRes.json();
                console.error(`[github] Error committing ${file.fieldname}:`, errData.message);
            } else {
                console.log(`[github] Successfully committed: ${filePath}`);
            }
        } catch (err) {
            console.error(`[github] Network error committing ${file.fieldname}:`, err.message);
        }
    }
}

// ── POST /api/template/upload ─────────────────────────────────────────────────
router.post('/upload', requireAdmin, upload.any(), async (req, res) => {
    try {
        const templateName = (req.body.templateName ?? '').trim();
        if (!templateName || !/^[a-z0-9_]+$/.test(templateName)) {
            return res.status(400).json({
                error: 'templateName must contain only lowercase letters, numbers, or underscores',
            });
        }

        const files = req.files ?? [];
        if (!files.some((f) => f.fieldname === 'index.html')) {
            return res.status(400).json({ error: 'index.html is required' });
        }

        const version = makeVersion();
        const uploadedFiles = [];

        // Write every uploaded file to R2 under versioned path
        for (const file of files) {
            const r2Key = `templates/${templateName}/${version}/${file.fieldname}`;
            await r2Put(r2Key, file.buffer, file.mimetype);
            uploadedFiles.push(file.fieldname);
        }

        // Parse metadata (config.json or schema.json)
        let fields = [];
        let isStatic = true;
        let title = templateName; // Fallback to slug
        let tier = 'free'; // Default to Free
        
        const metaFile = files.find((f) => f.fieldname === 'config.json' || f.fieldname === 'schema.json');
        if (metaFile) {
            try {
                const schema = JSON.parse(metaFile.buffer.toString('utf-8'));
                fields = schema.fields ?? [];
                isStatic = schema.static === true || fields.length === 0;
                if (schema.title) title = schema.title;
                if (schema.tier === 'pro') tier = 'pro'; // Explicitly Pro
            } catch (e) {
                console.warn(`[template/upload] Failed to parse config.json for ${templateName}`);
            }
        }

        // Register / update template metadata in KV
        await kvPut(`__tmpl__${templateName}`, {
            name: templateName,
            title,
            tier,
            version,
            fields,
            static: isStatic,
            updatedAt: new Date().toISOString(),
        });

        // Invalidate the in-memory cache and rebuild the static templates.json file on disk
        cachedTemplates = null;
        assetVersionCache.delete(templateName); // Ensure assets point to the new version
        rebuildStaticTemplateList().catch(err => {
            console.error('[template/upload] Failed to rebuild static list:', err);
        });

        // Optional: Reverse Sync to GitHub if requested
        const syncToGithub = req.body.syncToGithub === 'true';
        if (syncToGithub) {
            // Run in background to avoid blocking response
            commitToGitHub(templateName, files).catch(err => {
                console.error('[template/upload] GitHub sync failed:', err);
            });
        }

        return res.json({
            success: true,
            templateName,
            version,
            fields,
            static: isStatic,
            filesUploaded: uploadedFiles,
            previewUrl: `https://www.885201314.xyz/preview/${templateName}`,
            githubSynced: syncToGithub
        });
    } catch (err) {
        console.error('[template/upload]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/template/sync-local ─────────────────────────────────────────────
// Admin only: Syncs templates from either local filesystem or GitHub Repo.
router.post('/sync-local', requireAdmin, async (req, res) => {
    try {
        const repoOwner = process.env.TEMPLATES_REPO_OWNER;
        const repoName = process.env.TEMPLATES_REPO_NAME;
        const localPath = process.env.TEMPLATES_LOCAL_PATH || path.join(__dirname, '../../../RomanceSpace-Templates/src');

        const results = [];
        
        // --- Option A: Sync from GitHub (Recommended if VPS has no code) ---
        if (repoOwner && repoName) {
            console.log(`[sync] Fetching from GitHub: ${repoOwner}/${repoName}...`);
            const baseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/src`;
            const ghHeaders = { 'User-Agent': 'RomanceSpace-Backend' };
            if (process.env.GITHUB_TOKEN) ghHeaders['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;

            const repoRes = await fetch(baseUrl, { headers: ghHeaders });
            if (!repoRes.ok) throw new Error(`GitHub API failed: ${repoRes.statusText}`);
            
            const contents = await repoRes.json();
            const folders = contents.filter(c => c.type === 'dir').map(c => c.name);

            for (const name of folders) {
                const version = makeVersion();
                const filesUrl = `${baseUrl}/${name}`;
                const filesRes = await fetch(filesUrl, { headers: ghHeaders });
                const filesData = await filesRes.json();
                
                // Track files for this template
                const uploadedFiles = [];
                let configJson = null;

                for (const fileRecord of filesData) {
                    if (fileRecord.type === 'file') {
                        const fileContentRes = await fetch(fileRecord.download_url);
                        const content = Buffer.from(await fileContentRes.arrayBuffer());
                        
                        // Upload to R2
                        const { getMime } = require('../utils/mime');
                        await r2Put(`templates/${name}/${version}/${fileRecord.name}`, content, getMime(fileRecord.name));
                        uploadedFiles.push(fileRecord.name);

                        if (fileRecord.name === 'config.json' || fileRecord.name === 'schema.json') {
                            configJson = JSON.parse(content.toString('utf-8'));
                        }
                    }
                }

                if (!uploadedFiles.includes('index.html')) continue;

                const fields = configJson?.fields ?? [];
                const isStatic = configJson?.static === true || fields.length === 0;
                const title = configJson?.title || name;
                const tier = configJson?.tier === 'pro' ? 'pro' : 'free';

                await kvPut(`__tmpl__${name}`, {
                    name, title, tier, version, fields, static: isStatic, updatedAt: new Date().toISOString()
                });
                results.push({ name, version, source: 'github' });
            }
        } 
        // --- Option B: Fallback to Local Filesystem ---
        else if (fs.existsSync(localPath)) {
            console.log(`[sync] Fetching from Local: ${localPath}...`);
            const dirs = fs.readdirSync(localPath, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            for (const name of dirs) {
                const dirPath = path.join(localPath, name);
                const indexHtml = path.join(dirPath, 'index.html');
                if (!fs.existsSync(indexHtml)) continue;

                const version = makeVersion();
                const files = [];
                const walk = (d, rel = '') => {
                    const entries = fs.readdirSync(d, { withFileTypes: true });
                    for (const e of entries) {
                        const r = rel ? `${rel}/${e.name}` : e.name;
                        const p = path.join(d, e.name);
                        if (e.isDirectory()) walk(p, r);
                        else files.push({ rel: r, path: p });
                    }
                };
                walk(dirPath);

                for (const f of files) {
                    const content = fs.readFileSync(f.path);
                    const { getMime } = require('../utils/mime');
                    await r2Put(`templates/${name}/${version}/${f.rel}`, content, getMime(f.rel));
                }

                let configJson = null;
                const metaPath = [path.join(dirPath, 'config.json'), path.join(dirPath, 'schema.json')].find(p => fs.existsSync(p));
                if (metaPath) configJson = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

                const fields = configJson?.fields ?? [];
                const isStatic = configJson?.static === true || fields.length === 0;
                const title = configJson?.title || name;
                const tier = configJson?.tier === 'pro' ? 'pro' : 'free';

                await kvPut(`__tmpl__${name}`, {
                    name, title, tier, version, fields, static: isStatic, updatedAt: new Date().toISOString()
                });
                results.push({ name, version, source: 'local' });
            }
        } 
        else {
            return res.status(404).json({ 
                error: '未找到模板源', 
                message: '请在 .env 中设置 TEMPLATES_REPO_OWNER/NAME (GitHub 模式) 或确保 VPS 上存在模板文件夹。' 
            });
        }

        cachedTemplates = null;
        assetVersionCache.clear(); // Clear all version caches since we did a bulk sync
        await rebuildStaticTemplateList();
        return res.json({ success: true, count: results.length, details: results });
    } catch (err) {
        console.error('[template/sync-local]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/template/list ────────────────────────────────────────────────────
router.get('/list', async (_req, res) => {
    try {
        if (!cachedTemplates) {
            const keys = await kvList('__tmpl__');
            const metas = await Promise.all(keys.map((k) => kvGet(k)));
            cachedTemplates = metas.filter(Boolean);
            console.log(`[template/list] Cache MISS: Loaded ${cachedTemplates.length} templates from KV.`);
        }

        res.set('Cache-Control', 'no-cache'); // Disable cache for the list API to ensure reactivity
        return res.json({ success: true, templates: cachedTemplates });
    } catch (err) {
        console.error('[template/list]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/template/raw/:name ──────────────────────────────────────────────
router.get('/raw/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const meta = await kvGet(`__tmpl__${name}`);
        if (!meta) return res.status(404).json({ error: `Template '${name}' not found` });

        const htmlBuf = await r2Get(`templates/${name}/${meta.version}/index.html`);
        if (!htmlBuf) return res.status(404).json({ error: 'Template HTML missing in R2' });

        res.set('Cache-Control', 'public, max-age=3600');
        res.set('Content-Type', 'text/plain;charset=UTF-8');
        return res.send(htmlBuf.toString('utf-8'));
    } catch (err) {
        console.error('[template/raw]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/template/preview/:name ──────────────────────────────────────────
router.get('/preview/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const meta = await kvGet(`__tmpl__${name}`);
        if (!meta) return res.status(404).send('Template not found');

        const [htmlBuf, metaBuf] = await Promise.all([
            r2Get(`templates/${name}/${meta.version}/index.html`),
            r2Get(`templates/${name}/${meta.version}/config.json`)
                .then(b => b || r2Get(`templates/${name}/${meta.version}/schema.json`)),
        ]);

        if (!htmlBuf) return res.status(404).send('Template HTML missing');

        let html = htmlBuf.toString('utf-8');
        let schema = null;
        if (metaBuf) {
            try { schema = JSON.parse(metaBuf.toString('utf-8')); } catch (e) { /* ignore */ }
        }

        // 1. Inject <base> tag so relative assets (CSS/JS) load from the versions path in CDN
        // Note: Deployment guide suggests assets are served from /assets/:name/ which maps to R2
        const baseTag = `<base href="https://www.885201314.xyz/assets/${name}/" />`;

        // Robust injection: find <head> case-insensitive, or prepend if missing
        const headRegex = /<head[^>]*>/i;
        if (headRegex.test(html)) {
            html = html.replace(headRegex, (match) => `${match}\n  ${baseTag}`);
        } else {
            // Fallback: prepend to the very beginning if no <head> found
            html = `${baseTag}\n${html}`;
        }

        // 2. Inject default data from schema
        const rendered = injectData(html, {}, schema);

        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(rendered);
    } catch (err) {
        console.error('[template/preview]', err);
        return res.status(500).send('Internal Server Error');
    }
});
// ── GET /assets/:type/*filepath — Serve template static assets from R2 ─────────
// IMPORTANT: This wildcard route MUST be defined AFTER all named routes (/list,
// /raw, /preview) so it does not shadow them. It handles the case where this
// router is mounted at /assets in app.js: /assets/anniversary/style.css → type=anniversary, filepath=style.css
const assetVersionCache = new Map();

router.get('/:type/*', async (req, res) => {
    try {
        const { type } = req.params;
        const filePath = req.params[0];

        // 1. Resolve template version (in-memory cache → KV)
        let version = assetVersionCache.get(type);
        if (!version) {
            const meta = await kvGet(`__tmpl__${type}`);
            if (!meta) return res.status(404).send('Template not found');
            version = meta.version;
            assetVersionCache.set(type, version);
        }

        // 2. Fetch from R2
        const r2Key = `templates/${type}/${version}/${filePath}`;
        const buf = await r2Get(r2Key);
        if (!buf) return res.status(404).send('Asset not found');

        // 3. Return with correct MIME type and long cache (versioned path = immutable)
        const { getMime } = require('../utils/mime');
        res.set('Content-Type', getMime(filePath));
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(buf);
    } catch (err) {
        console.error('[template/assets]', err);
        return res.status(500).send('Internal Server Error');
    }
});

module.exports = router;

// Auto-sync static template list on startup for robustness
rebuildStaticTemplateList().catch(err => console.error('[Init] Static sync failed:', err.message));
