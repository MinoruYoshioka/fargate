import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface AuroraStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

export class AuroraStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly secret: secretsmanager.Secret;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AuroraStackProps) {
    super(scope, id, props);

    const { vpc } = props;

    // Auroraクラスター用のセキュリティグループを作成
    this.securityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc,
      description: 'Security group for Aurora cluster',
      allowAllOutbound: false,
    });

    // データベース認証情報をSecrets Managerで管理
    this.secret = new secretsmanager.Secret(this, 'DBCredentialsSecret', {
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

    // Aurora用のカスタムパラメーターグループ
    const clusterParameterGroup = new rds.ParameterGroup(this, 'AuroraClusterParameterGroup', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      parameters: {
        'shared_preload_libraries': 'pg_stat_statements',
        'log_statement': 'all',
        'log_min_duration_statement': '1000',
      },
    });

    // Aurora PostgreSQL Serverless v2 クラスター
    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      credentials: rds.Credentials.fromSecret(this.secret),
      securityGroups: [this.securityGroup],
      writer: rds.ClusterInstance.serverlessV2('writer', {
        scaleWithWriter: true,
        enablePerformanceInsights: true,
      }),
      readers: [
        rds.ClusterInstance.serverlessV2('reader', {
          scaleWithWriter: true,
        }),
      ],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      defaultDatabaseName: 'senmonka',
      storageEncrypted: true,
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: '02:00-03:00',
      },
      parameterGroup: clusterParameterGroup,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // CloudFormation出力
    new cdk.CfnOutput(this, 'AuroraClusterEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Aurora cluster endpoint for write operations',
      exportName: `${this.stackName}-ClusterEndpoint`,
    });

    new cdk.CfnOutput(this, 'AuroraReadEndpoint', {
      value: this.cluster.clusterReadEndpoint.hostname,
      description: 'Aurora cluster endpoint for read operations',
      exportName: `${this.stackName}-ReadEndpoint`,
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: this.secret.secretArn,
      description: 'ARN of the secret containing database credentials',
      exportName: `${this.stackName}-SecretArn`,
    });
  }
}
