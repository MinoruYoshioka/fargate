#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/stacks/vpc-stack';
import { AuroraStack } from '../lib/stacks/aurora-stack';
import { FargateStack } from '../lib/stacks/fargate-stack';

const app = new cdk.App();

// 1. VPCスタックを最初に作成
const vpcStack = new VpcStack(app, 'VpcStack', {
  description: 'VPC stack with networking components',
});

// 2. VPCに依存するAuroraスタックを作成
const auroraStack = new AuroraStack(app, 'AuroraStack', {
  vpc: vpcStack.vpc,
  description: 'Aurora PostgreSQL Serverless v2 cluster stack',
  
});
auroraStack.addDependency(vpcStack);

// 3. VPCとAuroraの両方に依存するFargateスタックを作成
const fargateStack = new FargateStack(app, 'FargateStack', {
  vpc: vpcStack.vpc,
  auroraCluster: auroraStack.cluster,
  auroraSecurityGroup: auroraStack.securityGroup,
  description: 'ECS Fargate service stack with Application Load Balancer',
});
fargateStack.addDependency(auroraStack);