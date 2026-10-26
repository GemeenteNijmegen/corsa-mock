export const FAILURE_MODES = ['soap-fault', 'fo02', 'http503', 'timeout', 'lost-response'] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

/**
 * Object tag on stored documents. The bucket's lifecycle rule expires objects with this tag.
 */
export const ATTACHMENT_TAG = { key: 'type', value: 'attachment' } as const;

export interface Config {
  /**
   * S3 bucket for state. When empty, an in-memory store is used (local runs and tests only).
   */
  bucket: string;
  /**
   * Key prefix inside the bucket, for example `zaakdms-mock/`.
   */
  prefix: string;
  /**
   * When set, every request path must start with `/<pathSecret>/`.
   */
  pathSecret: string;
  /**
   * Store every incoming request body (without document content) under `requests/`.
   */
  storeRequests: boolean;
  documentIdPrefix: string;
  failure: {
    /**
     * Share of requests that fail, 0-100.
     */
    percentage: number;
    modes: FailureMode[];
    /**
     * Operations that can fail. Empty means all operations.
     */
    operations: string[];
    /**
     * When set, failures are deterministic. See README.
     */
    seed: string;
    /**
     * How long the `timeout` mode waits before answering with 504.
     */
    timeoutMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const percentage = Number(env.FAILURE_PERCENTAGE ?? '0');
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error(`FAILURE_PERCENTAGE must be a number between 0 and 100, got "${env.FAILURE_PERCENTAGE}"`);
  }

  const modes = list(env.FAILURE_MODES ?? 'soap-fault,fo02,http503');
  const unknown = modes.filter((mode) => !(FAILURE_MODES as readonly string[]).includes(mode));
  if (unknown.length > 0 || modes.length === 0) {
    throw new Error(`FAILURE_MODES must be a comma separated subset of ${FAILURE_MODES.join(', ')}, got "${env.FAILURE_MODES}"`);
  }

  return {
    bucket: env.MOCK_BUCKET ?? '',
    prefix: env.MOCK_PREFIX ?? '',
    pathSecret: env.PATH_SECRET ?? '',
    storeRequests: (env.STORE_REQUESTS ?? 'true') !== 'false',
    documentIdPrefix: env.DOCUMENT_ID_PREFIX ?? 'MOCK-DOC-',
    failure: {
      percentage,
      modes: modes as FailureMode[],
      operations: list(env.FAILURE_OPERATIONS ?? ''),
      seed: env.FAILURE_SEED ?? '',
      timeoutMs: Number(env.FAILURE_TIMEOUT_MS ?? '31000'),
    },
  };
}

function list(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
