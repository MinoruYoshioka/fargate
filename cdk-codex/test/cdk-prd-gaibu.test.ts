import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';

const env = { account: '123456789012', region: 'ap-northeast-1' };

test('Network stack provisions a three-tier VPC', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetwork', { env, cidr: '10.1.0.0/16', maxAzs: 2 });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: '10.1.0.0/16',
  });
  template.resourceCountIs('AWS::EC2::Subnet', 6);
});

test('Security stack configures IAM role and security groups', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'Network', { env });
  const stack = new SecurityStack(app, 'Security', { env, vpc: network.vpc });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'ec2.amazonaws.com' },
        }),
      ]),
    }),
  });

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for the public Application Load Balancer',
  });
});

test('Database stack enables Aurora Serverless V2 with rotation', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'NetworkForDb', { env });
  const security = new SecurityStack(app, 'SecurityForDb', { env, vpc: network.vpc });
  const stack = new DatabaseStack(app, 'Database', {
    env,
    vpc: network.vpc,
    applicationSecurityGroup: security.applicationSecurityGroup,
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-postgresql',
    ServerlessV2ScalingConfiguration: {
      MaxCapacity: 2,
      MinCapacity: 0.5,
    },
  });
});

test('Monitoring stack provisions dedicated log groups', () => {
  const app = new cdk.App();
  const stack = new MonitoringStack(app, 'Monitoring', { env });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Logs::LogGroup', {
    LogGroupName: Match.stringLikeRegexp('/cdk-prd-gaibu/app'),
  });
});
