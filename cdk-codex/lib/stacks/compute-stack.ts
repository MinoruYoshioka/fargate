import { Duration, Stack, StackProps, Fn } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Role } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringListParameter, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ComputeStackProps extends StackProps {
  readonly certificateArn?: string;
}

export class ComputeStack extends Stack {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // Import dependencies via SSM Parameter Store
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpcForCompute', {
      vpcId: StringParameter.valueForStringParameter(this, '/cdk-codex/network/vpcId'),
      availabilityZones: StringListParameter.valueForTypedListParameter(this, '/cdk-codex/network/azs'),
      publicSubnetIds: StringListParameter.valueForTypedListParameter(this, '/cdk-codex/network/publicSubnetIds'),
      publicSubnetRouteTableIds: StringListParameter.valueForTypedListParameter(this, '/cdk-codex/network/publicSubnetRouteTableIds'),
      privateSubnetIds: StringListParameter.valueForTypedListParameter(this, '/cdk-codex/network/privateSubnetIds'),
      privateSubnetRouteTableIds: StringListParameter.valueForTypedListParameter(this, '/cdk-codex/network/privateSubnetRouteTableIds'),
      isolatedSubnetIds: StringListParameter.valueForTypedListParameter(this, '/cdk-codex/network/isolatedSubnetIds'),
      isolatedSubnetRouteTableIds: StringListParameter.valueForTypedListParameter(this, '/cdk-codex/network/isolatedSubnetRouteTableIds'),
    });
    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedAlbSg',
      StringParameter.valueForStringParameter(this, '/cdk-codex/security/albSecurityGroupId'),
    );
    const instanceSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedInstanceSg',
      StringParameter.valueForStringParameter(this, '/cdk-codex/security/ec2SecurityGroupId'),
    );
    const instanceRole = Role.fromRoleArn(
      this,
      'ImportedInstanceRole',
      StringParameter.valueForStringParameter(this, '/cdk-codex/security/instanceRoleArn'),
      {
        // Ensure adding policies is allowed
        mutable: false,
      },
    );
    const databaseSecret = Secret.fromSecretCompleteArn(
      this,
      'ImportedDbSecret',
      StringParameter.valueForStringParameter(this, '/cdk-codex/database/secretArn'),
    );
    const ec2UserPasswordSecret = Secret.fromSecretCompleteArn(
      this,
      'ImportedEc2UserPasswordSecret',
      StringParameter.valueForStringParameter(this, '/cdk-codex/security/ec2UserPasswordSecretArn'),
    );
    const systemLogGroup = LogGroup.fromLogGroupName(
      this,
      'ImportedSystemLogGroup',
      StringParameter.valueForStringParameter(this, '/cdk-codex/monitoring/systemLogGroupName'),
    );

    const cloudWatchAgentConfig = {
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              {
                file_path: '/var/log/messages',
                log_group_name: systemLogGroup.logGroupName,
                log_stream_name: '{instance_id}-messages',
              },
              {
                file_path: '/var/log/amazon/ssm/amazon-ssm-agent.log',
                log_group_name: systemLogGroup.logGroupName,
                log_stream_name: '{instance_id}-ssm-agent',
              },
              {
                file_path: '/var/log/user-data.log',
                log_group_name: systemLogGroup.logGroupName,
                log_stream_name: '{instance_id}-user-data',
              },
            ],
          },
        },
      },
    };

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      'exec > >(tee -a /var/log/user-data.log) 2>&1',
      `echo "Starting SSM-only bootstrap at $(date) in region ${this.region}"`,

      // Minimal tools
      'dnf install -y curl wget jq',

      // Install and start Amazon SSM Agent (RHEL9)
      `SSM_RPM_URL="https://s3.${this.region}.amazonaws.com/amazon-ssm-${this.region}/latest/linux_amd64/amazon-ssm-agent.rpm"`,
      'curl -fSL "$SSM_RPM_URL" -o /tmp/amazon-ssm-agent.rpm || wget -O /tmp/amazon-ssm-agent.rpm "$SSM_RPM_URL"',
      'dnf install -y /tmp/amazon-ssm-agent.rpm || rpm -Uvh /tmp/amazon-ssm-agent.rpm',
      'systemctl enable amazon-ssm-agent',
      'systemctl restart amazon-ssm-agent',
      'systemctl status amazon-ssm-agent || true',

      // Install CloudWatch Agent and configure to ship system, SSM and user-data logs
      'wget https://s3.amazonaws.com/amazoncloudwatch-agent/redhat/amd64/latest/amazon-cloudwatch-agent.rpm',
      'dnf install -y ./amazon-cloudwatch-agent.rpm',
      'rm -f ./amazon-cloudwatch-agent.rpm',
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
${JSON.stringify(cloudWatchAgentConfig, null, 2)}
EOF`,
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s',
      'systemctl status amazon-cloudwatch-agent || true',

      // Helpful diagnostics to files (also shipped to CloudWatch)
      'echo "=== Diagnostics $(date) ===" >> /var/log/init-status.log',
      'systemctl is-active amazon-ssm-agent && echo "SSM agent active" >> /var/log/init-status.log || echo "SSM agent NOT active" >> /var/log/init-status.log',
      'journalctl -u amazon-ssm-agent -n 200 --no-pager >> /var/log/init-status.log 2>&1 || true',
      'echo "Finished bootstrap at $(date)" >> /var/log/init-status.log'
    );


    // RHEL 9の最新AMIを動的に検索
    const rhelAmi = ec2.MachineImage.lookup({
      name: 'RHEL-9.*_HVM-*-x86_64-*-Hourly2-GP2', // AMI名の検索パターン
      owners: ['309956199498'], // Red HatのAWSアカウントID
      filters: {
        'virtualization-type': ['hvm'],
        'architecture': ['x86_64'],
      },
    });

    this.instance = new ec2.Instance(this, 'ApplicationInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: instanceRole,
      securityGroup: instanceSecurityGroup,
      userData,
      requireImdsv2: true,
      machineImage: rhelAmi,
      
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      detailedMonitoring: true,
    });

    databaseSecret.grantRead(this.instance);
    ec2UserPasswordSecret.grantRead(this.instance);

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ApplicationAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'Ec2TargetGroup', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new InstanceTarget(this.instance, 8080)],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200-399,404',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
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

    // Publish identifiers to SSM Parameter Store
    new StringParameter(this, 'ParamAlbDnsName', {
      parameterName: '/cdk-codex/compute/albDnsName',
      stringValue: this.loadBalancer.loadBalancerDnsName,
    });
    new StringParameter(this, 'ParamInstanceId', {
      parameterName: '/cdk-codex/compute/instanceId',
      stringValue: this.instance.instanceId,
    });
  }
}
