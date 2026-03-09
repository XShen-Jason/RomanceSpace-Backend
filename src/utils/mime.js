/** Map file extensions to MIME types. */
function getMime(filename) {
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    return (
        {
            html: 'text/html;charset=UTF-8',
            css: 'text/css',
            js: 'application/javascript',
            json: 'application/json',
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            svg: 'image/svg+xml',
            webp: 'image/webp',
            woff: 'font/woff',
            woff2: 'font/woff2',
            ttf: 'font/ttf',
            mp3: 'audio/mpeg',
            ogg: 'audio/ogg',
        }[ext] ?? 'application/octet-stream'
    );
}

/** Generate a timestamp-based version string, e.g. v20260309152301. */
function makeVersion() {
    return 'v' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

module.exports = { getMime, makeVersion };
