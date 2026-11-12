'use strict';

// Single source for security-critical secrets. No fallback values: a missing or
// weak secret must stop the process instead of silently signing with a known key.
const MIN_SECRET_LENGTH = 32;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set. Refusing to sign or verify tokens without it.');
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return secret;
}

// Fail fast at startup so a misconfigured deployment never reaches request handling.
function assertSecretsConfigured() {
  getJwtSecret();
}

module.exports = { getJwtSecret, assertSecretsConfigured, MIN_SECRET_LENGTH };
