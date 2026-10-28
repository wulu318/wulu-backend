'use strict';
const yauzl = require('yauzl');
const { ZipFile } = require('yazl');
const fs = require('fs');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { inspectArchive } = require('./communityArchive');

// Give each approved skill a stable installation directory and version. The
// client's skill ID comes from this directory, rather than its display name.
async function normalizeSkillArchive(source, target, skillId, metadata) {
  const inspection = await inspectArchive(source);
  const skills = inspection.files.filter(file => /(^|\/)SKILL\.md$/.test(file.name));
  if (skills.length !== 1) throw new Error('A single skill submission must contain exactly one SKILL.md');
  const root = skills[0].name.slice(0, -'SKILL.md'.length);
  const original = inspection.documents[skills[0].name];
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(original);
  const header = match ? match[1].split(/\r?\n/).filter(line => !/^version\s*:/.test(line)).join('\n')
    : `name: ${JSON.stringify(metadata.name)}\ndescription: ${JSON.stringify(metadata.description)}`;
  const document = `---\n${header}\nversion: ${JSON.stringify(metadata.version)}\n---\n${match ? original.slice(match[0].length) : original}`;
  const input = await new Promise((resolve, reject) => yauzl.open(source, { lazyEntries: true, autoClose: false }, (error, zip) => error ? reject(error) : resolve(zip)));
  const output = new ZipFile();
  const hash = crypto.createHash('sha256');
  let size = 0;
  const writing = pipeline(output.outputStream, new Transform({ transform(chunk, encoding, callback) {
    hash.update(chunk); size += chunk.length; callback(null, chunk);
  } }), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  input.on('error', error => output.outputStream.destroy(error));
  input.on('entry', entry => {
    if (entry.fileName.startsWith(root) && !entry.fileName.endsWith('/')) {
      const relative = entry.fileName.slice(root.length);
      if (relative === 'SKILL.md') output.addBuffer(Buffer.from(document), `${skillId}/SKILL.md`);
      else output.addReadStreamLazy(`${skillId}/${relative}`, { mode: (entry.externalFileAttributes >>> 16) || 0o100644 }, callback => input.openReadStream(entry, callback));
    }
    input.readEntry();
  });
  input.on('end', () => output.end());
  input.readEntry();
  try { await writing; }
  finally { input.close(); }
  return { size, sha256: hash.digest('hex'), inspection: await inspectArchive(target) };
}
module.exports = { normalizeSkillArchive };
