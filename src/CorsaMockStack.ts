import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { ATTACHMENT_TAG, FailureMode } from './corsa-mock/config';
import { CorsaMockFunction } from './corsa-mock/corsa-mock-function';

export interface CorsaMockStackProps extends StackProps {
  /**
   * How long uploaded documents (attachments) are kept in the bucket.
   */
  attachmentRetention: Duration;
  /**
   * Failure injection settings. Leave out to deploy without injected failures.
   */
  failure?: FailureInjectionOptions;
}

/**
 * Failure injection settings, passed to the Lambda as FAILURE_* environment variables.
 * Settings that are left out use the Lambda defaults. See README.
 */
export interface FailureInjectionOptions {
  /**
   * Share of requests that fail on purpose, 0-100. 0 turns failure injection off.
   * @default 0
   */
  percentage?: number;
  /**
   * Failure modes to choose from.
   * @default ['soap-fault', 'fo02', 'http503']
   */
  modes?: FailureMode[];
  /**
   * Operations that can fail, for example `creeerZaak`. Empty means all operations.
   * @default [] (all)
   */
  operations?: string[];
  /**
   * When set, failures are deterministic instead of random.
   * @default '' (random)
   */
  seed?: string;
  /**
   * How long the `timeout` mode waits before answering. Must stay below the Lambda timeout.
   * @default Duration.millis(31000)
   */
  timeout?: Duration;
}

export class CorsaMockStack extends Stack {
  constructor(scope: Construct, id: string, props: CorsaMockStackProps) {
    super(scope, id, props);
    Aspects.of(this).add(new PermissionsBoundaryAspect());


    const bucket = new Bucket(this, 'state', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: 'RemoveAttachments',
          enabled: true,
          tagFilters: { [ATTACHMENT_TAG.key]: ATTACHMENT_TAG.value },
          expiration: props.attachmentRetention,
        },
      ],
    });

    // The Function URL is public, so every request path must start with this secret.
    const pathSecret = new Secret(this, 'path-secret', {
      description: 'Path prefix required on every request to the corsa mock',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    const timeout = Duration.minutes(2); // Longer than the default FAILURE_TIMEOUT_MS of the timeout failure mode
    const failureTimeout = props.failure?.timeout;
    if (failureTimeout && failureTimeout.toMilliseconds() >= timeout.toMilliseconds()) {
      throw new Error(`failure.timeout must be shorter than the Lambda timeout (${timeout.toHumanString()})`);
    }

    const mock = new CorsaMockFunction(this, 'function', {
      timeout,
      memorySize: 512,
      logGroup: new LogGroup(this, 'logs', { retention: RetentionDays.ONE_MONTH }),
      environment: {
        MOCK_BUCKET: bucket.bucketName,
        PATH_SECRET: pathSecret.secretValue.unsafeUnwrap(),
        ...failureEnvironment(props.failure),
      },
    });
    bucket.grantReadWrite(mock);

    const url = mock.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    new CfnOutput(this, 'url', {
      value: url.url,
      description: 'Append the value of the path secret (see output path-secret-name) and a / to get the ZAAKDMS_URL',
    });

    // Output descriptions must be literal strings, so the (tokenized) secret name gets its own output.
    new CfnOutput(this, 'path-secret-name', {
      value: pathSecret.secretName,
      description: 'Name of the secret holding the path prefix for the corsa mock',
    });
  }
}

function failureEnvironment(failure?: FailureInjectionOptions): Record<string, string> {
  const environment: Record<string, string> = {};
  if (failure?.percentage !== undefined) {
    environment.FAILURE_PERCENTAGE = String(failure.percentage);
  }
  if (failure?.modes !== undefined) {
    environment.FAILURE_MODES = failure.modes.join(',');
  }
  if (failure?.operations !== undefined) {
    environment.FAILURE_OPERATIONS = failure.operations.join(',');
  }
  if (failure?.seed !== undefined) {
    environment.FAILURE_SEED = failure.seed;
  }
  if (failure?.timeout !== undefined) {
    environment.FAILURE_TIMEOUT_MS = String(failure.timeout.toMilliseconds());
  }
  return environment;
}
