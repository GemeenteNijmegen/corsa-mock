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
      timeout: Duration.seconds(40),
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        FAILURE_PERCENTAGE: '25',
        FAILURE_MODES: 'timeout,lost-response',
        FAILURE_OPERATIONS: 'creeerZaak,voegZaakdocumentToe',
        FAILURE_SEED: 'run-1',
        FAILURE_TIMEOUT_MS: '40000',
      }),
    },
  });
});

test('Failure timeout must be shorter than the Lambda timeout', () => {
  const app = new App();
  expect(() => new CorsaMockStack(app, 'test', {
    attachmentRetention: Duration.days(1),
    failure: { timeout: Duration.minutes(2) },
  })).toThrow(/shorter than the Lambda timeout/);
});
