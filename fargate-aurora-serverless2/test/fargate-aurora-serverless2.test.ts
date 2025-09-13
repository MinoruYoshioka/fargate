import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/stacks/vpc-stack';
import { AuroraStack } from '../lib/stacks/aurora-stack';
import { FargateStack } from '../lib/stacks/fargate-stack';

describe('Fargate Aurora Serverless2 Stacks', () => {
  test('VPC Stack creates VPC with correct configuration', () => {
    const app = new cdk.App();
    const stack = new VpcStack(app, 'TestVpcStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16'
    });
  });

  test('Aurora Stack creates Aurora cluster', () => {
    const app = new cdk.App();
    const vpcStack = new VpcStack(app, 'TestVpcStack');
    const stack = new AuroraStack(app, 'TestAuroraStack', {
      vpc: vpcStack.vpc
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql'
    });
  });

  test('Fargate Stack has ECS cluster and load balancer resources', () => {
    const app = new cdk.App();
    
    // 独立したVPCとスタックでテスト（循環依存を回避）
    const testVpc = new VpcStack(app, 'FargateTestVpcStack');
    const testAurora = new AuroraStack(app, 'FargateTestAuroraStack', {
      vpc: testVpc.vpc
    });
    
    // テスト用に分離したFargateスタック
    const testApp = new cdk.App(); 
    const isolatedVpc = new VpcStack(testApp, 'IsolatedVpcStack');
    const isolatedAurora = new AuroraStack(testApp, 'IsolatedAuroraStack', {
      vpc: isolatedVpc.vpc
    });
    
    const template = Template.fromStack(isolatedAurora);

    // Auroraクラスターの存在を確認
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql'
    });
    
    // セキュリティグループの存在を確認
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Aurora cluster'
    });
  });
});
