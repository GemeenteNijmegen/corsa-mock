import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { normalizeFingerprint } from './corsa-mock/clientCertificate';
import { ATTACHMENT_TAG, FailureMode } from './corsa-mock/config';
import { CorsaMockFunction } from './corsa-mock/corsa-mock-function';
import { MtlsApi } from './MtlsApi';
import { Statics } from './Statics';

export interface CorsaMockStackProps extends StackProps {
  /**
   * How long uploaded documents (attachments) are kept in the bucket.
   */
  attachmentRetention: Duration;
  /**
   * PEM file with the public certificates of the CAs that sign client certificates.
   */
  truststorePath: string;
  /**
   * SHA-256 fingerprints of the client certificates that are accepted. Empty means none.
   */
  allowedFingerprints: string[];
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
   * How long the `timeout` mode waits before answering. At most 27 seconds.
   * @default Duration.seconds(25)
   */
  timeout?: Duration;
}

// API Gateway stops waiting after 29 seconds, so running longer has no use.
const LAMBDA_TIMEOUT = Duration.seconds(29);

// Leaves 2 seconds for storage calls and a cold start.
const MAX_FAILURE_TIMEOUT = LAMBDA_TIMEOUT.minus(Duration.seconds(2));

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

    const failureTimeout = props.failure?.timeout;
    if (failureTimeout && failureTimeout.toMilliseconds() > MAX_FAILURE_TIMEOUT.toMilliseconds()) {
      throw new Error(`failure.timeout must be at most ${MAX_FAILURE_TIMEOUT.toHumanString()}`);
    }

    const mock = new CorsaMockFunction(this, 'function', {
      timeout: LAMBDA_TIMEOUT,
      memorySize: 512,
      logGroup: new LogGroup(this, 'logs', { retention: RetentionDays.ONE_MONTH }),
      environment: {
        MOCK_BUCKET: bucket.bucketName,
        ALLOWED_CERT_FINGERPRINTS: props.allowedFingerprints.map(normalizeFingerprint).join(','),
        ...failureEnvironment(props.failure),
      },
    });
    bucket.grantReadWrite(mock);

    const api = new MtlsApi(this, 'mtls-api', {
      handler: mock,
      hostedZone: HostedZone.fromHostedZoneAttributes(this, 'hosted-zone', {
        hostedZoneId: StringParameter.valueForStringParameter(this, Statics.ssmHostedZoneId),
        zoneName: StringParameter.valueForStringParameter(this, Statics.ssmHostedZoneName),
      }),
      subdomain: Statics.subdomain,
      truststorePath: props.truststorePath,
    });

    new CfnOutput(this, 'url', {
      value: `https://${api.domainName}/`,
      description: 'The ZAAKDMS_URL. Requires a client certificate',
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
