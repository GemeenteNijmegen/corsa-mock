import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { MtlsApi } from '../src/MtlsApi';

const TEST_CA = join(__dirname, 'fixtures/test-ca.pem');
const TEST_CLIENT = join(__dirname, 'fixtures/test-client-allowed.pem');

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'truststore-')); });
afterEach(() => { rmSync(directory, { recursive: true }); });

function synth(truststorePath: string): Template {
  const stack = new Stack(new App(), 'test');
  new MtlsApi(stack, 'api', {
    handler: new Function(stack, 'handler', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => {};'),
    }),
    hostedZone: HostedZone.fromHostedZoneAttributes(stack, 'zone', { hostedZoneId: 'Z123', zoneName: 'example.com' }),
    subdomain: 'corsa-mock',
    truststorePath,
  });
  return Template.fromStack(stack);
}

function pemFile(content: string): string {
  const path = join(directory, 'truststore.pem');
  writeFileSync(path, content);
  return path;
}

function truststoreUri(template: Template): string {
  const [domain] = Object.values(template.findResources('AWS::ApiGateway::DomainName'));
  return JSON.stringify(domain.Properties.MutualTlsAuthentication.TruststoreUri);
}

test('The API is only reachable through the mTLS domain', () => {
  const template = synth(TEST_CA);

  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    DisableExecuteApiEndpoint: true,
    EndpointConfiguration: { Types: ['REGIONAL'] },
  });
  template.hasResourceProperties('AWS::ApiGateway::DomainName', {
    DomainName: 'corsa-mock.example.com',
    MutualTlsAuthentication: { TruststoreUri: Match.anyValue() },
    SecurityPolicy: 'TLS_1_2',
  });
  template.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
  template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'corsa-mock.example.com.', Type: 'A' });
});

test('Every method waits 29 seconds for the Lambda', () => {
  const methods = Object.values(synth(TEST_CA).findResources('AWS::ApiGateway::Method'));

  expect(methods.length).toBeGreaterThan(0);
  for (const method of methods) {
    expect(method.Properties.Integration.TimeoutInMillis).toBe(29000);
  }
});

test('The trust store is uploaded before the domain uses it', () => {
  const template = synth(TEST_CA);
  const [domain] = Object.values(template.findResources('AWS::ApiGateway::DomainName'));
  const deployments = Object.keys(template.findResources('Custom::CDKBucketDeployment', { Properties: { Prune: false } }));

  expect(deployments).toHaveLength(1);
  expect(domain.DependsOn).toEqual(expect.arrayContaining(deployments));
});

test('A changed trust store gets another URI', () => {
  const ca = readFileSync(TEST_CA, 'utf8');

  expect(truststoreUri(synth(pemFile(ca)))).toBe(truststoreUri(synth(TEST_CA)));
  expect(truststoreUri(synth(pemFile(ca + ca)))).not.toBe(truststoreUri(synth(TEST_CA)));
});

test('An invalid trust store fails synth', () => {
  const ca = readFileSync(TEST_CA, 'utf8');
  // Split, so that secret scanners do not take this for a key.
  const key = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

  expect(() => synth(join(directory, 'missing.pem'))).toThrow(/does not exist/);
  expect(() => synth(pemFile(`${ca}\n${key}`))).toThrow(/contains a private key/);
  expect(() => synth(pemFile(''))).toThrow(/contains no certificate/);
  expect(() => synth(pemFile(ca + readFileSync(TEST_CLIENT, 'utf8')))).toThrow(/not a CA/);
});

test('The trust store bucket is private and only accepts TLS', () => {
  const template = synth(TEST_CA);

  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
    VersioningConfiguration: { Status: 'Enabled' },
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]),
    },
  });
});

test('The disabled execute-api URL is not an output', () => {
  expect(synth(TEST_CA).findOutputs('*')).toEqual({});
});
