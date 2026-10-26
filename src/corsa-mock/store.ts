import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

export interface PutOptions {
  contentType?: string;
  /**
   * Only write when the key does not exist yet. `put` returns false when it already exists.
   */
  createOnly?: boolean;
  tags?: Record<string, string>;
}

/**
 * The only storage primitives the mock needs. All state is written as separate objects
 * (no read-modify-write), so concurrent Lambda invocations cannot overwrite each other.
 */
export interface ObjectStore {
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, body: string | Buffer, options?: PutOptions): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly client = new S3Client({}),
  ) {}

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
      return Buffer.from(await result.Body!.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return undefined;
      }
      throw error;
    }
  }

  async put(key: string, body: string | Buffer, options: PutOptions = {}): Promise<boolean> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: body,
        ContentType: options.contentType,
        IfNoneMatch: options.createOnly ? '*' : undefined,
        Tagging: options.tags ? new URLSearchParams(options.tags).toString() : undefined,
      }));
      return true;
    } catch (error) {
      // 412: the key exists. 409: a concurrent conditional write to the same key won.
      if (options.createOnly && error instanceof S3ServiceException
        && [409, 412].includes(error.$metadata.httpStatusCode ?? 0)) {
        return false;
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix + prefix,
        ContinuationToken: continuationToken,
      }));
      for (const object of result.Contents ?? []) {
        keys.push(object.Key!.slice(this.prefix.length));
      }
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  async get(key: string): Promise<Buffer | undefined> {
    return this.objects.get(key);
  }

  async put(key: string, body: string | Buffer, options: PutOptions = {}): Promise<boolean> {
    if (options.createOnly && this.objects.has(key)) {
      return false;
    }
    this.objects.set(key, Buffer.from(body));
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
