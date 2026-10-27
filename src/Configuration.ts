import { Duration, Environment } from 'aws-cdk-lib';
import { FailureInjectionOptions } from './CorsaMockStack';
import { Statics } from './Statics';

export interface Configurable {
  configuration: Configuration;
}

export interface Configuration {
  branch: string;
  deployToEnvironment: Environment;
  deployFromEnvironment: Environment;
  attachmentRetention: Duration;
  failure?: FailureInjectionOptions;
}

export const configs: Record<string, Configuration> = {
  development: {
    branch: 'development',
    deployToEnvironment: {
      account: '958979025885',
      region: 'eu-central-1',
    },
    deployFromEnvironment: {
      account: Statics.gnBuild,
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
    branch: 'acceptance',
    deployToEnvironment: {
      account: '',
      region: 'eu-central-1',
    },
    deployFromEnvironment: {
      account: Statics.gnBuild,
      region: 'eu-central-1',
    },
    attachmentRetention: Duration.days(30),
  },
  production: {
    branch: 'production',
    deployToEnvironment: {
      account: '',
      region: 'eu-central-1',
    },
    deployFromEnvironment: {
      account: Statics.gnBuild,
      region: 'eu-central-1',
    },
    attachmentRetention: Duration.days(1),
  },
};
