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
  /**
   * PEM file with the public certificates of the CAs that sign client certificates.
   */
  truststorePath: string;
  /**
   * SHA-256 fingerprints of the client certificates that are accepted. Empty means none.
   */
  allowedFingerprints: string[];
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
    truststorePath: 'truststore/ca-bundle.pem',
    allowedFingerprints: [
      '95:FB:03:46:A0:13:79:E7:F3:33:B8:E2:B3:0A:88:5A:6D:E6:75:FE:2D:B0:EF:16:33:BC:16:00:C5:85:86:1F', // docpoc cert
    ],
    failure: {
      percentage: 70,
      modes: ['soap-fault', 'fo02', 'http503', 'lost-response', 'timeout'],
      operations: [], // all
      seed: '123',
      timeout: Duration.seconds(25),
    },
  },
  acceptance: {
    branch: 'acceptance',
    deployToEnvironment: {
      account: '145023129433',
      region: 'eu-central-1',
    },
    deployFromEnvironment: {
      account: Statics.gnBuild,
      region: 'eu-central-1',
    },
    attachmentRetention: Duration.days(30),
    truststorePath: 'truststore/acceptance.pem',
    allowedFingerprints: [],
  },
  production: {
    branch: 'production',
    deployToEnvironment: {
      account: '692859927138',
      region: 'eu-central-1',
    },
    deployFromEnvironment: {
      account: Statics.gnBuild,
      region: 'eu-central-1',
    },
    attachmentRetention: Duration.days(1),
    truststorePath: 'truststore/production.pem',
    allowedFingerprints: [],
  },
};
