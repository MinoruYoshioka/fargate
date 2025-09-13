import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface FargateStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  auroraCluster: rds.DatabaseCluster;
  dbSecret: secretsmanager.Secret;
  auroraSecurityGroup: ec2.SecurityGroup;
}

export class FargateStack extends cdk.Stack {
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: FargateStackProps) {
    super(scope, id, props);

    const { vpc, auroraCluster, dbSecret, auroraSecurityGroup } = props;

    // ECSクラスターの作成
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      containerInsights: true,
    });

    // CloudMap名前空間の追加
    cluster.addDefaultCloudMapNamespace({
      name: 'fargate-aurora',
    });

    // Application Load Balanced Fargateサービスの作成
    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'SpringBootFargateService', {
      cluster,
      cpu: 1024,
      memoryLimitMiB: 2048,
      desiredCount: 2,
      taskSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'PrivateRepo', 'my-spring-app'),
          'latest'
        ),
        containerPort: 8080,
        environment: {
          DB_HOST: auroraCluster.clusterEndpoint.hostname,
          DB_PORT: auroraCluster.clusterEndpoint.port.toString(),
          DB_NAME: 'senmonka',
        },
        secrets: {
          DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'fargate-aurora',
          logRetention: 7,
        }),
      },
      healthCheckGracePeriod: cdk.Duration.seconds(30),
      loadBalancerName: 'migration-aurora-alb',
      publicLoadBalancer: true,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // Target Groupの設定調整
    this.service.targetGroup.setAttribute(
      'deregistration_delay.timeout_seconds',
      '10'
    );

    this.service.targetGroup.configureHealthCheck({
      path: '/',
      healthyHttpCodes: '200,404,302',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      port: '8080',
    });

    // オートスケーリング設定
    const scalableTarget = this.service.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });

    // CPU使用率に基づくオートスケーリング
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // メモリ使用率に基づくオートスケーリング
    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // FargateサービスからAuroraクラスターへの接続を許可
    // Aurora側のセキュリティグループにFargateからのアクセスを許可するルールを追加
    const fargateSecurityGroup = this.service.service.connections.securityGroups[0];
    fargateSecurityGroup.connections.allowTo(
      auroraSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow connection to Aurora'
    );

    // CloudFormation出力
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: this.service.loadBalancer.loadBalancerDnsName,
      description: 'The DNS name of the Application Load Balancer',
      exportName: `${this.stackName}-LoadBalancerDNS`,
    });
  }
}
