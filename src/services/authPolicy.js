'use strict';

// Whether registration must prove ownership of the email address.
//
// On a self-hosted instance without an email provider, demanding a code makes signup
// impossible: the code can never be delivered. In that case verification is skipped and
// the server logs a warning once, so the operator knows what is happening.
function emailDeliveryConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function verificationRequired() {
  const explicit = String(process.env.AUTH_REQUIRE_EMAIL_VERIFICATION || '').toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return emailDeliveryConfigured();
}

let warned = false;

function warnIfUnverifiedSignup() {
  if (warned || verificationRequired()) return;
  warned = true;
  console.warn(
    '[Auth] Email delivery is not configured (RESEND_API_KEY / EMAIL_FROM), ' +
    'so signup is allowed without an email verification code. ' +
    'Set those variables, or AUTH_REQUIRE_EMAIL_VERIFICATION=true, to enforce it.',
  );
}

module.exports = { emailDeliveryConfigured, verificationRequired, warnIfUnverifiedSignup };
