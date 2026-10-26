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
