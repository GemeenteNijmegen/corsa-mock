import { App, Duration } from 'aws-cdk-lib';
import { CorsaMockStack } from './CorsaMockStack';

const configs: Record<string, any> = {
  development: {
    deployToEnvironment: {
      account: '958979025885',
      region: 'eu-central-1',
    },
    attachmentRetention: Duration.days(90),
    failure: {
      percentage: 70,
      modes: ['soap-fault', 'fo02', 'http503', 'lost-response', 'timeout'],
      operations: [], // all
      seed: '123',
      timeout: Duration.seconds(59),
    },
  },
  acceptance: {
    deployToEnvironment: {
      account: '',
      region: 'eu-central-1',
    },
    attachmentRetention: Duration.days(30),
  },
  production: {
    deployToEnvironment: {
      account: '',
      region: 'eu-central-1',
    },
    attachmentRetention: Duration.days(1),
  },
};

if (!process.env.BRANCH_NAME) {
  const branchnames = Object.keys(configs);
  throw Error(`Should set a branch name for deployment: ${branchnames}`);
}
const config = configs[process.env.BRANCH_NAME!];

const app = new App();

new CorsaMockStack(app, 'corsa-mock', {
  env: config.deployToEnvironment!,
  attachmentRetention: config.attachmentRetention,
  failure: config.failure,
});

app.synth();


