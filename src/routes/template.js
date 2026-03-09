/**
 * Template routes
 * POST /api/template/upload  — Upload a new template (multipart/form-data)
 * GET  /api/template/list    — List all registered templates
 * GET  /api/template/preview/:name — Preview a template with default data
 */
const express = require('express');
const multer = require('multer');
const { requireAdmin } = require('../middleware/auth');
const { r2Put, r2Get } = require('../utils/r2');
const { kvGet, kvPut, kvList } = require('../utils/kv');
const { makeVersion } = require('../utils/mime');
const { injectData } = require('../utils/html');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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

        // Parse schema if present
        let fields = [];
        let isStatic = true;
        const schemaFile = files.find((f) => f.fieldname === 'schema.json');
        if (schemaFile) {
            const schema = JSON.parse(schemaFile.buffer.toString('utf-8'));
            fields = (schema.fields ?? []).map((f) => f.key ?? f);
            isStatic = schema.static === true || fields.length === 0;
        }

        // Register / update template metadata in KV
        await kvPut(`__tmpl__${templateName}`, {
            name: templateName,
            version,
            fields,
            static: isStatic,
            updatedAt: new Date().toISOString(),
        });

        // TODO (P2): async re-render old user pages that use this template
        // For now we log it; BullMQ / worker job to be added later
        const userIndex = await kvGet(`__users__${templateName}`);
        const usersCount = Array.isArray(userIndex) ? userIndex.length : 0;
        if (usersCount > 0) {
            console.log(
                `[template/upload] ${usersCount} existing user(s) use '${templateName}'. ` +
                `Batch re-render NOT YET IMPLEMENTED — add job queue in P2.`
            );
        }

        return res.json({
            success: true,
            templateName,
            version,
            fields,
            static: isStatic,
            filesUploaded: uploadedFiles,
            previewUrl: `https://romancespace.885201314.xyz/preview/${templateName}`,
            pendingReRenderUsers: usersCount,
        });
    } catch (err) {
        console.error('[template/upload]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/template/list ────────────────────────────────────────────────────
router.get('/list', async (_req, res) => {
    try {
        const keys = await kvList('__tmpl__');
        const metas = await Promise.all(keys.map((k) => kvGet(k)));
        return res.json({ success: true, templates: metas.filter(Boolean) });
    } catch (err) {
        console.error('[template/list]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/template/preview/:name ──────────────────────────────────────────
router.get('/preview/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const meta = await kvGet(`__tmpl__${name}`);
        if (!meta) return res.status(404).json({ error: `Template '${name}' not found` });

        const htmlBuf = await r2Get(`templates/${name}/${meta.version}/index.html`);
        if (!htmlBuf) return res.status(404).json({ error: 'Template HTML missing in R2' });

        const schemaBuf = await r2Get(`templates/${name}/${meta.version}/schema.json`);
        const schema = schemaBuf ? JSON.parse(schemaBuf.toString('utf-8')) : null;

        // Render with schema defaults
        const defaults = {};
        (schema?.fields ?? []).forEach((f) => {
            if (f.default !== undefined) defaults[f.key] = f.default;
        });

        const rendered = injectData(htmlBuf.toString('utf-8'), defaults, schema);
        return res.set('Content-Type', 'text/html;charset=UTF-8').send(rendered);
    } catch (err) {
        console.error('[template/preview]', err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
