import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class FargateAuroraServerlessStack extends cdk.Stack {
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
        {
          cidrMask: 24,
          name: 'isolated-subnet',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // Auroraクラスター専用のサブネット
        },
      ],
    });

    // --- 2. データベース層 (Aurora) の定義 ---
    // データベースの認証情報をAWS Secrets Managerで安全に管理します。
      // データベースの認証情報をAWS Secrets Managerで安全に管理します。
    const dbCredentialsSecret = new secretsmanager.Secret(this, 'DBCredentialsSecret', {
      secretName: 'migration/aurora-db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'aws13d10admin',
          port: 5432,
          dbname: 'senmonka'
         }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password',
      },
    });

    // Aurora PostgreSQL クラスターを作成します。
    // Serverless v2を使用して自動スケーリングを実現します。
    const auroraCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6, // 最新のPostgreSQL 16互換バージョン
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // より安全な独立したサブネットに配置
      },
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      writer: rds.ClusterInstance.serverlessV2('writer', {
        scaleWithWriter: true,
        enablePerformanceInsights: true, // パフォーマンス監視を有効化
      }),
      readers: [
        rds.ClusterInstance.serverlessV2('reader', {
          scaleWithWriter: true,
        }),
      ],
      serverlessV2MinCapacity: 0.5,  // 最小ACU (Aurora Capacity Units)
      serverlessV2MaxCapacity: 2,    // 最大ACU (開発環境向けの設定)
      defaultDatabaseName: 'migrateddb',
      storageEncrypted: true, // ストレージ暗号化を有効化
      backup: {
        retention: cdk.Duration.days(7), // 7日間のバックアップ保持
        preferredWindow: '02:00-03:00',  // バックアップウィンドウ
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Stack削除時にクラスターも削除（本番ではRETAINを推奨）
      deletionProtection: false, // 開発環境のため削除保護は無効化（本番では有効化推奨）
    });

    // Aurora用のカスタムパラメーターグループを作成（オプション）
    const clusterParameterGroup = new rds.ParameterGroup(this, 'AuroraClusterParameterGroup', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      parameters: {
        'shared_preload_libraries': 'pg_stat_statements',
        'log_statement': 'all', // 開発環境向け：全SQLステートメントをログに記録
        'log_min_duration_statement': '1000', // 1秒以上かかるクエリをログに記録
      },
    });

    // パラメーターグループをクラスターに関連付け
    const cfnCluster = auroraCluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.dbClusterParameterGroupName = clusterParameterGroup.bindToCluster({}).parameterGroupName;

    // --- 3. アプリケーション層 (ECS on Fargate) の定義 ---
    // ECSクラスターを作成します。
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      containerInsights: true, // CloudWatch Container Insightsを有効化
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
          // アプリケーションがAuroraに接続するための環境変数
          SPRING_DATASOURCE_URL: `jdbc:postgresql://${auroraCluster.clusterEndpoint.hostname}:${auroraCluster.clusterEndpoint.port}/migrateddb`,
          // 読み取り専用接続用のURL（オプション）
          SPRING_DATASOURCE_READONLY_URL: `jdbc:postgresql://${auroraCluster.clusterReadEndpoint.hostname}:${auroraCluster.clusterReadEndpoint.port}/migrateddb`,
        },
        secrets: {
          // Secrets Managerからユーザー名とパスワードを安全に環境変数としてコンテナに渡します
          SPRING_DATASOURCE_USERNAME: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'username'),
          SPRING_DATASOURCE_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'password'),
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'fargate-aurora',
          logRetention: 7, // ログの保持期間（日）
        }),
      },
      loadBalancerName: 'migration-aurora-alb',
      publicLoadBalancer: true, // インターネットからのアクセスを許可
      minHealthyPercent: 100, // デプロイ中も最低100%のタスクを維持
      maxHealthyPercent: 200, // デプロイ中は最大200%まで起動可能
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

    // オートスケーリング設定（オプション）
    const scalableTarget = fargateService.service.autoScaleTaskCount({
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

    // --- 4. セキュリティ設定 ---
    // FargateサービスからAuroraクラスターへの接続を許可します。
    // CDKがセキュリティグループ間のルールを自動で最適に設定します。
    auroraCluster.connections.allowDefaultPortFrom(fargateService.service.connections);

    // --- 5. アウトプット ---
    // デプロイ後に確認できるよう、重要な情報をCloudFormationの出力として表示します。
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
      description: 'The DNS name of the Application Load Balancer',
    });

    new cdk.CfnOutput(this, 'AuroraClusterEndpoint', {
      value: auroraCluster.clusterEndpoint.hostname,
      description: 'Aurora cluster endpoint for write operations',
    });

    new cdk.CfnOutput(this, 'AuroraReadEndpoint', {
      value: auroraCluster.clusterReadEndpoint.hostname,
      description: 'Aurora cluster endpoint for read operations',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: dbCredentialsSecret.secretArn,
      description: 'ARN of the secret containing database credentials',
    });
  }
}