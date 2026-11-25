import { join } from 'node:path';
import { App, Duration, Stack, Stage } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../src/PipelineStack';

test('The configuration reaches the deployed stack', () => {
  const env = { account: '123456789012', region: 'eu-central-1' };
  const pipeline = new PipelineStack(new App(), 'pipeline', {
    env,
    configuration: {
      branch: 'test',
      deployFromEnvironment: env,
      deployToEnvironment: env,
      attachmentRetention: Duration.days(1),
      truststorePath: join(__dirname, 'fixtures/test-ca.pem'),
      allowedFingerprints: ['a'.repeat(64)],
    },
  });
  const stage = pipeline.node.findChild('corsa-mock') as Stage;
  const template = Template.fromStack(stage.node.findChild('api') as Stack);

  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ ALLOWED_CERT_FINGERPRINTS: 'a'.repeat(64) }) },
  });
  template.hasOutput('url', {
    Value: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('^https://corsa-mock\\.')])] },
  });
  for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
    expect(role.Properties.PermissionsBoundary).toBeDefined();
  }
});
