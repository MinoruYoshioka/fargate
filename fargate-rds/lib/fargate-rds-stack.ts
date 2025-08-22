import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class FargateRdsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- 1. ネットワーク層 (VPC) の定義 ---
    // パブリックサブネットとプライベートサブネットを2つのAZに作成します。
    // Fargateサービスはプライベートサブネットに配置され、ALBはパブリックに配置されます。
    const vpc = new ec2.Vpc(this, 'MigrationVpc', {
      maxAzs: 2,
      natGateways: 1, // NAT Gatewayは1つに制限してコストを節約
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public-subnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private-subnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // --- 2. データベース層 (RDS) の定義 ---
    // データベースの認証情報をAWS Secrets Managerで安全に管理します。
    const dbCredentialsSecret = new secretsmanager.Secret(this, 'DBCredentialsSecret', {
      secretName: 'migration/db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password',
      },
    });

    // RDS for PostgreSQLインスタンスを作成します。
    // Multi-AZ構成で可用性を高め、プライベートサブネットに配置します。
    const dbInstance = new rds.DatabaseInstance(this, 'PostgresDB', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_6 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO), // 開発・検証用途。本番ではm5系などを推奨
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret), // Secrets Managerから認証情報を取得
      multiAz: true, // 高可用性のためのMulti-AZ配置
      allocatedStorage: 100, // 100GBのストレージ
      databaseName: 'migrateddb',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Stack削除時にDBも削除（本番ではRETAINを推奨）
    });

    // --- 3. アプリケーション層 (ECS on Fargate) の定義 ---
    // ECSクラスターを作成します。
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
    });

    // ApplicationLoadBalancedFargateService (L3コンストラクト) を使用して、
    // ALB, Fargateサービス, タスク定義, セキュリティグループなどを一括で作成します。
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'SpringBootFargateService', {
      cluster,
      cpu: 1024, // 1 vCPU
      memoryLimitMiB: 2048, // 2GBメモリ
      desiredCount: 2, // 常に2つのタスクを起動
      taskSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      taskImageOptions: {
        // ここで実際のアプリケーションコンテナイメージを指定します
        // 例: ecs.ContainerImage.fromEcrRepository(yourEcrRepo, 'latest')
        image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'), // プレースホルダーのサンプルイメージ
        containerPort: 80, // amazon-ecs-sampleはポート80で動作
        environment: {
          // アプリケーションがDBに接続するための環境変数
          SPRING_DATASOURCE_URL: `jdbc:postgresql://${dbInstance.dbInstanceEndpointAddress}:${dbInstance.dbInstanceEndpointPort}/migrateddb`,
        },
        secrets: {
          // Secrets Managerからユーザー名とパスワードを安全に環境変数としてコンテナに渡します
          SPRING_DATASOURCE_USERNAME: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'username'),
          SPRING_DATASOURCE_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'password'),
        },
      },
      loadBalancerName: 'migration-alb',
      publicLoadBalancer: true, // インターネットからのアクセスを許可
      minHealthyPercent: 100, // デプロイ中も最低100%のタスクを維持
      maxHealthyPercent:200, // デプロイ中は最大200%まで起動可能
    });

    // Fargateタスクのヘルスチェック設定を調整
    fargateService.targetGroup.configureHealthCheck({
      path: '/', // amazon-ecs-sampleのルートパス
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // --- 4. セキュリティ設定 ---
    // FargateサービスからRDSデータベースへの接続を許可します。
    // CDKがセキュリティグループ間のルールを自動で最適に設定します。
    dbInstance.connections.allowDefaultPortFrom(fargateService.service.connections);

    // --- 5. アウトプット ---
    // デプロイ後に確認できるよう、ALBのDNS名をCloudFormationの出力として表示します。
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
      description: 'The DNS name of the Application Load Balancer',
    });
  }
}
