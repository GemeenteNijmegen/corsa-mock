import { App, Duration } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CorsaMockStack } from '../src/CorsaMockStack';

test('Snapshot', () => {
  const app = new App();
  const stack = new CorsaMockStack(app, 'test', { attachmentRetention: Duration.days(1) });

  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});

test('Attachments expire after the configured retention', () => {
  const app = new App();
  const stack = new CorsaMockStack(app, 'test', { attachmentRetention: Duration.days(30) });

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
    attachmentRetention: Duration.days(1),
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
    attachmentRetention: Duration.days(1),
    failure: { timeout: Duration.seconds(seconds) },
  });

  expect(() => stackWithTimeout(27)).not.toThrow();
  expect(() => stackWithTimeout(28)).toThrow(/at most 27 seconds/);
});

test('The Lambda times out no later than API Gateway', () => {
  const stack = new CorsaMockStack(new App(), 'test', { attachmentRetention: Duration.days(1) });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', { Timeout: 29 });
});
