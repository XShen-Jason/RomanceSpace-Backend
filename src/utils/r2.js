/**
 * Cloudflare R2 helper.
 * Uses the S3-compatible API via @aws-sdk/client-s3.
 * Credentials (Access Key + Secret) are R2 API tokens, NOT the CF global token.
 */
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getMime } = require('./mime');

let _client;

function getClient() {
    if (!_client) {
        _client = new S3Client({
            region: 'auto',
            endpoint: process.env.CF_R2_ENDPOINT,
            credentials: {
                accessKeyId: process.env.CF_R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
            },
        });
    }
    return _client;
}

/**
 * Upload a buffer/stream to R2.
 * @param {string} key         - R2 object key (e.g. "templates/theme/v1/index.html")
 * @param {Buffer|Uint8Array}  body
 * @param {string} [contentType]
 */
async function r2Put(key, body, contentType) {
    const client = getClient();
    await client.send(
        new PutObjectCommand({
            Bucket: process.env.CF_R2_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType ?? getMime(key),
        })
    );
}

/**
 * Get an R2 object as a Buffer. Returns null if not found.
 * @param {string} key
 * @returns {Promise<Buffer|null>}
 */
async function r2Get(key) {
    const client = getClient();
    try {
        const res = await client.send(
            new GetObjectCommand({ Bucket: process.env.CF_R2_BUCKET, Key: key })
        );
        const chunks = [];
        for await (const chunk of res.Body) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

/**
 * List R2 objects with a given prefix. Returns array of key strings.
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
async function r2List(prefix) {
    const client = getClient();
    const res = await client.send(
        new ListObjectsV2Command({ Bucket: process.env.CF_R2_BUCKET, Prefix: prefix })
    );
    return (res.Contents ?? []).map((obj) => obj.Key);
}

/**
 * Delete a single object from R2.
 */
async function r2Delete(key) {
    const client = getClient();
    await client.send(
        new DeleteObjectCommand({ Bucket: process.env.CF_R2_BUCKET, Key: key })
    );
}

/**
 * Delete multiple objects from R2 (Max 1000 per call).
 * @param {string[]} keys - Array of keys to delete.
 */
async function r2DeleteObjects(keys) {
    if (!keys || keys.length === 0) return;
    const client = getClient();
    // Chunk keys into 1000s if necessary
    const chunks = [];
    for (let i = 0; i < keys.length; i += 1000) {
        chunks.push(keys.slice(i, i + 1000));
    }

    for (const chunk of chunks) {
        await client.send(
            new DeleteObjectsCommand({
                Bucket: process.env.CF_R2_BUCKET,
                Delete: {
                    Objects: chunk.map(k => ({ Key: k }))
                }
            })
        );
    }
}

module.exports = { r2Put, r2Get, r2List, r2Delete, r2DeleteObjects };
