import { App } from 'aws-cdk-lib';
import { configs } from './Configuration';
import { PipelineStack } from './PipelineStack';

let branchName = process.env.BRANCH_NAME;
if (!branchName) {
  const branchnames = Object.keys(configs);
  console.log(`Should set a branch name for deployment: ${branchnames}, defaulting to development`);
  branchName = 'development';
}

const config = configs[branchName];

const app = new App();

new PipelineStack(app, `corsa-mock-pipeline-${config.branch}`, {
  env: config.deployFromEnvironment,
  configuration: config,
});

app.synth();
