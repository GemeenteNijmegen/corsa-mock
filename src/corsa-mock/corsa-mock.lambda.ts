import { loadConfig } from './config';
import { createHandler } from './handler';
import { S3ObjectStore } from './store';

const config = loadConfig();
if (!config.bucket) {
  throw new Error('MOCK_BUCKET must be set; without it the mock would keep no state between invocations');
}

export const handler = createHandler(config, new S3ObjectStore(config.bucket, config.prefix));
