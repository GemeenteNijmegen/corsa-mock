import { join } from 'node:path';
import { App, Duration } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CorsaMockStack } from '../src/CorsaMockStack';

const DEFAULT_PROPS = {
  attachmentRetention: Duration.days(1),
  truststorePath: join(__dirname, 'fixtures/test-ca.pem'),
};

test('Snapshot', () => {
  const app = new App();
  const stack = new CorsaMockStack(app, 'test', DEFAULT_PROPS);

  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});

test('Attachments expire after the configured retention', () => {
  const app = new App();
  const stack = new CorsaMockStack(app, 'test', { ...DEFAULT_PROPS, attachmentRetention: Duration.days(30) });

  Template.fromStack(stack).hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: {
      Rules: [Match.objectLike({
        ExpirationInDays: 30,
        TagFilters: [{ Key: 'type', Value: 'attachment' }],
      })],
    },
  });
});

test('Failure injection settings are passed to the Lambda', () => {
  const app = new App();
  const stack = new CorsaMockStack(app, 'test', {
    ...DEFAULT_PROPS,
    failure: {
      percentage: 25,
      modes: ['timeout', 'lost-response'],
      operations: ['creeerZaak', 'voegZaakdocumentToe'],
      seed: 'run-1',
      timeout: Duration.seconds(25),
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        FAILURE_PERCENTAGE: '25',
        FAILURE_MODES: 'timeout,lost-response',
        FAILURE_OPERATIONS: 'creeerZaak,voegZaakdocumentToe',
        FAILURE_SEED: 'run-1',
        FAILURE_TIMEOUT_MS: '25000',
      }),
    },
  });
});

test('Failure timeout can be at most 27 seconds', () => {
  const stackWithTimeout = (seconds: number) => new CorsaMockStack(new App(), 'test', {
    ...DEFAULT_PROPS,
    failure: { timeout: Duration.seconds(seconds) },
  });

  expect(() => stackWithTimeout(27)).not.toThrow();
  expect(() => stackWithTimeout(28)).toThrow(/at most 27 seconds/);
});

test('The Lambda times out no later than API Gateway', () => {
  const stack = new CorsaMockStack(new App(), 'test', DEFAULT_PROPS);

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', { Timeout: 29 });
});

test('The mTLS domain is the only way in', () => {
  const template = Template.fromStack(new CorsaMockStack(new App(), 'test', DEFAULT_PROPS));

  template.resourceCountIs('AWS::Lambda::Url', 0);
  template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  template.hasResourceProperties('AWS::ApiGateway::RestApi', { DisableExecuteApiEndpoint: true });
  template.hasResourceProperties('AWS::ApiGateway::DomainName', { MutualTlsAuthentication: Match.anyValue() });
});

test('The state bucket keeps its logical id', () => {
  const template = Template.fromStack(new CorsaMockStack(new App(), 'test', DEFAULT_PROPS));

  expect(template.toJSON().Resources).toHaveProperty('stateEC29AD4A');
});
