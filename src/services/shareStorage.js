'use strict';

// Storage + helpers for artifact shares and service deployments.
// Everything user-supplied stays under SHARE_UPLOAD_DIR (default <repo>/data/shares).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_COUNT = 5000;
const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024;

function shareRoot() {
  return process.env.SHARE_UPLOAD_DIR
    ? path.resolve(process.env.SHARE_UPLOAD_DIR)
    : path.join(__dirname, '..', '..', 'data', 'shares');
}

function shareDir(shareId) {
  return path.join(shareRoot(), sanitizeId(shareId));
}

function contentDir(shareId) {
  return path.join(shareDir(shareId), 'content');
}

function sanitizeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'share';
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Resolve a path inside `root`, refusing anything that escapes it.
function resolveInside(root, relative) {
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
    throw new Error('Path escapes the target directory');
  }
  return target;
}

function extractZip(zipPath, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);

      let entries = 0;
      let totalBytes = 0;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* already closed */ }
        reject(error);
      };

      zipfile.on('error', fail);

      zipfile.on('entry', (entry) => {
        if (settled) return;
        entries += 1;
        if (entries > MAX_ENTRY_COUNT) return fail(new Error('Archive contains too many entries'));

        const name = entry.fileName.replace(/\\/g, '/');

        // Reject absolute paths, drive letters, parent traversal and symlinks.
        if (
          name.startsWith('/') ||
          /^[a-zA-Z]:/.test(name) ||
          name.split('/').includes('..') ||
          (entry.externalFileAttributes >>> 16) === 0o120000
        ) {
          return fail(new Error('Archive contains an unsafe entry'));
        }
        if (name.endsWith('/')) {
          entries -= 1;
          return zipfile.readEntry();
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) return fail(streamErr);

          let target;
          try {
            target = resolveInside(destination, name);
          } catch (resolveErr) {
            readStream.destroy();
            return fail(resolveErr);
          }

          fsp.mkdir(path.dirname(target), { recursive: true })
            .then(() => {
              const writeStream = fs.createWriteStream(target);
              readStream.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_TOTAL_UNCOMPRESSED) {
                  readStream.destroy();
                  writeStream.destroy();
                  fail(new Error('Archive expands beyond the size limit'));
                }
              });
              readStream.on('error', fail);
              writeStream.on('error', fail);
              writeStream.on('close', () => {
                if (settled) return;
                zipfile.readEntry();
              });
              readStream.pipe(writeStream);
            })
            .catch(fail);
        });
      });

      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, totalBytes });
      });

      zipfile.readEntry();
    });
  });
}

function randomShareCode() {
  // URL friendly, enough entropy to be typed by hand (6 groups of 4-ish chars).
  return crypto.randomBytes(6).toString('hex').match(/.{1,4}/g).join('-');
}

function removeTree(target) {
  return fsp.rm(target, { recursive: true, force: true });
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  shareRoot,
  shareDir,
  contentDir,
  sanitizeId,
  ensureDir,
  sha256File,
  resolveInside,
  extractZip,
  randomShareCode,
  removeTree,
};
