'use strict';
const yauzl = require('yauzl');

// Inspect untrusted archives without extracting or running their contents.
function inspectArchive(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new Error('Invalid ZIP archive'));
      const files = [];
      const documents = {};
      const seen = new Set();
      let total = 0;
      let failed = false;
      const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('entry', entry => {
        const name = entry.fileName;
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..')
          || /^[a-z]:/i.test(name) || ![0, 0o100000, 0o040000].includes(mode)
          || ((entry.externalFileAttributes >>> 16) & 0o6000) || (entry.generalPurposeBitFlag & 1)) {
          return fail(new Error('ZIP contains unsafe paths, links or encrypted files'));
        }
        if (/(^|\/)(\.env(?:\.[^/]*)?|id_rsa|id_ed25519|\.git)(\/|$)/i.test(name) || /\.(pem|key)$/i.test(name)) {
          return fail(new Error('Remove secrets and private keys before uploading'));
        }
        if (seen.has(name.toLowerCase())) return fail(new Error('ZIP contains duplicate paths'));
        seen.add(name.toLowerCase());
        total += entry.uncompressedSize;
        if (files.length >= 1000 || total > 100 * 1024 * 1024) return fail(new Error('ZIP exceeds 1000 entries or 100 MiB unpacked'));
        files.push({ name, size: entry.uncompressedSize });
        if (/(^|\/)(SKILL\.md|kit\.json)$/i.test(name)) {
          if (entry.uncompressedSize > 65536) return fail(new Error('Skill documentation is too large'));
          zip.openReadStream(entry, (error, stream) => {
            if (error) return fail(error);
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('error', fail);
            stream.on('end', () => { documents[name] = Buffer.concat(chunks).toString('utf8'); if (!failed) zip.readEntry(); });
          });
        } else zip.readEntry();
      });
      zip.on('end', () => { if (!failed) resolve({ files, documents, unpackedSize: total }); });
      zip.readEntry();
    });
  });
}
module.exports = { inspectArchive };
