/**
 * RomanceSpace Backend — Express entry point
 * CQRS write-side: all writes to R2/KV happen here, never in the Worker.
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const templateRouter = require('./routes/template');
const projectRouter = require('./routes/project');

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────

// Allow the Cloudflare Pages frontend to call this API
app.use(
    cors({
        // In production, restrict to your Pages domain
        origin: process.env.ALLOWED_ORIGIN ?? '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-Admin-Key'],
    })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'romancespace-backend', ts: new Date().toISOString() });
});

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/template', templateRouter);
app.use('/api/project', projectRouter);

// ── 404 catch-all ───────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// ── Error handler ───────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('[unhandled]', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
    console.log(`[romancespace-backend] Listening on http://0.0.0.0:${PORT}`);
});
