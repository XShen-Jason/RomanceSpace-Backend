/**
 * Cloudflare KV REST API helper.
 * Docs: https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/
 *
 * Uses the CF API token (NOT R2 API tokens).
 */

const BASE = 'https://api.cloudflare.com/client/v4';

function headers() {
    return {
        Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
    };
}

function kvBase() {
    return `${BASE}/accounts/${process.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}`;
}

/**
 * Read a KV value. Returns parsed JSON if it looks like JSON, otherwise raw string.
 * Returns null if the key does not exist.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function kvGet(key) {
    const res = await fetch(`${kvBase()}/values/${encodeURIComponent(key)}`, {
        headers: headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV GET failed: ${res.status} ${await res.text()}`);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Write a value to KV. Value can be any JSON-serializable object or a string.
 * @param {string} key
 * @param {any} value
 */
async function kvPut(key, value) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const res = await fetch(`${kvBase()}/values/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
            'Content-Type': 'text/plain',
        },
        body,
    });
    if (!res.ok) throw new Error(`KV PUT failed: ${res.status} ${await res.text()}`);
}

/**
 * List all KV keys with an optional prefix.
 * Returns array of key name strings.
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function kvList(prefix = '') {
    const url = new URL(`${kvBase()}/keys`);
    if (prefix) url.searchParams.set('prefix', prefix);
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) throw new Error(`KV LIST failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return (json.result ?? []).map((k) => k.name);
}

/**
 * Delete a KV key.
 * @param {string} key
 */
async function kvDelete(key) {
    const res = await fetch(`${kvBase()}/values/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: headers(),
    });
    if (!res.ok) throw new Error(`KV DELETE failed: ${res.status} ${await res.text()}`);
}

module.exports = { kvGet, kvPut, kvList, kvDelete };
