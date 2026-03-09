/**
 * escapeHtml — Prevent XSS when injecting user data into HTML.
 * injectData  — Replace {{key}} placeholders with user-supplied data.
 *
 * Migrated from RomanceSpace-Worker/src/index.js (single source of truth is now here).
 */

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace {{key}} placeholders in an HTML string with user data.
 * @param {string} html     - Template HTML containing {{key}} tokens
 * @param {object} data     - User-supplied key/value pairs
 * @param {object|null} schema - Template schema (for defaults, joins, wraps)
 * @returns {string}
 */
function injectData(html, data, schema) {
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const raw = data[key];
    const field = schema?.fields?.find((f) => f.key === key);

    const resolve = (val) => {
      if (Array.isArray(val)) {
        const join = field?.join ?? '<br>';
        const wrapStart = field?.wrapStart ?? '';
        const wrapEnd = field?.wrapEnd ?? '';
        return wrapStart + val.map(escapeHtml).join(join) + wrapEnd;
      }
      return escapeHtml(String(val ?? ''));
    };

    if (raw === undefined || raw === null) {
      if (!field) return '';
      return resolve(field.default ?? '');
    }
    return resolve(raw);
  });
}

module.exports = { escapeHtml, injectData };
