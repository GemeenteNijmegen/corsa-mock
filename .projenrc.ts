import { GemeenteNijmegenCdkApp } from '@gemeentenijmegen/projen-project-type';
import { javascript } from 'projen';
import { JobPermission } from 'projen/lib/github/workflows-model';
const project = new GemeenteNijmegenCdkApp({
  cdkVersion: '2.189.1',
  name: 'corsa-mock',
  packageManager: javascript.NodePackageManager.NPM,
  projenrcTs: true,
  devDeps: [],
  deps: [
    '@aws-sdk/client-s3',
    '@gemeentenijmegen/projen-project-type',
  ],

  // defaultReleaseBranch: "main",  /* The name of the main release branch. */
  // deps: [],                      /* Runtime dependencies of this module. */
  // description: undefined,        /* The description is just a string that helps people understand the purpose of the package. */
  // packageName: undefined,        /* The "name" in package.json. */
});

/**
 * Checkov infrastructure-as-code scanning.
 *
 * Checkov cannot see resource configuration (IAM, S3, encryption, security
 * groups) in the CDK TypeScript source, because that only materialises after
 * `cdk synth`. So we synth first and point Checkov at the generated `cdk.out`
 * CloudFormation. Results are uploaded as SARIF so they show up in the GitHub
 * Security tab and as PR annotations, alongside CodeQL.
 *
 * Soft-fail for now: findings are reported but never fail the check. Flip
 * `soft_fail` to false (and remove `continue-on-error`) to turn this into a
 * hard gate once the baseline is triaged.
 */
const checkov = project.github?.addWorkflow('checkov');
if (checkov) {
  checkov.on({
    pullRequest: { branches: ['development'] },
    push: { branches: ['development'] },
    workflowDispatch: {},
  });
  checkov.addJob('scan', {
    runsOn: ['ubuntu-latest'],
    permissions: {
      // Needed to upload the SARIF results to GitHub code scanning.
      securityEvents: JobPermission.WRITE,
      // Checkout of the repo.
      contents: JobPermission.READ,
      // Lets code scanning associate alerts with the PR.
      actions: JobPermission.READ,
    },
    steps: [
      {
        name: 'Checkout',
        uses: 'actions/checkout@v4',
      },
      {
        name: 'Setup Node.js',
        uses: 'actions/setup-node@v4',
        with: { 'node-version': '24' },
      },
      {
        name: 'Install dependencies',
        run: 'npm ci',
      },
      {
        // Synthesize the CloudFormation templates into cdk.out. main.ts throws
        // unless BRANCH_NAME is set to a known config key (development |
        // acceptance | production); it selects which config to synth.
        name: 'Synth',
        run: 'npx projen synth',
        env: { BRANCH_NAME: 'development' },
      },
      {
        name: 'Run Checkov',
        id: 'checkov',
        uses: 'bridgecrewio/checkov-action@v12',
        // Soft-fail: never break the check on findings for now.
        continueOnError: true,
        with: {
          directory: 'cdk.out',
          framework: 'cloudformation',
          soft_fail: true,
          output_format: 'cli,sarif',
          // The sarif output is written as results_sarif.sarif INSIDE this
          // directory (the action treats the path as a folder, not a file).
          // The 'console' entry pairs with the 'cli' output above.
          output_file_path: 'console,checkov-results',
        },
      },
      {
        name: 'Upload SARIF to code scanning',
        // Run even when Checkov reports findings so results always land in the
        // Security tab. upload-sarif accepts a directory and ingests every
        // .sarif inside it, so we point it at the folder Checkov wrote.
        if: 'always()',
        uses: 'github/codeql-action/upload-sarif@v3',
        with: { sarif_file: 'checkov-results' },
      },
    ],
  });
}

project.synth();