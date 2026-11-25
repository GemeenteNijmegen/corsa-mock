import { X509Certificate } from 'node:crypto';

export interface ClientCertificate {
  /**
   * SHA-256 fingerprint, in the format of `normalizeFingerprint`.
   */
  fingerprint: string;
  subject: string;
}

/**
 * Reads the parts of a client certificate that are needed to recognise it. Returns undefined
 * when there is no certificate or it cannot be read.
 */
export function readClientCertificate(pem: string | undefined): ClientCertificate | undefined {
  if (!pem) {
    return undefined;
  }
  try {
    const certificate = new X509Certificate(pem);
    return { fingerprint: normalizeFingerprint(certificate.fingerprint256), subject: certificate.subject };
  } catch {
    return undefined;
  }
}

/**
 * Lowercase hex without colons, so that fingerprints in different notations can be compared.
 */
export function normalizeFingerprint(value: string): string {
  const fingerprint = value.replace(/:/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`"${value}" is not a SHA-256 fingerprint (64 hexadecimal characters, with or without colons)`);
  }
  return fingerprint;
}
