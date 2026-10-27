import { App } from 'aws-cdk-lib';
import { configs } from './Configuration';
import { PipelineStack } from './PipelineStack';

if (!process.env.BRANCH_NAME) {
  const branchnames = Object.keys(configs);
  throw Error(`Should set a branch name for deployment: ${branchnames}`);
}

const config = configs[process.env.BRANCH_NAME!];

const app = new App();

new PipelineStack(app, `corsa-mock-pipeline-${config.branch}`, {
  env: config.deployFromEnvironment,
  configuration: config,
});

app.synth();
