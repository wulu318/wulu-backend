'use strict';

// Minimal multipart/form-data reader built on busboy. Express 5 does not parse
// multipart bodies, and the desktop client uploads share archives that way.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FIELDS = 100;

/**
 * Parse a multipart request into { fields, files }.
 * Files are written to a temp directory and must be cleaned up by the caller.
 */
function parseMultipart(req, { maxFileBytes = MAX_FILE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let tempDir = null;
    const fields = {};
    const files = {};
    const pending = [];
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: maxFileBytes, fields: MAX_FIELDS, files: 3 },
      });
    } catch (err) {
      return reject(err);
    }

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, stream, info) => {
      const task = (async () => {
        if (!tempDir) tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wulu-upload-'));
        const safeName = (info.filename || 'upload.bin').replace(/[^a-zA-Z0-9._-]+/g, '_');
        const target = path.join(tempDir, `${crypto.randomUUID()}-${safeName}`);
        const out = fs.createWriteStream(target);
        let bytes = 0;
        let truncated = false;

        await new Promise((res, rej) => {
          stream.on('data', (chunk) => { bytes += chunk.length; });
          stream.on('limit', () => { truncated = true; });
          stream.on('error', rej);
          out.on('error', rej);
          out.on('close', res);
          stream.pipe(out);
        });

        files[name] = { path: target, filename: safeName, bytes, mimeType: info.mimeType, truncated };
      })();
      pending.push(task);
    });

    busboy.on('error', fail);
    busboy.on('close', () => {
      Promise.all(pending)
        .then(() => {
          if (settled) return;
          settled = true;
          resolve({
            fields,
            files,
            cleanup: () => (tempDir ? fsp.rm(tempDir, { recursive: true, force: true }) : Promise.resolve()),
          });
        })
        .catch(fail);
    });

    req.pipe(busboy);
  });
}

module.exports = { parseMultipart, MAX_FILE_BYTES };
