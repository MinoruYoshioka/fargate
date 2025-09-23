import { Duration, RemovalPolicy, Stack, StackProps, Fn } from 'aws-cdk-lib';
import { Vpc, SecurityGroup, SubnetType, Port, Peer } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  SubnetGroup,
} from 'aws-cdk-lib/aws-rds';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends StackProps {
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

    const vpc = Vpc.fromVpcAttributes(this, 'ImportedVpcForDb', {
      vpcId: StringParameter.valueForStringParameter(this, '/cdk-codex/network/vpcId'),
      availabilityZones: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/azs')),
      publicSubnetIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/publicSubnetIds')),
      publicSubnetRouteTableIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/publicSubnetRouteTableIds')),
      privateSubnetIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/privateSubnetIds')),
      privateSubnetRouteTableIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/privateSubnetRouteTableIds')),
      isolatedSubnetIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/isolatedSubnetIds')),
      isolatedSubnetRouteTableIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/isolatedSubnetRouteTableIds')),
    });

    const subnetGroup = new SubnetGroup(this, 'AuroraSubnetGroup', {
      description: 'Isolated subnets for Aurora ServerlessV2',
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.securityGroup = new SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Security group for Aurora Serverless V2 cluster',
    });

    // Allow application security group to reach Aurora on 5432
    const appSgId = StringParameter.valueForStringParameter(this, '/cdk-codex/security/ec2SecurityGroupId');
    this.securityGroup.addIngressRule(
      Peer.securityGroupId(appSgId),
      Port.tcp(5432),
      'Allow application SG to reach Aurora',
    );

    this.cluster = new DatabaseCluster(this, 'AuroraCluster', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_16_6,
      }),
      credentials: Credentials.fromGeneratedSecret('app_user'),
      defaultDatabaseName: this.databaseName,
      writer: ClusterInstance.serverlessV2('Writer', {
        enablePerformanceInsights: true,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      storageEncrypted: true,
      backup: { retention: Duration.days(7) },
      subnetGroup,
      removalPolicy: RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
    });

    if (!this.cluster.secret) {
      throw new Error('Aurora credentials secret was not generated');
    }
    this.secret = this.cluster.secret;

    this.cluster.addRotationSingleUser({
      automaticallyAfter: Duration.days(30),
    });

    // Publish database info to SSM Parameter Store
    new StringParameter(this, 'ParamDbEndpoint', {
      parameterName: '/cdk-codex/database/endpoint',
      stringValue: this.cluster.clusterEndpoint.hostname,
    });
    new StringParameter(this, 'ParamDbReaderEndpoint', {
      parameterName: '/cdk-codex/database/readerEndpoint',
      stringValue: this.cluster.clusterReadEndpoint.hostname,
    });
    new StringParameter(this, 'ParamDbSecretArn', {
      parameterName: '/cdk-codex/database/secretArn',
      stringValue: this.secret.secretArn,
    });
    new StringParameter(this, 'ParamDbName', {
      parameterName: '/cdk-codex/database/name',
      stringValue: this.databaseName,
    });
  }
}
