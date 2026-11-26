import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { EndpointType, LambdaRestApi, SecurityPolicy } from 'aws-cdk-lib/aws-apigateway';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface MtlsApiProps {
  /**
   * Receives every request.
   */
  handler: IFunction;
  hostedZone: IHostedZone;
  /**
   * Name of the API's domain within the hosted zone.
   */
  subdomain: string;
  /**
   * PEM file with the public certificates of the CAs that client certificates are verified against.
   */
  truststorePath: string;
}

/**
 * A REST API that passes every request to a Lambda. It is only reachable through a custom
 * domain that requires a client certificate.
 */
export class MtlsApi extends Construct {
  readonly domainName: string;

  constructor(scope: Construct, id: string, props: MtlsApiProps) {
    super(scope, id);
    this.domainName = `${props.subdomain}.${props.hostedZone.zoneName}`;

    const truststore = this.truststore(readTruststore(props.truststorePath));

    const api = new LambdaRestApi(this, 'api', {
      restApiName: 'corsa-mock',
      handler: props.handler,
      proxy: true,
      integrationOptions: { timeout: Duration.seconds(29) },
      endpointTypes: [EndpointType.REGIONAL],
      disableExecuteApiEndpoint: true,
      cloudWatchRole: false,
      domainName: {
        domainName: this.domainName,
        endpointType: EndpointType.REGIONAL,
        certificate: new Certificate(this, 'certificate', {
          domainName: this.domainName,
          validation: CertificateValidation.fromDns(props.hostedZone),
        }),
        securityPolicy: SecurityPolicy.TLS_1_2,
        mtls: { bucket: truststore.bucket, key: truststore.key },
      },
    });
    api.node.tryRemoveChild('Endpoint'); // The output with the disabled execute-api URL
    // API Gateway reads the trust store when the domain is created or its URI changes.
    api.domainName!.node.addDependency(truststore.deployment);

    new ARecord(this, 'record', {
      zone: props.hostedZone,
      recordName: props.subdomain,
      target: RecordTarget.fromAlias(new ApiGatewayDomain(api.domainName!)),
    });
  }

  private truststore(pem: string) {
    const bucket = new Bucket(this, 'truststore', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY, // The content is in this repository
      autoDeleteObjects: true,
    });

    // API Gateway only reloads the trust store when its URI changes, so the key follows the content.
    const key = `truststore-${createHash('sha256').update(pem).digest('hex').slice(0, 16)}.pem`;
    const deployment = new BucketDeployment(this, 'truststore-deployment', {
      destinationBucket: bucket,
      sources: [Source.data(key, pem)],
      prune: false, // The domain uses the old object until it has switched to the new one
      logGroup: new LogGroup(this, 'truststore-deployment-logs', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    return { bucket, key, deployment };
  }
}

function readTruststore(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`Trust store ${path} does not exist`);
  }
  const pem = readFileSync(path, 'utf8');
  if (pem.includes('PRIVATE KEY')) {
    throw new Error(`Trust store ${path} contains a private key`);
  }
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (certificates.length === 0) {
    throw new Error(`Trust store ${path} contains no certificate`);
  }
  for (const certificate of certificates) {
    const { ca, subject } = new X509Certificate(certificate);
    if (!ca) {
      throw new Error(`Trust store ${path} contains a certificate that is not a CA: ${subject}`);
    }
  }
  return pem;
}
