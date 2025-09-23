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

const onlyStack = process.env.STACK;

if (onlyStack === 'network') {
  new NetworkStack(app, 'CdkPrdGaibuNetworkStack', {
    env,
    cidr: vpcCidr,
    maxAzs,
  });
} else if (onlyStack === 'security') {
  const networkStack = new NetworkStack(app, 'CdkPrdGaibuNetworkStack', {
    env,
    cidr: vpcCidr,
    maxAzs,
  });
  const securityStack = new SecurityStack(app, 'CdkPrdGaibuSecurityStack', { env });
  securityStack.addDependency(networkStack);
} else if (onlyStack === 'monitoring') {
  const securityStack = new SecurityStack(app, 'CdkPrdGaibuSecurityStack', { env });
  const monitoringStack = new MonitoringStack(app, 'CdkPrdGaibuMonitoringStack', { env });
  monitoringStack.addDependency(securityStack);
} else if (onlyStack === 'database') {
  new DatabaseStack(app, 'CdkPrdGaibuDatabaseStack', { env, databaseName });
} else if (onlyStack === 'compute') {
  const databaseStack = new DatabaseStack(app, 'CdkPrdGaibuDatabaseStack', { env, databaseName });
  const monitoringStack = new MonitoringStack(app, 'CdkPrdGaibuMonitoringStack', { env });
  const computeStack = new ComputeStack(app, 'CdkPrdGaibuComputeStack', { env, certificateArn });
  computeStack.addDependency(databaseStack);
  computeStack.addDependency(monitoringStack);
} else {
  const networkStack = new NetworkStack(app, 'CdkPrdGaibuNetworkStack', {
    env,
    cidr: vpcCidr,
    maxAzs,
  });

  const securityStack = new SecurityStack(app, 'CdkPrdGaibuSecurityStack', { env });
  securityStack.addDependency(networkStack);

  const monitoringStack = new MonitoringStack(app, 'CdkPrdGaibuMonitoringStack', {
    env,
  });
  monitoringStack.addDependency(securityStack);

  const databaseStack = new DatabaseStack(app, 'CdkPrdGaibuDatabaseStack', { env, databaseName });
  databaseStack.addDependency(securityStack);

  const computeStack = new ComputeStack(app, 'CdkPrdGaibuComputeStack', { env, certificateArn });
  computeStack.addDependency(databaseStack);
  computeStack.addDependency(monitoringStack);
}
