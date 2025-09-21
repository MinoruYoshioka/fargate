#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

const vpcCidr = app.node.tryGetContext('vpcCidr') as string | undefined;
const maxAzsContext = app.node.tryGetContext('maxAzs');
const maxAzs = typeof maxAzsContext === 'number' ? maxAzsContext : maxAzsContext ? Number(maxAzsContext) : undefined;
const databaseName = (app.node.tryGetContext('databaseName') as string | undefined) ?? 'appdb';
const certificateArn = app.node.tryGetContext('albCertificateArn') as string | undefined;

const networkStack = new NetworkStack(app, 'CdkPrdGaibuNetworkStack', {
  env,
  cidr: vpcCidr,
  maxAzs,
});

const securityStack = new SecurityStack(app, 'CdkPrdGaibuSecurityStack', {
  env,
  vpc: networkStack.vpc,
});
securityStack.addDependency(networkStack);

const monitoringStack = new MonitoringStack(app, 'CdkPrdGaibuMonitoringStack', {
  env,
});
monitoringStack.addDependency(securityStack);

const databaseStack = new DatabaseStack(app, 'CdkPrdGaibuDatabaseStack', {
  env,
  vpc: networkStack.vpc,
  databaseName,
});

if (!databaseStack.secret) {
  throw new Error('Aurora credentials secret is undefined.');
}

const computeStack = new ComputeStack(app, 'CdkPrdGaibuComputeStack', {
  env,
  vpc: networkStack.vpc,
  albSecurityGroup: securityStack.loadBalancerSecurityGroup,
  instanceSecurityGroup: securityStack.applicationSecurityGroup,
  instanceRole: securityStack.instanceRole,
  databaseSecret: databaseStack.secret,
  databaseCluster: databaseStack.cluster,
  databaseName: databaseStack.databaseName,
  applicationLogGroup: monitoringStack.applicationLogGroup,
  systemLogGroup: monitoringStack.systemLogGroup,
  certificateArn,
});
computeStack.addDependency(databaseStack);
computeStack.addDependency(monitoringStack);
