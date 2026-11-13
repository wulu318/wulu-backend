'use strict';

// Maps a share_deployments row to the shape the desktop client expects.
function isoOrUndefined(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function toDeploymentPayload(row, events = []) {
  return {
    deploymentId: row.id,
    shareId: row.share_id,
    deploymentKind: row.deployment_kind,
    deploymentStatus: row.status,
    status: row.status,
    runtimeLanguage: row.runtime_language || undefined,
    runtimeVersion: row.runtime_version || undefined,
    packageManager: row.package_manager || undefined,
    installCommand: row.install_command || undefined,
    buildCommand: row.build_command || undefined,
    startCommand: row.start_command || undefined,
    listenPort: row.listen_port || undefined,
    sourceSha256: row.source_sha256 || undefined,
    sourceArchiveBytes: row.source_archive_bytes || undefined,
    provider: row.provider || undefined,
    region: row.region || undefined,
    providerResourceId: row.provider_resource_id || undefined,
    runtimeUrlMasked: row.runtime_url_masked || undefined,
    persistence: safeParse(row.persistence_json, null),
    expiresAt: isoOrUndefined(row.expires_at),
    failureCode: row.failure_code || undefined,
    failureMessage: row.failure_message || undefined,
    createdAt: isoOrUndefined(row.created_at),
    updatedAt: isoOrUndefined(row.updated_at),
    events: events.map((event) => ({
      type: event.type,
      message: event.message || '',
      createdAt: isoOrUndefined(event.created_at),
    })),
  };
}

module.exports = { toDeploymentPayload };
