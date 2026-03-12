/**
 * Project routes
 * POST /api/project/render — Render user page and write to R2
 * GET  /api/project/:subdomain — Get project config from KV
 */
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { r2Put, r2Get } = require('../utils/r2');
const { kvGet, kvPut } = require('../utils/kv');
const { injectData } = require('../utils/html');
const { purgeCacheUrls } = require('../utils/cache');
const { supabase } = require('../utils/supabase'); // Added Supabase Client

const router = express.Router();

const BASE_DOMAIN = '885201314.xyz';

let memoryBlocklist = [];
let blocklistLoaded = false;

let memoryQuotas = {
    'free': 1,
    'pro': 5,
    'partner': 10,
    'admin': 999
};
let quotasLoaded = false;

async function ensureQuotas() {
    if (!quotasLoaded) {
        try {
            const list = await kvGet('__sys__quotas');
            if (list && typeof list === 'object') {
                memoryQuotas = { ...memoryQuotas, ...list };
            }
            quotasLoaded = true;
            console.log('[Quotas] Initial loaded from KV:', Object.keys(memoryQuotas).length, 'tiers');
        } catch (e) {
            console.error('[Quotas] Init failed', e);
            quotasLoaded = true;
        }
    }
}

async function ensureBlocklist() {
    if (!blocklistLoaded) {
        try {
            const list = await kvGet('__sys__blocklist');
            if (Array.isArray(list)) memoryBlocklist = list.map(s => String(s).toLowerCase());
            blocklistLoaded = true;
            console.log('[Blocklist] Initial loaded from KV:', memoryBlocklist.length, 'items');
        } catch (e) {
            console.error('[Blocklist] Init failed', e);
            blocklistLoaded = true;
        }
    }
}

// ── Helper: Supabase Validation & Quota Checking ─────────────────────────────
async function validateAndCheckQuota(userId, subdomain) {
    if (!userId) {
        return { isValid: false, code: 4001, message: '请求必须包含 userId 以验证身份' };
    }

    // 0. Zero-Quota Blocklist Check
    await ensureBlocklist();
    if (memoryBlocklist.includes(subdomain.toLowerCase())) {
        return { isValid: false, code: 4003, message: '该域名为系统保留字或已禁用，请更换试试哦' };
    }

    // 1. Check if subdomain already exists
    const { data: existingProject, error: fetchErr } = await supabase
        .from('projects')
        .select('user_id')
        .eq('subdomain', subdomain)
        .maybeSingle();

    if (fetchErr) {
        throw new Error('Supabase Error: ' + fetchErr.message);
    }

    if (existingProject) {
        // Domain is taken. Check ownership.
        if (existingProject.user_id !== userId) {
            return { isValid: false, code: 4010, message: '该域名前缀已被他人抢先使用，请更换试试哦' };
        }
        // It's their domain = Update Scenario (A-2 / A-3)
        return { isValid: true, mode: 'UPDATE' };
    } else {
        // Domain is not taken = Create Scenario (A-1)
        
        // 1. Fetch user tier from profiles table
        const { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('tier')
            .eq('id', userId)
            .maybeSingle();

        if (profileErr) throw new Error('Supabase Profile Error: ' + profileErr.message);
        
        const tier = profile?.tier || 'free';

        // 2. Count existing projects
        const { count, error: countErr } = await supabase
            .from('projects')
            .select('subdomain', { count: 'exact', head: true })
            .eq('user_id', userId);

        if (countErr) throw new Error('Supabase Count Error: ' + countErr.message);

        // 3. Define and check quota mapping
        await ensureQuotas();
        
        const maxDomains = memoryQuotas[tier] || memoryQuotas['free'] || 1;
        
        if (count >= maxDomains) {
            return { 
                isValid: false, 
                code: 4030, 
                message: `您的当前等级 (${tier}) 域名额度已用尽 (${count}/${maxDomains})，请升级以获取更多配额` 
            };
        }

        return { isValid: true, mode: 'CREATE' };
    }
}

// ── POST /api/project/config/refresh-blocklist ─────────────────────────────
router.post('/config/refresh-blocklist', requireAdmin, async (req, res) => {
    try {
        const list = await kvGet('__sys__blocklist');
        if (Array.isArray(list)) {
            memoryBlocklist = list.map(s => String(s).toLowerCase());
        } else {
            memoryBlocklist = [];
        }
        blocklistLoaded = true;
        return res.json({ success: true, count: memoryBlocklist.length, message: 'Blocklist refreshed in memory' });
    } catch (err) {
        console.error('[project/refresh-blocklist]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/config/refresh-quotas ─────────────────────────────────────────────
router.post('/config/refresh-quotas', requireAdmin, async (req, res) => {
    try {
        const list = await kvGet('__sys__quotas');
        if (list && typeof list === 'object') {
            memoryQuotas = { 
                'free': 1, 'pro': 5, 'partner': 10, 'admin': 999, // Defaults
                ...list 
            };
        }
        quotasLoaded = true;
        return res.json({ success: true, quotas: memoryQuotas, message: 'Quotas refreshed in memory' });
    } catch (err) {
        console.error('[project/refresh-quotas]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/project/render ───────────────────────────────────────────────
// Universal CQRS write endpoint (Handles Create & Update)
router.post('/render', async (req, res) => {
    try {
        const { userId, subdomain, type, data = {} } = req.body ?? {};

        // 1. Payload validation
        if (!subdomain || !type) {
            return res.status(400).json({ code: 4001, message: "参数校验失败: 'subdomain' 与 'type' 为必选项", data: null });
        }
        if (!/^[a-z0-9-]+$/.test(subdomain)) {
            return res.status(400).json({ code: 4002, message: "参数校验失败: 'subdomain' 只能包含小写字母和数字", data: null });
        }

        // 2. Ownership & Quota checks via Supabase
        const authCheck = await validateAndCheckQuota(userId, subdomain);
        if (!authCheck.isValid) {
            return res.status(400).json({ code: authCheck.code, message: authCheck.message, data: null });
        }
        const isUpdate = (authCheck.mode === 'UPDATE');

        // 3. Load template metadata from target R2 directory/KV
        const meta = await kvGet(`__tmpl__${type}`);
        if (!meta) {
            return res.status(404).json({ code: 4040, message: `模板 ${type} 不存在或未发布`, data: null });
        }

        // 4. Fetch Template base files from R2
        const [htmlBuf, metaBuf] = await Promise.all([
            r2Get(`templates/${type}/${meta.version}/index.html`),
            r2Get(`templates/${type}/${meta.version}/config.json`)
                .then(b => b || r2Get(`templates/${type}/${meta.version}/schema.json`)),
        ]);

        if (!htmlBuf) {
            return res.status(404).json({ code: 4041, message: '核心模板源文件缺失', data: null });
        }

        const schema = metaBuf ? JSON.parse(metaBuf.toString('utf-8')) : null;

        // 5. Render HTML with user data
        let rendered = injectData(htmlBuf.toString('utf-8'), data, schema);

        // 6. Inject <base> tag so relative assets load from the CDN
        const baseTag = `<base href="https://www.885201314.xyz/assets/${type}/" />`;
        const headRegex = /<head[^>]*>/i;
        if (headRegex.test(rendered)) {
            rendered = rendered.replace(headRegex, (match) => `${match}\n    ${baseTag}`);
        } else {
            rendered = `${baseTag}\n${rendered}`;
        }

        // 7. Push final static HTML to R2
        await r2Put(`pages/${subdomain}/index.html`, Buffer.from(rendered, 'utf-8'), 'text/html;charset=UTF-8');

        // 7. Push lightweight router config to KV (Edge router uses status:1 to allow traffic)
        // Optimization: only write to KV if new or template type changed (Reduce KV Write quota)
        const oldConfig = isUpdate ? await kvGet(subdomain) : null;
        if (!oldConfig || oldConfig.template !== type || oldConfig.status !== 1) {
            await kvPut(subdomain, { status: 1, template: type });
            console.log(`[project/render] KV Route Updated for ${subdomain} (Type: ${type})`);
        } else {
            console.log(`[project/render] KV Route Skip (Unchanged) for ${subdomain}`);
        }

        // 8. (Removed legacy KV user index - now handled by Supabase SQL queries)

        // 9. Persist the transaction into Supabase PostgreSQL
        // We use upsert allowing overriding config if it's the same subdomain
        const { error: upsertErr } = await supabase
            .from('projects')
            .upsert({
                subdomain,
                user_id: userId,
                template_type: type,
                data: data,
                updated_at: new Date().toISOString()
            }, { onConflict: 'subdomain' });

        if (upsertErr) {
            console.error('[Supabase Upsert Error]:', upsertErr);
            // Although DB failed, R2/KV succeeded. Log error but don't crash user.
        }

        // 10. Purge CDN cache if this is an update
        const pageUrl = `https://${subdomain}.${BASE_DOMAIN}/`;
        if (isUpdate) {
            await purgeCacheUrls([pageUrl]);
        }

        // 11. Return standard successful response
        return res.status(200).json({
            code: 0,
            message: "网页生成成功",
            data: {
                url: pageUrl
            }
        });

    } catch (err) {
        console.error('[project/render Fatal Error]', err);
        return res.status(500).json({ code: 5000, message: '服务器内部渲染错误', error: err.message, data: null });
    }
});

// ── GET /api/project/:subdomain ────────────────────────────────────────────
// Internal Admin route
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
