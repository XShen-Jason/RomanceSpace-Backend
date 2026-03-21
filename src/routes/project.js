/**
 * Project routes
 * POST /api/project/render — Render user page and write to R2
 * GET  /api/project/:subdomain — Get project config from KV
 */
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { r2Put, r2Get } = require('../utils/r2');
const { kvGet, kvPut, kvDelete } = require('../utils/kv');
const { injectData } = require('../utils/html');
const { purgeCacheUrls } = require('../utils/cache');
const { supabase, getProfileWithSubscriptionSync } = require('../utils/supabase'); // Added Supabase Client

const router = express.Router();

const BASE_DOMAIN = process.env.CF_ZONE_NAME || 'moodspace.xyz';

let memoryBlocklist = ['api', 'www', 'admin', 'rs', 'romance', 'space', 'help', 'docs', 'status'];
let blocklistLoaded = false;
let lastSeenKvBlocklist = null; // Track exact string state from KV
let stagedBlocklist = null;

const QUOTA_DEFAULTS = {
    'free': { 
        limit: 1, dailyLimit: 3, minDomainLen: 3, allowHideFooter: false, label: '🌟 体验用户',
        bg: '#f0e6ee', color: 'var(--pink)',
        features: [
            { text: '精选免费模板库', active: true },
            { text: '1 个专属域名配额', active: true },
            { text: '每日 3 次修改限制', active: true },
            { text: '标准 CDN 加载速度', active: true },
            { text: '支持 480+ BGM 库', active: true },
            { text: '移除底部版权标识', active: false },
            { text: '高级粒子特效定制', active: false }
        ]
    },
    'pro': { 
        limit: 3, dailyLimit: 10, minDomainLen: 3, allowHideFooter: true, label: '💎 高级会员',
        bg: 'linear-gradient(135deg, #f43f5e, #e11d48)', color: '#fff',
        features: [
            { text: '100% 模板库自由切换', active: true },
            { text: '3 个专属域名配额', active: true },
            { text: '全库 480+ 款无损 BGM 库', active: true },
            { text: '动态粒子特效背景自由定制', active: true },
            { text: '专属 7x24h 技术支持', active: false },
            { text: '支持绑定个人顶级域名', active: false }
        ]
    },
    'partner': { 
        limit: 15, dailyLimit: 100, minDomainLen: 1, allowHideFooter: true, label: '👑 终身合伙人',
        bg: 'linear-gradient(135deg, #7c3aed, #4f46e5)', color: '#fff',
        features: [
            { text: '100% 模板库自由切换', active: true },
            { text: '15 个专属域名配额', active: true },
            { text: '全库 480+ 款无损 BGM 库', active: true },
            { text: '动态粒子特效背景自由定制', active: true },
            { text: '专属 7x24h 技术支持', active: true },
            { text: '支持绑定个人顶级域名', active: true }
        ]
    },
    'admin': { limit: 999, dailyLimit: 999, minDomainLen: 1, allowHideFooter: true, label: '🛡️ 系统管理员', bg: '#1e293b', color: '#fbbf24', features: [] }
};

let memoryQuotas = { ...QUOTA_DEFAULTS };
let quotasLoaded = false;
let lastSeenKvQuotas = null; // Track exact string state from KV
let stagedQuotas = null;

async function ensureQuotas() {
    if (!quotasLoaded) {
        try {
            const list = await kvGet('__sys__quotas');
            lastSeenKvQuotas = JSON.stringify(list);
            if (list && typeof list === 'object') {
                // Merge KV values, supporting both simple numbers and {limit, label} objects
                for (const key in list) {
                    if (typeof list[key] === 'number') {
                        memoryQuotas[key] = { ...memoryQuotas[key], limit: list[key] };
                    } else if (typeof list[key] === 'object') {
                        memoryQuotas[key] = { ...memoryQuotas[key], ...list[key] };
                    }
                }
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
            lastSeenKvBlocklist = JSON.stringify(list);
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
async function validateAndCheckQuota(userId, subdomain, template) {
    if (!userId) {
        return { isValid: false, code: 4001, message: '请求必须包含 userId 以验证身份' };
    }

    // 1. Fetch user tier & profile once (with real-time subscription sync)
    const profile = await getProfileWithSubscriptionSync(userId);

    if (!profile) return { isValid: false, code: 4004, message: '用户资料不存在' };
    if (profile.message) throw new Error('Supabase Profile Error: ' + profile.message); 
    const dbTier = (profile?.tier || '').toLowerCase();
    const tier = dbTier || (profile?.role === 'admin' ? 'admin' : 'free');

    const subLow = subdomain.toLowerCase();
    
    await ensureQuotas();
    const tierConfig = memoryQuotas[tier] || memoryQuotas['free'];
    const minLen = tierConfig?.minDomainLen || 3;

    // Domain length check...
    if (subLow.length < minLen) {
        return { isValid: false, code: 4002, message: `该域名前缀太短啦，您的等级至少需要 ${minLen} 个字符哦` };
    }

    await ensureBlocklist();
    if (memoryBlocklist.includes(subLow)) {
        return { isValid: false, code: 4003, message: '该域名为系统保留字或已禁用，请更换试试哦' };
    }

    // 3. Global Domain Uniqueness Check (CRITICAL: Prevent cross-user overrides)
    const { data: existingSameDomain, error: existErr } = await supabase
        .from('projects')
        .select('user_id')
        .eq('subdomain', subLow)
        .maybeSingle();

    if (existErr) throw new Error('Supabase Existing Check Error: ' + existErr.message);

    if (existingSameDomain && existingSameDomain.user_id !== userId) {
        return { isValid: false, code: 4005, message: '该域名已被其他用户抢注啦，换一个更特别的吧~' };
    }

    // 4. Fetch all user projects to check quota and identify the latest one
    // Include 'template' to check for grandfathered-in access
    const { data: userProjects, error: fetchArrErr } = await supabase
        .from('projects')
        .select('subdomain, template_type, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

    if (fetchArrErr) throw new Error('Supabase Projects Fetch Error: ' + fetchArrErr.message);

    const currentProjectCount = userProjects?.length || 0;
    const { count: inviteCount } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('invited_by', userId);

    const maxDomains = (tierConfig?.limit || 1) + (inviteCount || 0);
    const existingProject = userProjects?.find(p => p.subdomain === subLow);
    const today = new Date().toISOString().split('T')[0];

    // ── ADVANCED DOWNGRADE POLICY ────────────────────────────────────────────
    if (currentProjectCount > maxDomains) {
        // If it's a NEW project creation attempt while already over quota
        if (!existingProject) {
            return { 
                isValid: false, 
                code: 4020, 
                message: `您的额度已过期 (${currentProjectCount}/${maxDomains})，暂时无法创建新项目，请续费或清理项目哦` 
            };
        }

        // Ownership verified (existingProject belongs to user). Check if it's the "Active/Latest" one.
        const activeProjectSubdomain = userProjects[0]?.subdomain;
        if (existingProject.subdomain !== activeProjectSubdomain) {
            return {
                isValid: false,
                code: 4021,
                message: '由于等级到期，该项目已被锁定访问。仅最近编辑的一个项目可继续维护。'
            };
        }

        // It is the latest project. Now check if the template being used is Free.
        // GRANDFATHERING POLICY: If the project was already using this template before it went Pro, allow it.
        if (template && existingProject.template_type !== template) {
            const tmplMeta = await kvGet(`__tmpl__${template}`);
            if (tmplMeta && tmplMeta.tier !== 'free') {
                return {
                    isValid: false,
                    code: 4025,
                    message: '等级到期进入维护模式：当前仅限使用“免费”模板进行修改。'
                };
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (existingProject) {
        // Domain is taken by user -> Update Scenario. Check Daily Edit Quota.
        const maxDailyEdits = tierConfig?.dailyLimit || 5;
        let dailyCount = profile?.daily_edit_count || 0;
        if (profile?.last_edit_date !== today) dailyCount = 0;
        
        if (dailyCount >= maxDailyEdits) {
            return { isValid: false, code: 4022, message: `今日修改次数已达上限 (${maxDailyEdits}次)，请明天再试或升级等级哦` };
        }
        
        return { isValid: true, mode: 'UPDATE', tier, dailyCount, today, tierConfig };
    } else {
        // Create Scenario. Check Standard Quota.
        if (currentProjectCount >= maxDomains) {
            return { isValid: false, code: 4023, message: `项目创建额度已满 (${maxDomains})，请升级等级以获得更多额度哦` };
        }
        return { isValid: true, mode: 'CREATE', tier, tierConfig };
    }
}

// ── GET /api/project/config/tiers ─────────────────────────────────────────────
// Public/Admin: Lists available tiers and their labels/limits
router.get('/config/tiers', async (req, res) => {
    try {
        await ensureQuotas();
        return res.json({ success: true, tiers: memoryQuotas });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/project/config/sync-status ──────────────────────────────────────
// Admin only: Compares memory state with KV state and STAGES fresh data
router.get('/config/sync-status', requireAdmin, async (req, res) => {
    try {
        await Promise.all([ensureQuotas(), ensureBlocklist()]);
        const [kvQuotas, kvBlocklist] = await Promise.all([
            kvGet('__sys__quotas'),
            kvGet('__sys__blocklist')
        ]);
        
        // Compare with the state we last successfully loaded/synced to memory
        const quotasSynced = JSON.stringify(kvQuotas) === lastSeenKvQuotas;
        const blocklistSynced = JSON.stringify(kvBlocklist) === lastSeenKvBlocklist;

        // Stage fresh data if drift detected
        stagedQuotas = quotasSynced ? null : kvQuotas;
        stagedBlocklist = blocklistSynced ? null : kvBlocklist;

        return res.json({
            success: true,
            quotasSynced,
            blocklistSynced,
            isSynced: quotasSynced && blocklistSynced,
            hasStagedData: !!(stagedQuotas || stagedBlocklist)
        });
    } catch (err) {
        console.error('[project/sync-status]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/project/config/refresh-blocklist ─────────────────────────────
router.post('/config/refresh-blocklist', requireAdmin, async (req, res) => {
    try {
        let newBlocklist;
        if (stagedBlocklist) {
            newBlocklist = stagedBlocklist;
            stagedBlocklist = null;
            console.log('[project/refresh-blocklist] Using STAGED data');
        } else {
            newBlocklist = await kvGet('__sys__blocklist');
            console.log('[project/refresh-blocklist] Fetching from KV (Fallback)');
        }
        
        lastSeenKvBlocklist = JSON.stringify(newBlocklist);
        memoryBlocklist = Array.isArray(newBlocklist) ? newBlocklist.map(s => String(s).toLowerCase()) : [];
        blocklistLoaded = true; // Ensure blocklist is marked as loaded after refresh
        return res.json({ success: true, count: memoryBlocklist.length, message: 'Blocklist refreshed in memory' });
    } catch (err) {
        console.error('[project/refresh-blocklist]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/project/config/sync-all ─────────────────────────────────────────
// Admin only: Fetches BOTH quotas and blocklist from KV and refreshes memory in one go.
// This is the integrated "Sync & Recon" action.
router.post('/config/sync-all', requireAdmin, async (req, res) => {
    try {
        const [kvQuotas, kvBlocklist] = await Promise.all([
            kvGet('__sys__quotas'),
            kvGet('__sys__blocklist')
        ]);

        if (kvQuotas && typeof kvQuotas === 'object') {
            lastSeenKvQuotas = JSON.stringify(kvQuotas);
            // Reset to defaults before merging fresh KV data
            memoryQuotas = { ...QUOTA_DEFAULTS };
            for (const key in kvQuotas) {
                if (typeof kvQuotas[key] === 'number') {
                    memoryQuotas[key] = { ...memoryQuotas[key], limit: kvQuotas[key] };
                } else if (typeof kvQuotas[key] === 'object') {
                    memoryQuotas[key] = { ...memoryQuotas[key], ...kvQuotas[key] };
                }
            }
            quotasLoaded = true;
        }

        if (Array.isArray(kvBlocklist)) {
            lastSeenKvBlocklist = JSON.stringify(kvBlocklist);
            memoryBlocklist = kvBlocklist.map(s => String(s).toLowerCase());
            blocklistLoaded = true;
        }

        // Clear staged data as we are now fully synced
        stagedQuotas = null;
        stagedBlocklist = null;

        return res.json({ 
            success: true, 
            message: '系统配置已完全同步到 VPS 内存',
            quotasCount: Object.keys(memoryQuotas).length,
            blocklistCount: memoryBlocklist.length
        });
    } catch (err) {
        console.error('[project/sync-all]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/project/config/refresh-quotas ─────────────────────────────────────────────
router.post('/config/refresh-quotas', requireAdmin, async (req, res) => {
    try {
        let newQuotas;
        if (stagedQuotas) {
            newQuotas = stagedQuotas;
            stagedQuotas = null;
            console.log('[project/refresh-quotas] Using STAGED data');
        } else {
            newQuotas = await kvGet('__sys__quotas');
            console.log('[project/refresh-quotas] Fetching from KV (Fallback)');
        }

        lastSeenKvQuotas = JSON.stringify(newQuotas);
        if (newQuotas) {
            memoryQuotas = newQuotas;
        } else {
            memoryQuotas = { ...QUOTA_DEFAULTS };
        }
        quotasLoaded = true;
        return res.json({ success: true, quotas: memoryQuotas, message: 'Quotas updated in memory' });
    } catch (err) {
        console.error('[project/refresh-quotas]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/project/config/update-user-tier ─────────────────────────────────────────────
// Admin only: Updates a specific user's tier in Supabase
router.post('/config/update-user-tier', requireAdmin, async (req, res) => {
    try {
        const { targetUserId, tier } = req.body;
        if (!targetUserId || !tier) {
            return res.status(400).json({ error: 'Missing targetUserId or tier' });
        }

        const { error } = await supabase
            .from('profiles')
            .update({ tier: tier.toLowerCase() })
            .eq('id', targetUserId);

        if (error) throw error;

        return res.json({ success: true, message: `User tier successfully updated to ${tier}` });
    } catch (err) {
        console.error('[project/update-user-tier]', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/project/render ───────────────────────────────────────────────
// Universal CQRS write endpoint (Handles Create & Update)
router.post('/render', async (req, res) => {
    try {
        const { userId, subdomain, type, data = {}, showViralFooter = true } = req.body ?? {};

        // 1. Payload validation
        if (!subdomain || !type) {
            return res.status(400).json({ code: 4001, message: "参数校验失败: 'subdomain' 与 'type' 为必选项", data: null });
        }
        if (!/^[a-z0-9-]+$/.test(subdomain)) {
            return res.status(400).json({ code: 4002, message: "参数校验失败: 'subdomain' 只能包含小写字母和数字", data: null });
        }

        // 2. Ownership & Quota checks via Supabase
        const authCheck = await validateAndCheckQuota(userId, subdomain, type);
        if (!authCheck.isValid) {
            return res.status(400).json({ code: authCheck.code, message: authCheck.message, data: null });
        }
        // 3. Perform the actual rendering and persistence
        const renderResult = await renderProjectInternal({
            subdomain,
            userId,
            type,
            data,
            showViralFooter,
            isUpdate: (authCheck.mode === 'UPDATE'),
            tierConfig: authCheck.tierConfig,
            dailyCount: authCheck.dailyCount,
            today: authCheck.today
        });

        return res.status(200).json({
            code: 0,
            message: "网页生成成功",
            data: {
                url: renderResult.url
            }
        });

    } catch (err) {
        console.error('[project/render] Fatal Error:', err);
        return res.status(500).json({ code: 5000, message: 'Server error: ' + err.message });
    }
});

// ── GET /api/project/check-domain ────────────────────────────────────────────
// High-frequency endpoint for typing debounce, with 5-minute memory cache
const domainStatusCache = new Map(); // Map<domain, { isTaken: boolean, timestamp: number }>
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

router.get('/check-domain', async (req, res) => {
    try {
        const domain = (req.query.domain || '').trim().toLowerCase();
        if (!domain) return res.json({ available: false, message: '请输入域名' });

        // 1. Fast Blocklist Check
        await ensureBlocklist();
        if (memoryBlocklist.includes(domain)) {
            return res.json({ available: false, message: '该域名为系统保留字或暂不开放使用' });
        }

        // 2. Local Memory TTL Cache Check
        const cached = domainStatusCache.get(domain);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
            if (cached.isTaken) {
                return res.json({ available: false, message: '已被其他用户抢注啦，换一个更特别的吧~' });
            }
            return res.json({ available: true, message: '🎉 可以使用！' });
        }

        // 3. Database Check (Only if cache miss or expired)
        const { data: existingSameDomain, error: existErr } = await supabase
            .from('projects')
            .select('user_id')
            .eq('subdomain', domain)
            .limit(1)
            .maybeSingle();

        if (existErr) throw new Error('Supabase Check Error: ' + existErr.message);

        const isTaken = !!existingSameDomain;
        
        // 4. Update Cache
        domainStatusCache.set(domain, { isTaken, timestamp: Date.now() });

        if (isTaken) {
            return res.json({ available: false, message: '已被其他用户抢注啦，换一个更特别的吧~' });
        }
        
        return res.json({ available: true, message: '🎉 可以使用！' });

    } catch (err) {
        console.error('[project/check-domain] Error:', err);
        return res.status(500).json({ available: false, message: '网络波动，稍后再试' });
    }
});

/**
 * Core rendering logic extracted for background re-renders.
 */
async function renderProjectInternal({ subdomain, userId, type, data, showViralFooter, isUpdate, tierConfig, dailyCount, today }) {
    // 1. Force viral footer if tier doesn't allow hiding it
    const allowHide = tierConfig?.allowHideFooter ?? false;
    const finalShowViralFooter = allowHide ? (showViralFooter !== false) : true;

    // 2. Load template metadata from KV
    const meta = await kvGet(`__tmpl__${type}`);
    if (!meta) {
        throw new Error(`模板 ${type} 不存在或未发布`);
    }

    // 3. Fetch Template base HTML from R2
    const htmlBuf = await r2Get(`templates/${type}/${meta.version}/index.html`);

    if (!htmlBuf) {
        throw new Error('核心模板源文件缺失');
    }

    const schema = { fields: meta.fields || [] };

    // 4. Render HTML with user data
    let rendered = injectData(htmlBuf.toString('utf-8'), data, schema);

    // 5. Inject Viral Footer if active
    if (finalShowViralFooter) {
        let inviteCode = '';
        try {
            const { data: profile } = await supabase
                .from('profiles')
                .select('invite_code')
                .eq('id', userId)
                .maybeSingle();
            inviteCode = profile?.invite_code || '';
        } catch (e) {
            console.error('[Invite Code Fetch Error]', e);
        }

        const referralLink = `${process.env.FRONTEND_URL || 'https://www.moodspace.xyz'}/builder/${type}?ref=${inviteCode}&src=footer`;
        const footerHtml = `
    <!-- ${process.env.APP_NAME || 'Mood Space'} Viral Floating Footer -->
    <div style="position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 999999; width: auto; max-width: 90%; white-space: nowrap; pointer-events: none;">
        <div style="pointer-events: auto; display: inline-block; background: rgba(255, 255, 255, 0.75); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); padding: 8px 18px; border-radius: 50px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid rgba(252, 228, 236, 0.5); text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <p style="margin: 0; color: #777; font-size: 12px; letter-spacing: 0.2px;">
                <span style="color: #ff477e; font-weight: 500;">❤️ ${process.env.APP_NAME || 'Mood Space'}</span>
                <span style="margin: 0 6px; opacity: 0.3;">|</span>
                <a href="${referralLink}" target="_blank" rel="noopener noreferrer" style="color: #ff477e; text-decoration: none; font-weight: 500;">
                    制作同款网页 ✨
                </a>
            </p>
        </div>
    </div>`;

        const bodyEndIdx = rendered.lastIndexOf('</body>');
        if (bodyEndIdx !== -1) {
            rendered = rendered.substring(0, bodyEndIdx) + footerHtml + '\n' + rendered.substring(bodyEndIdx);
        } else {
            rendered += '\n' + footerHtml;
        }
    }

    // 6. Inject <base> tag so relative assets load from the CDN
    const baseTag = `<base href="${process.env.FRONTEND_URL || 'https://www.moodspace.xyz'}/assets/${type}/" />`;
    const headRegex = /<head[^>]*>/i;
    if (headRegex.test(rendered)) {
        rendered = rendered.replace(headRegex, (match) => `${match}\n    ${baseTag}`);
    } else {
        rendered = `${baseTag}\n${rendered}`;
    }

    // 7. Push final static HTML to R2
    // Inject a stable version tag before writing so the Worker can detect stale pages.
    const versionTag = `<meta name="tmpl-version" content="${meta.version}">`;
    const headMatchForVersion = rendered.match(/<head[^>]*>/i);
    if (headMatchForVersion) {
        rendered = rendered.replace(headMatchForVersion[0], `${headMatchForVersion[0]}\n    ${versionTag}`);
    }
    await r2Put(`pages/${subdomain}/index.html`, Buffer.from(rendered, 'utf-8'), 'text/html;charset=UTF-8');

    // 8. Update KV Route
    const oldConfig = isUpdate ? await kvGet(subdomain) : null;
    const configDiffers = !oldConfig 
        || oldConfig.template !== type 
        || oldConfig.status !== 1
        || oldConfig.showViralFooter !== finalShowViralFooter;

    if (configDiffers) {
        await kvPut(subdomain, { status: 1, template: type, showViralFooter: finalShowViralFooter });
    }

    // 9. Persist to Supabase
    const { error: upsertErr } = await supabase
        .from('projects')
        .upsert({
            subdomain,
            user_id: userId,
            template_type: type,
            data: data,
            show_viral_footer: finalShowViralFooter,
            updated_at: new Date().toISOString()
        }, { onConflict: 'subdomain' });

    if (upsertErr) {
        console.error('[Supabase Upsert Error]:', upsertErr);
    }

    // 9.5 Increment Daily Edit Quota
    if (isUpdate && dailyCount !== undefined && today) {
        const { error: profileErr } = await supabase
            .from('profiles')
            .update({ 
                daily_edit_count: dailyCount + 1,
                last_edit_date: today
            })
            .eq('id', userId);
        
        if (profileErr) {
            console.error('[Supabase Profile Update Error (Quota)]:', profileErr);
        }
    }

    // 10. Purge cache
    const pageUrl = `https://${subdomain}.${BASE_DOMAIN}/`;
    if (isUpdate) {
        await purgeCacheUrls([pageUrl, pageUrl.slice(0, -1)]);
    }

    return { url: pageUrl };
}


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

// In-memory rate limiter for re-render endpoint (max 1 call per subdomain per 60s)
// This is the VPS-side counterpart of the KV lock. They complement each other:
// KV lock = prevents concurrent Worker calls; this = prevents sustained abuse patterns.
const reRenderRateLimit = new Map(); // { subdomain: lastCalledTimestamp }
const RERENDER_COOLDOWN_MS = 60_000; // 60 seconds

function checkReRenderRateLimit(subdomain) {
    const now = Date.now();
    const last = reRenderRateLimit.get(subdomain) ?? 0;
    if (now - last < RERENDER_COOLDOWN_MS) {
        return false; // rate limited
    }
    reRenderRateLimit.set(subdomain, now);
    return true; // allowed
}

// ── POST /api/project/re-render/:subdomain ──────────────────────────────────
// Internal endpoint called by Cloudflare Worker (via waitUntil) for lazy re-rendering.
// Triple-gated: requireAdmin (key) + X-Internal-Source: worker + VPS rate limiter.
router.post('/re-render/:subdomain', requireAdmin, async (req, res) => {
    // Verify the request originates from our own Worker (second defense layer)
    const internalSource = req.headers['x-internal-source'];
    if (internalSource !== 'worker') {
        return res.status(403).json({ success: false, message: 'Forbidden: internal endpoint' });
    }
    const { subdomain } = req.params;
    // VPS-side rate limit: max 1 re-render per subdomain per 60s (third defense layer)
    if (!checkReRenderRateLimit(subdomain)) {
        console.log(`[re-render/lazy] Rate limited: ${subdomain}`);
        return res.status(429).json({ success: false, reason: 'rate_limited', message: 'Too many requests' });
    }
    const lockKey = `__rerender_lock__${subdomain}`;
    try {
        // Check lock: if another re-render is in progress, bail out immediately.
        const lock = await kvGet(lockKey);
        if (lock) {
            return res.json({ success: false, reason: 'locked', message: `Re-render already in progress for ${subdomain}` });
        }

        // Fetch project data from Supabase
        const { data: project, error } = await supabase
            .from('projects')
            .select('*, profiles(tier, role)')
            .eq('subdomain', subdomain)
            .maybeSingle();

        if (error) throw error;
        if (!project) return res.status(404).json({ success: false, message: 'Project not found' });

        // Acquire lock (TTL 120s — CF minimum is 60s) before starting work
        await kvPut(lockKey, '1', 120);

        try {
            const userTier = (project.profiles?.tier || project.profiles?.role || 'free').toLowerCase();
            await ensureQuotas();
            const tierConfig = memoryQuotas[userTier] || memoryQuotas['free'];

            await renderProjectInternal({
                subdomain: project.subdomain,
                userId: project.user_id,
                type: project.template_type,
                data: project.data,
                showViralFooter: project.show_viral_footer,
                isUpdate: true,
                tierConfig,
            });
            console.log(`[re-render/lazy] OK: ${subdomain}`);
            return res.json({ success: true, message: `Re-rendered ${subdomain}` });
        } finally {
            // Always release lock immediately after work completes
            await kvDelete(lockKey).catch(() => {}); // Non-fatal
        }
    } catch (err) {
        console.error(`[re-render/lazy] Error for ${subdomain}:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/project/status/:userId ───────────────────────────────────────
// Fetch user's current tier, domain count, and max quota limit
router.get('/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        // Add headers to prevent caching of user status/quota
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        // 1. Fetch user tier and edit stats (with real-time subscription sync)
        const profile = await getProfileWithSubscriptionSync(userId);
        
        if (!profile) return res.status(404).json({ success: false, error: 'User profile not found' });
        if (profile.message) throw new Error('Supabase Profile Error: ' + profile.message);
        
        // Priority: tier field -> role field (as fallback) -> free
        const dbTier = (profile?.tier || '').toLowerCase();
        let tier = dbTier || (profile?.role === 'admin' ? 'admin' : 'free');
        if (tier && !memoryQuotas[tier]) tier = 'free'; 

        // 2. Fetch all user projects to check quota and identify active project
        const { data: userProjects, error: fetchErr } = await supabase
            .from('projects')
            .select('subdomain, updated_at')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false });
        
        if (fetchErr) throw new Error('Supabase Fetch Projects Error: ' + fetchErr.message);
        
        const count = userProjects?.length || 0;
        const activeProjectSubdomain = userProjects?.[0]?.subdomain || null;
        
        // 3. Get quota limits (including invite bonuses)
        const { count: inviteCount } = await supabase
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('invited_by', userId);

        await ensureQuotas();
        const tierConfig = memoryQuotas[tier] || memoryQuotas['free'];
        const maxDomains = (tierConfig?.limit ?? 1) + (inviteCount || 0);
        const maxDailyEdits = tierConfig?.dailyLimit ?? 5;
        const minDomainLen = tierConfig?.minDomainLen ?? 3;
        const allowHideFooter = tierConfig?.allowHideFooter ?? false;
        const label = tierConfig?.label ?? '体验用户';
        const bg = tierConfig?.bg ?? '#f0e6ee';
        const color = tierConfig?.color ?? 'var(--pink)';
        
        const today = new Date().toISOString().split('T')[0];
        const dailyUsedEdits = profile?.last_edit_date === today ? (profile?.daily_edit_count || 0) : 0;

        const responseData = {
            success: true,
            data: {
                tier,
                label,
                count,
                maxDomains,
                isOverQuota: count > maxDomains,
                activeProjectId: activeProjectSubdomain,
                dailyUsedEdits,
                maxDailyEdits,
                minDomainLen,
                allowHideFooter,
                bg,
                color
            }
        };

        return res.json(responseData);
    } catch (err) {
        console.error('[project/status] Fatal Error', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/project/config-by-subdomain/:subdomain ────────────────────────
// Fetch existing project config for edit mode (Owner only)
router.get('/config-by-subdomain/:subdomain', async (req, res) => {
    const { subdomain } = req.params;
    const userId = req.query.userId;

    try {
        const { data: project, error } = await supabase
            .from('projects')
            .select('*')
            .eq('subdomain', subdomain)
            .maybeSingle();

        if (error) throw error;
        if (!project) return res.status(404).json({ error: 'Project not found' });
        
        // Basic security: require userId if not admin
        if (userId && project.user_id !== userId) {
            return res.status(403).json({ error: 'Permission denied' });
        }

        return res.json({ success: true, data: project });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = { router, renderProjectInternal, memoryQuotas, ensureQuotas };
