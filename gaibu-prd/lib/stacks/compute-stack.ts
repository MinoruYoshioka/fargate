import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Role } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ComputeStackProps extends StackProps {
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly instanceSecurityGroup: ec2.SecurityGroup;
  readonly instanceRole: Role;
  readonly ec2UserPasswordSecret: ISecret;
  readonly systemLogGroup: LogGroup;
  readonly certificateArn?: string;
}

export class ComputeStack extends Stack {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const vpc = props.vpc;
    const albSecurityGroup = props.albSecurityGroup;
    const instanceSecurityGroup = props.instanceSecurityGroup;
    const instanceRole = props.instanceRole;
    const ec2UserPasswordSecret = props.ec2UserPasswordSecret;
    const systemLogGroup = props.systemLogGroup;

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
              {
                file_path: '/opt/tomcat/logs/catalina.out',
                log_group_name: systemLogGroup.logGroupName,
                log_stream_name: '{instance_id}-tomcat-catalina',
              },
              {
                file_path: '/opt/tomcat/logs/localhost_access_log.*.txt',
                log_group_name: systemLogGroup.logGroupName,
                log_stream_name: '{instance_id}-tomcat-access',
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

      // Minimal tools and Java 8
      'dnf install -y curl wget jq java-1.8.0-openjdk java-1.8.0-openjdk-devel',

      // Install and start Amazon SSM Agent (RHEL9)
      `SSM_RPM_URL="https://s3.${this.region}.amazonaws.com/amazon-ssm-${this.region}/latest/linux_amd64/amazon-ssm-agent.rpm"`,
      'curl -fSL "$SSM_RPM_URL" -o /tmp/amazon-ssm-agent.rpm || wget -O /tmp/amazon-ssm-agent.rpm "$SSM_RPM_URL"',
      'dnf install -y /tmp/amazon-ssm-agent.rpm || rpm -Uvh /tmp/amazon-ssm-agent.rpm',
      'systemctl enable amazon-ssm-agent',
      'systemctl restart amazon-ssm-agent',
      'systemctl status amazon-ssm-agent || true',

      // Install Apache Tomcat 9.0.38 (Java 8 compatible)
      'TOMCAT_VERSION="9.0.38"',
      'TOMCAT_USER="tomcat"',
      'TOMCAT_HOME="/opt/tomcat"',
      '',
      '# Create tomcat user and directories',
      'useradd -r -s /bin/false -d "$TOMCAT_HOME" "$TOMCAT_USER" || true',
      'sudo mkdir -p "$TOMCAT_HOME"',
      '',
      '# Download and install Tomcat 9',
      'cd /tmp',
      'sudo curl -O "https://archive.apache.org/dist/tomcat/tomcat-9/v${TOMCAT_VERSION}/bin/apache-tomcat-${TOMCAT_VERSION}.tar.gz"',
      'sudo tar -xzf "apache-tomcat-${TOMCAT_VERSION}.tar.gz"',
      'sudo cp -r "apache-tomcat-${TOMCAT_VERSION}"/* "$TOMCAT_HOME/"',
      'sudo chown -R "$TOMCAT_USER":"$TOMCAT_USER" "$TOMCAT_HOME"',
      'sudo chmod +x "$TOMCAT_HOME"/bin/*.sh',
      'sudo rm -rf "apache-tomcat-${TOMCAT_VERSION}" "apache-tomcat-${TOMCAT_VERSION}.tar.gz"',
      '',
      '# Create systemd service for Tomcat',
      'sudo cat > /etc/systemd/system/tomcat.service << "EOF"',
      '[Unit]',
      'Description=Apache Tomcat Web Application Container',
      'After=network.target',
      '',
      '[Service]',
      'Type=forking',
      'User=tomcat',
      'Group=tomcat',
      '',
      'Environment="JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk"',
      'Environment="CATALINA_PID=/opt/tomcat/temp/tomcat.pid"',
      'Environment="CATALINA_HOME=/opt/tomcat"',
      'Environment="CATALINA_BASE=/opt/tomcat"',
      'Environment="CATALINA_OPTS=-Xms512M -Xmx1024M -server -XX:+UseParallelGC"',
      'Environment="JAVA_OPTS=-Djava.awt.headless=true -Djava.security.egd=file:/dev/./urandom"',
      '',
      'ExecStart=/opt/tomcat/bin/startup.sh',
      'ExecStop=/opt/tomcat/bin/shutdown.sh',
      '',
      'RestartSec=10',
      'Restart=always',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      '',
      '# Enable and start Tomcat service',
      'systemctl daemon-reload',
      'systemctl enable tomcat',
      'systemctl start tomcat',
      'systemctl status tomcat || true',
      '',
      '# Create a basic test application',
      'mkdir -p "$TOMCAT_HOME/webapps/health"',
      'cat > "$TOMCAT_HOME/webapps/health/index.jsp" << "EOF"',
      '<%@ page contentType="text/html;charset=UTF-8" %>',
      '<html>',
      '<head><title>Health Check</title></head>',
      '<body>',
      '<h1>Application is running</h1>',
      '<p>Server: <%= request.getServerName() %></p>',
      '<p>Time: <%= new java.util.Date() %></p>',
      '</body>',
      '</html>',
      'EOF',
      '',
      '# Set proper ownership for all Tomcat files',
      'chown -R "$TOMCAT_USER":"$TOMCAT_USER" "$TOMCAT_HOME"',
      'chmod -R 755 "$TOMCAT_HOME"',
      'chmod +x "$TOMCAT_HOME"/bin/*.sh',
      '',
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
      'systemctl is-active tomcat && echo "Tomcat active" >> /var/log/init-status.log || echo "Tomcat NOT active" >> /var/log/init-status.log',
      'journalctl -u amazon-ssm-agent -n 50 --no-pager >> /var/log/init-status.log 2>&1 || true',
      'journalctl -u tomcat -n 50 --no-pager >> /var/log/init-status.log 2>&1 || true',
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

      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      detailedMonitoring: true,
    });

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
        path: '/health/',
        healthyHttpCodes: '200-399',
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
      parameterName: '/prd-gaibu/compute/albDnsName',
      stringValue: this.loadBalancer.loadBalancerDnsName,
    });
    new StringParameter(this, 'ParamInstanceId', {
      parameterName: '/prd-gaibu/compute/instanceId',
      stringValue: this.instance.instanceId,
    });
  }
}