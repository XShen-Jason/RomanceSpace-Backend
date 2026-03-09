/**
 * Admin authentication middleware.
 * Expects the `X-Admin-Key` header to equal the ADMIN_KEY env var.
 */
function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized — invalid or missing X-Admin-Key' });
    }
    next();
}

module.exports = { requireAdmin };
