import { Duration, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Role } from 'aws-cdk-lib/aws-iam';
import { ILogGroup } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const USER_DATA_TEMPLATE = readFileSync(resolve(process.cwd(), 'assets', 'compute-user-data.sh'), 'utf8');

interface RenderUserDataParams {
  readonly secretArn: string;
  readonly dbHost: string;
  readonly dbPort: string;
  readonly dbName: string;
  readonly cloudWatchConfig: string;
}

const renderUserData = (params: RenderUserDataParams): string =>
  USER_DATA_TEMPLATE
    .replaceAll('__SECRET_ARN__', params.secretArn)
    .replaceAll('__DB_HOST__', params.dbHost)
    .replaceAll('__DB_PORT__', params.dbPort)
    .replaceAll('__DB_NAME__', params.dbName)
    .replace('__CLOUDWATCH_AGENT_CONFIG__', params.cloudWatchConfig);

export interface ComputeStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly instanceSecurityGroup: ec2.ISecurityGroup;
  readonly instanceRole: Role;
  readonly databaseSecret: ISecret;
  readonly databaseCluster: DatabaseCluster;
  readonly databaseName: string;
  readonly applicationLogGroup: ILogGroup;
  readonly systemLogGroup: ILogGroup;
  readonly certificateArn?: string;
}

export class ComputeStack extends Stack {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const cloudWatchAgentConfig = {
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              {
                file_path: '/var/log/tomcat/catalina.out',
                log_group_name: props.applicationLogGroup.logGroupName,
                log_stream_name: '{instance_id}-catalina',
              },
              {
                file_path: '/var/log/messages',
                log_group_name: props.systemLogGroup.logGroupName,
                log_stream_name: '{instance_id}-messages',
              },
            ],
          },
        },
      },
      metrics: {
        namespace: 'Gaibu/Application',
        append_dimensions: {
          InstanceId: '${aws:InstanceId}',
        },
        metrics_collected: {
          mem: {
            measurement: ['mem_used_percent'],
          },
          disk: {
            resources: ['*'],
            measurement: ['disk_used_percent'],
          },
        },
      },
    };

    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash -xe' });
    const userDataScript = renderUserData({
      secretArn: props.databaseSecret.secretArn,
      dbHost: props.databaseCluster.clusterEndpoint.hostname,
      dbPort: props.databaseCluster.clusterEndpoint.port.toString(),
      dbName: props.databaseName,
      cloudWatchConfig: JSON.stringify(cloudWatchAgentConfig, null, 2),
    });
    userData.addCommands(userDataScript);

    this.instance = new ec2.Instance(this, 'ApplicationInstance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.instanceRole,
      securityGroup: props.instanceSecurityGroup,
      userData,
      requireImdsv2: true,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      detailedMonitoring: true,
    });

    props.databaseSecret.grantRead(this.instance);

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ApplicationAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'Ec2TargetGroup', {
      vpc: props.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new InstanceTarget(this.instance, 8080)],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200-399',
        interval: Duration.seconds(30),
      },
    });

    const httpListener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultTargetGroups: [targetGroup],
    });

    if (props.certificateArn) {
      this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        open: true,
        certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
        defaultTargetGroups: [targetGroup],
      });
      httpListener.addAction('RedirectToHttps', {
        action: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443' }),
      });
    }

    const cpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      statistic: 'Average',
      period: Duration.minutes(5),
      dimensionsMap: {
        InstanceId: this.instance.instanceId,
      },
    });

    new cloudwatch.Alarm(this, 'Ec2HighCpu', {
      metric: cpuMetric,
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const alb5xxMetric = this.loadBalancer.metrics.httpCodeElb(
      elbv2.HttpCodeElb.ELB_5XX_COUNT,
      {
        statistic: 'sum',
        period: Duration.minutes(5),
      },
    );

    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      metric: alb5xxMetric,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'AlbDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'DNS name of the Application Load Balancer',
    });

    new CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'EC2 instance identifier',
    });
  }
}
