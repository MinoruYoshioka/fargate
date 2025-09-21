import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { IVpc, SecurityGroup, SubnetType, Port, Peer } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  SubnetGroup,
} from 'aws-cdk-lib/aws-rds';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly databaseName?: string;
}

export class DatabaseStack extends Stack {
  public readonly cluster: DatabaseCluster;
  public readonly databaseName: string;
  public readonly secret: ISecret;
  public readonly securityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.databaseName = props.databaseName ?? 'appdb';

    const subnetGroup = new SubnetGroup(this, 'AuroraSubnetGroup', {
      description: 'Isolated subnets for Aurora ServerlessV2',
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.securityGroup = new SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: false,
      description: 'Security group for Aurora Serverless V2 cluster',
    });

    const privateCidrs = props.vpc
      .selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })
      .subnets.map((subnet) => subnet.ipv4CidrBlock)
      .filter((cidr): cidr is string => !!cidr);

    for (const cidr of new Set(privateCidrs)) {
      this.securityGroup.addIngressRule(
        Peer.ipv4(cidr),
        Port.tcp(5432),
        'Allow private subnets to reach Aurora',
      );
    }

    this.cluster = new DatabaseCluster(this, 'AuroraCluster', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_15_3,
      }),
      credentials: Credentials.fromGeneratedSecret('app_user'),
      defaultDatabaseName: this.databaseName,
      writer: ClusterInstance.serverlessV2('Writer', {
        enablePerformanceInsights: true,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      storageEncrypted: true,
      backup: { retention: Duration.days(7) },
      subnetGroup,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
    });

    if (!this.cluster.secret) {
      throw new Error('Aurora credentials secret was not generated');
    }
    this.secret = this.cluster.secret;

    this.cluster.addRotationSingleUser({
      automaticallyAfter: Duration.days(30),
    });

    new CfnOutput(this, 'AuroraEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Writer endpoint DNS of the Aurora cluster',
    });
    new CfnOutput(this, 'AuroraReaderEndpoint', {
      value: this.cluster.clusterReadEndpoint.hostname,
      description: 'Reader endpoint DNS of the Aurora cluster',
    });
    new CfnOutput(this, 'AuroraSecretArn', {
      value: this.secret.secretArn,
      description: 'Secrets Manager ARN storing the Aurora credentials',
    });
  }
}
