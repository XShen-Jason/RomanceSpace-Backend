const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../utils/supabase');

// For node-fetch v3 (ESM) in CJS environment
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const router = express.Router();

/**
 * Utility: Generate unique order number
 */
function generateOrderNo(userId) {
    const timestamp = Date.now().toString();
    const randomHex = crypto.randomBytes(4).toString('hex');
    const userHash = crypto.createHash('md5').update(String(userId)).digest('hex').substring(0, 6);
    return `ORDER_${timestamp}_${randomHex}_${userHash}`;
}

/**
 * GET /api/payment/pricing
 * Fetch active pricing configurations
 */
router.get('/pricing', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pricing_configs')
            .select('*')
            .eq('is_active', true)
            .order('sort_order', { ascending: true });
            
        if (error) throw error;
        return res.json({ success: true, data });
    } catch (err) {
        console.error('[payment/pricing] Error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load pricing configs.' });
    }
});

/**
 * POST /api/payment/create
 * L6.5 Create Order with Math Sanity, Snapshot, and Deduplication
 */
router.post('/create', async (req, res) => {
    try {
        const { userId, tier, duration_months, payType } = req.body;
        
        if (!userId || !tier || !duration_months) {
            return res.status(400).json({ success: false, error: "Missing required fields: userId, tier, duration_months" });
        }

        const cleanDurationMonths = parseInt(duration_months);
        if (isNaN(cleanDurationMonths)) {
            return res.status(400).json({ success: false, error: "duration_months must be a number" });
        }

        // 1. Check for existing pending order (Deduplication)
        const { data: existingOrder } = await supabase
            .from('orders')
            .select('order_no, actual_amount')
            .eq('user_id', userId)
            .eq('target_tier', tier)
            .eq('duration_months', cleanDurationMonths)
            .eq('status', 'pending')
            .gt('expired_at', new Date().toISOString())
            .maybeSingle();

        if (existingOrder) {
            console.log(`[payment/create] Reusing pending order ${existingOrder.order_no} for user ${userId}`);
            // Generate real ZhifuFM payUrl via startOrder with existingOrder.order_no
            const zfmRes = await requestZhifuFmUrl(existingOrder.order_no, existingOrder.actual_amount, payType);
            if (!zfmRes.success) {
                return res.status(400).json({ 
                    success: false, 
                    error: `Failed to retrieve payment url: ${zfmRes.msg || 'Unknown gateway error'}` 
                });
            }
            return res.json({ 
                success: true, 
                order_no: existingOrder.order_no, 
                payUrl: zfmRes.payUrl,
                amount: existingOrder.actual_amount
            });
        }

        // 2. Fetch Pricing Configs
        const { data: config, error: configErr } = await supabase
            .from('pricing_configs')
            .select('*')
            .eq('tier', tier)
            .eq('duration_months', cleanDurationMonths)
            .eq('is_active', true)
            .maybeSingle();

        if (configErr || !config) {
            return res.status(400).json({ success: false, error: 'Invalid or inactive pricing tier' });
        }

        // 3. Determine actual amount (First month vs Renewal)
        // Explicit logic only — no silent fallback to discount_rate to avoid billing errors
        const { data: profile } = await supabase
            .from('profiles')
            .select('tier')
            .eq('id', userId)
            .maybeSingle();
        
        const isRenewal = profile && 
                         profile.tier === tier && 
                         profile.subscription_expires_at && 
                         new Date(profile.subscription_expires_at) > new Date();

        let actualAmount;
        if (isRenewal) {
            // Renewal: use renewal_price if set, otherwise fall back to base_price (NOT calculated from discount)
            if (config.renewal_price != null && config.renewal_price > 0) {
                actualAmount = config.renewal_price;
            } else if (config.base_price != null && config.base_price > 0) {
                actualAmount = config.base_price;
            } else {
                return res.status(400).json({ success: false, error: 'Pricing config is missing valid renewal_price and base_price' });
            }
        } else {
            // First purchase: use first_month_price if set, otherwise base_price
            if (config.first_month_price != null && config.first_month_price > 0) {
                actualAmount = config.first_month_price;
            } else if (config.base_price != null && config.base_price > 0) {
                actualAmount = config.base_price;
            } else {
                return res.status(400).json({ success: false, error: 'Pricing config is missing valid first_month_price and base_price' });
            }
        }

        // Strict sanity check — amount must be a positive integer in cents
        actualAmount = Math.round(actualAmount); // Guard against any float sneak-in
        if (!Number.isInteger(actualAmount) || actualAmount <= 0 || actualAmount > 1000000) { // Max 10,000 RMB
            return res.status(400).json({ success: false, error: 'Calculated amount fails safety constraints (must be 1–1,000,000 cents)' });
        }

        // 4. Create Order
        const orderNo = generateOrderNo(userId);
        const expiredAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now

        const { error: insertErr } = await supabase
            .from('orders')
            .insert({
                user_id: userId,
                order_no: orderNo,
                original_amount: config.base_price,
                actual_amount: actualAmount,
                pay_type: payType || 'wechat', // Default to wechat to match Upgrade.jsx
                target_tier: tier,
                duration_months: cleanDurationMonths,
                pricing_snapshot: JSON.parse(JSON.stringify(config)), // Ensure clean JSON
                expired_at: expiredAt.toISOString()
            });

        if (insertErr) {
            console.error('[payment/create] DB Insert Error:', insertErr);
            return res.status(500).json({ 
                success: false, 
                error: `Failed to create order in database: ${insertErr.message || 'Unknown DB error'}`,
                details: insertErr.details || null
            });
        }

        // 5. Generate Payment URL (Real ZhifuFM integration)
        const zfmRes = await requestZhifuFmUrl(orderNo, actualAmount, payType);
        
        if (!zfmRes.success) {
            console.error('[payment/create] Gateway Error:', zfmRes.msg);
            // Soft delete order since gateway rejected it
            await supabase.from('orders').update({ deleted_at: new Date().toISOString() }).eq('order_no', orderNo);
            return res.status(400).json({ 
                success: false, 
                error: `Payment gateway rejected order: ${zfmRes.msg || 'Unknown gateway error'}` 
            });
        }

        const payUrl = zfmRes.payUrl;

        return res.json({ 
            success: true, 
            order_no: orderNo, 
            payUrl: payUrl,
            amount: actualAmount
        });

    } catch (err) {
        console.error('[payment/create] Fatal:', err);
        return res.status(500).json({ 
            success: false, 
            error: `Internal server error during order creation: ${err.message || 'Unknown error'}` 
        });
    }
});

/**
 * Utility: Request ZhifuFM Gateway URL
 */
async function requestZhifuFmUrl(orderNo, amountCents, payType) {
    try {
        const MERCHANT_NUM = process.env.ZHIFUFM_MERCHANT_NUM;
        const SECRET_KEY = process.env.ZHIFUFM_SECRET_KEY;
        const BASE_API_URL = process.env.ZHIFUFM_API_URL || 'https://api.zhifux.com'; 
        
        if (!MERCHANT_NUM || !SECRET_KEY) throw new Error('Missing gateway config');

        const amountStr = (amountCents / 100).toFixed(2); // Cents to Yuan
        const notifyUrl = `${process.env.APP_BASE_URL || 'https://api.moodspace.xyz'}/api/payment/notify`;
        const returnUrl = `${process.env.FRONTEND_URL || 'https://www.moodspace.xyz'}/upgrade?order_no=${orderNo}`;

        // MD5: merchantNum + orderNo + amount + notifyUrl + secret_key
        const signStr = `${MERCHANT_NUM}${orderNo}${amountStr}${notifyUrl}${SECRET_KEY}`;
        const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

        const params = new URLSearchParams({
            merchantNum: MERCHANT_NUM,
            orderNo: orderNo,
            amount: amountStr,
            notifyUrl: notifyUrl,
            returnUrl: returnUrl,
            payType: payType || 'alipay',
            sign: sign,
            returnType: 'json',
            apiMode: 'post_form' // Ensure POST callback to match our router.post('/notify')
        });

        console.log('[requestZhifuFmUrl] Requesting:', `${BASE_API_URL}/startOrder`, params.toString());

        const res = await fetch(`${BASE_API_URL}/startOrder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        const data = await res.json();
        if (data && data.success && data.data && data.data.payUrl) {
            return { success: true, payUrl: data.data.payUrl };
        } else {
            console.error('[requestZhifuFmUrl] Gateway rejected:', data);
            return { success: false, msg: data ? data.msg : 'Gateway returned empty response' };
        }
    } catch(e) {
        console.error('[requestZhifuFmUrl] Fatal:', e);
        return { success: false, msg: e.message };
    }
}

/**
 * POST|GET /api/payment/notify
 * L6.5 Async Webhook Receiver
 * - Rejects fast if signature fails
 * - Pushes to payment_jobs
 * - Returns "success" string immediately
 */
router.all('/notify', async (req, res) => {
    const payload = req.method === 'POST' ? req.body : req.query;
    
    try {
        console.log('[payment/notify] Webhook Received:', payload);

        const MERCHANT_NUM = process.env.ZHIFUFM_MERCHANT_NUM;
        const SECRET_KEY = process.env.ZHIFUFM_SECRET_KEY;

        const { state, merchantNum, orderNo: incOrderNo, amount: incAmount, sign: incomingSign, platformOrderNo } = payload;
        
        const orderNo = incOrderNo || payload.out_trade_no;
        const thirdPartyNo = platformOrderNo || payload.trade_no;

        if (!orderNo) {
            return res.status(400).send("fail");
        }

        // Fast-exit: only process successful payment notifications (state=1)
        // ZhifuFM state: 1=success, others are non-actionable
        if (String(state) !== '1') {
            console.log('[payment/notify] Ignoring notification with state:', state);
            return res.status(200).send("success");
        }

        // 1. Signature Verification
        // MD5: state + merchantNum + orderNo + amount + secret_key
        const signStr = `${state}${merchantNum}${incOrderNo}${incAmount}${SECRET_KEY}`;
        const computedSign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();
        
        const isValid = (computedSign === incomingSign && merchantNum === MERCHANT_NUM);

        // ZhifuFM amount is string in yuan, parse back to int CENTS
        const paidAmount = parseInt(parseFloat(incAmount || '0') * 100, 10);

        // 2. Log Payload (always log to help debugging, even for invalid)
        await supabase.from('payment_logs').insert({
            order_no: orderNo,
            provider: 'zhifufm',
            payload: payload,
            is_valid: isValid,
            error_msg: isValid ? null : 'Signature verification failed'
        });

        if (!isValid) {
            console.warn('[payment/notify] Invalid signature for order:', orderNo);
            return res.status(400).send("fail"); // Malicious payload
        }

        // 3. Push to Durable Queue (payment_jobs)
        // Use the third-party platform order no as idempotency key to absorb duplicate webhooks.
        // If the same platformOrderNo fires 20 times, only one job row is stored.
        const idempotencyKey = thirdPartyNo || orderNo; // fallback to our own order_no
        const { error: jobErr } = await supabase.from('payment_jobs').upsert(
            { 
                order_no: orderNo,
                idempotency_key: idempotencyKey,
                paid_amount: paidAmount,
                third_party_no: thirdPartyNo || 'TID_UNKNOWN',
                status: 'pending'
            },
            { onConflict: 'idempotency_key', ignoreDuplicates: true }
        );

        if (jobErr) {
            console.error('[payment/notify] Failed to persist job:', jobErr);
        }

        // 4. Immediate Return for ZhifuFM (L6.5 Async Engine)
        return res.status(200).send("success");

    } catch (err) {
        console.error('[payment/notify] Fatal:', err);
        // Do not return success if we completely exploded before saving anything. 
        // Force provider to retry.
        return res.status(500).send("fail"); 
    }
});

/**
 * GET /api/payment/query 
 * Safe Polling Endpoint for Frontend UX
 */
router.get('/query', async (req, res) => {
    try {
        const { order_no } = req.query;
        if (!order_no) return res.status(400).json({ success: false, error: "Missing order_no" });

        const { data: order, error } = await supabase
            .from('orders')
            .select('status')
            .eq('order_no', order_no)
            .maybeSingle();

        if (error || !order) return res.status(404).json({ success: false, error: 'Order not found' });

        return res.json({ success: true, status: order.status });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Query failed' });
    }
});

/**
 * GET /api/payment/history 
 * Get order history for a user
 */
router.get('/history', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ success: false, error: "Missing userId" });

        const { data: orders, error } = await supabase
            .from('orders')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        
        return res.json({ success: true, data: orders });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'History fetch failed' });
    }
});

/**
 * GET /api/payment/admin/orders
 * Fetch all orders for management — admin only
 */
router.get('/admin/orders', requireAdminKey, async (req, res) => {
    try {
        const { data: orders, error } = await supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        return res.json({ success: true, data: orders });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch admin orders' });
    }
});

/**
 * POST /api/payment/admin/compensate
 * Manual Grants & Compensation
 */
router.post('/admin/compensate', async (req, res) => {
    try {
        const { targetUserId, targetTier, durationMonths, reason, adminId } = req.body;
        if (!targetUserId || !targetTier) return res.status(400).json({ success: false, error: 'Missing args' });

        // 1. Log to compensation_logs
        await supabase.from('compensation_logs').insert({
            admin_id: adminId || 'unknown_admin',
            target_user_id: targetUserId,
            target_tier: targetTier,
            duration_months: durationMonths || 1,
            reason: reason || 'Manual grant'
        });

        // 2. We'd ideally call an RPC to safely grant this, but for brevity we directly update profile 
        // Note: Real system should trace this via the `subscriptions` table.
        const { error: updErr } = await supabase
            .from('profiles')
            .update({ tier: targetTier }) // Simplification
            .eq('id', targetUserId);

        if (updErr) throw updErr;

        return res.json({ success: true, message: 'Granted successfully' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Compensation failed' });
    }
});

// Shared admin key middleware for pricing routes
function requireAdminKey(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, error: 'Forbidden: invalid admin key' });
    }
    next();
}

/**
 * GET /api/payment/admin/pricing
 * Fetch all pricing configs (including inactive ones) — admin only
 */
router.get('/admin/pricing', requireAdminKey, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pricing_configs')
            .select('*')
            .order('sort_order', { ascending: true });
        if (error) throw error;
        return res.json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch' });
    }
});

/**
 * POST /api/payment/admin/pricing
 * Create or update a pricing configuration — admin only
 */
router.post('/admin/pricing', requireAdminKey, async (req, res) => {
    try {
        const { id, tier, duration_months, display_name, base_price, first_month_price, renewal_price, discount_label, is_active, sort_order } = req.body;
        
        if (!tier || duration_months == null || base_price == null) {
            return res.status(400).json({ success: false, error: 'Missing required fields: tier, duration_months, base_price' });
        }

        // All price fields MUST be stored as whole integers (cents).
        // Use Math.round() to guard against any floating-point values sent from clients.
        const parseCents = (val) => {
            if (val == null || val === '') return null;
            const n = Math.round(parseFloat(val));
            if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid price value: ${val}`);
            return n;
        };

        const basePriceCents = parseCents(base_price);
        if (!basePriceCents || basePriceCents <= 0) {
            return res.status(400).json({ success: false, error: 'base_price must be a positive integer (cents)' });
        }

        const payload = {
            tier,
            duration_months: parseInt(duration_months),
            display_name: display_name || null,
            base_price: basePriceCents,
            first_month_price: parseCents(first_month_price),
            renewal_price: parseCents(renewal_price),
            discount_label: discount_label || null,
            is_active: is_active !== undefined ? Boolean(is_active) : true,
            sort_order: sort_order ? parseInt(sort_order) : 0,
            updated_at: new Date().toISOString()
        };

        let result;
        if (id) {
            result = await supabase.from('pricing_configs').update(payload).eq('id', id).select();
        } else {
            result = await supabase.from('pricing_configs').insert(payload).select();
        }

        if (result.error) throw result.error;
        return res.json({ success: true, data: result.data[0] });
    } catch (err) {
        console.error('[Admin Pricing] Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/payment/admin/pricing/:id — admin only
 */
router.delete('/admin/pricing/:id', requireAdminKey, async (req, res) => {
    try {
        const { error } = await supabase.from('pricing_configs').delete().eq('id', req.params.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
