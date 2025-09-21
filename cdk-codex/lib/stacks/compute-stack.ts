import { Duration, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Role } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface ComputeStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly instanceSecurityGroup: ec2.ISecurityGroup;
  readonly instanceRole: Role;
  readonly databaseSecret: ISecret;
  readonly databaseCluster: DatabaseCluster;
  readonly databaseName: string;
  readonly applicationLogGroup: LogGroup;
  readonly systemLogGroup: LogGroup;
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

    const userData = ec2.UserData.forLinux();
   userData.addCommands(
      '#!/bin/bash',
      'yum update -y',

      // Install required tools including jq for JSON parsing
      'yum install -y jq curl wget',

      // Install Java 8
      'yum install -y java-1.8.0-openjdk java-1.8.0-openjdk-devel',

      // Install Tomcat 9 manually
      'wget https://archive.apache.org/dist/tomcat/tomcat-9/v9.0.65/bin/apache-tomcat-9.0.65.tar.gz',
      'tar -xzf apache-tomcat-9.0.65.tar.gz -C /opt/',
      'mv /opt/apache-tomcat-9.0.65 /opt/tomcat',
      'useradd -r -m -U -d /opt/tomcat -s /bin/false tomcat',
      'chown -R tomcat: /opt/tomcat',
      'chmod +x /opt/tomcat/bin/*.sh',

      // Install CloudWatch Agent
      'wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm',
      'rpm -U ./amazon-cloudwatch-agent.rpm',

      // Configure CloudWatch Agent
      'cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << EOF',
      '{',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/opt/tomcat/logs/catalina.out",',
      '            "log_group_name": "/aws/ec2/rhel9/tomcat",',
      '            "log_stream_name": "{instance_id}"',
      '          },',
      '          {',
      '            "file_path": "/var/log/messages",',
      '            "log_group_name": "/aws/ec2/rhel9/system",',
      '            "log_stream_name": "{instance_id}"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'EOF',

      // Get database credentials from Secret Manager
      `SECRET_VALUE=$(aws secretsmanager get-secret-value --secret-id ${props.databaseSecret.secretArn} --region ${this.region} --query SecretString --output text)`,
      'DB_HOST=$(echo $SECRET_VALUE | jq -r .host)',
      'DB_USER=$(echo $SECRET_VALUE | jq -r .username)',
      'DB_PASS=$(echo $SECRET_VALUE | jq -r .password)',
      'DB_NAME=$(echo $SECRET_VALUE | jq -r .dbname)',
      'DB_PORT=$(echo $SECRET_VALUE | jq -r .port)',

      // Create systemd service for Tomcat
      'cat > /etc/systemd/system/tomcat.service << EOF',
      '[Unit]',
      'Description=Apache Tomcat Web Application Container',
      'After=network.target',
      '',
      '[Service]',
      'Type=forking',
      'User=tomcat',
      'Group=tomcat',
      'Environment="JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk"',
      'Environment="CATALINA_PID=/opt/tomcat/temp/tomcat.pid"',
      'Environment="CATALINA_HOME=/opt/tomcat"',
      'Environment="CATALINA_BASE=/opt/tomcat"',
      'Environment="CATALINA_OPTS=-Xms512M -Xmx1024M -server -XX:+UseParallelGC"',
      'Environment="JAVA_OPTS=-Djava.awt.headless=true -Djava.security.egd=file:/dev/./urandom"',
      'Environment="DB_HOST=$DB_HOST"',
      'Environment="DB_USER=$DB_USER"',
      'Environment="DB_PASS=$DB_PASS"',
      'Environment="DB_NAME=$DB_NAME"',
      'Environment="DB_PORT=$DB_PORT"',
      'ExecStart=/opt/tomcat/bin/startup.sh',
      'ExecStop=/opt/tomcat/bin/shutdown.sh',
      'RestartSec=10',
      'Restart=always',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',

      // Configure Tomcat database connection pool
      'cat > /opt/tomcat/conf/context.xml << EOF',
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Context>',
      '    <WatchedResource>WEB-INF/web.xml</WatchedResource>',
      '    <WatchedResource>WEB-INF/tomcat-web.xml</WatchedResource>',
      '    <WatchedResource>${catalina.base}/conf/web.xml</WatchedResource>',
      '    ',
      '    <!-- Database DataSource Configuration -->',
      '    <Resource name="jdbc/PostgreSQLDS"',
      '              auth="Container"',
      '              type="javax.sql.DataSource"',
      '              driverClassName="org.postgresql.Driver"',
      '              url="jdbc:postgresql://$DB_HOST:$DB_PORT/$DB_NAME"',
      '              username="$DB_USER"',
      '              password="$DB_PASS"',
      '              maxTotal="50"',
      '              maxIdle="10"',
      '              maxWaitMillis="10000"',
      '              testOnBorrow="true"',
      '              validationQuery="SELECT 1"/>',
      '</Context>',
      'EOF',
      '',
      // Set proper ownership for Tomcat configuration
      'chown tomcat:tomcat /opt/tomcat/conf/context.xml',

      // Start services
      'systemctl daemon-reload',
      'systemctl enable tomcat',
      'systemctl start tomcat',
      'systemctl enable amazon-cloudwatch-agent',
      'systemctl start amazon-cloudwatch-agent',

      // Configure CloudWatch Agent to start collecting logs
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s',

      // Wait for services to stabilize
      'sleep 10',

      // Verify CloudWatch Agent health and status
      'systemctl status amazon-cloudwatch-agent',

      // Restart CloudWatch Agent if not running properly (error handling)
      'if ! systemctl is-active --quiet amazon-cloudwatch-agent; then systemctl restart amazon-cloudwatch-agent; fi',

      // Verify Tomcat service health
      'systemctl status tomcat',

      // Final health check and monitoring setup
      'echo "CloudWatch Agent status:" >> /var/log/init-status.log',
      'systemctl status amazon-cloudwatch-agent >> /var/log/init-status.log 2>&1',
      'echo "Tomcat status:" >> /var/log/init-status.log',
      'systemctl status tomcat >> /var/log/init-status.log 2>&1'
    );

    this.instance = new ec2.Instance(this, 'ApplicationInstance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.instanceRole,
      securityGroup: props.instanceSecurityGroup,
      userData,
      requireImdsv2: true,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        edition: ec2.AmazonLinuxEdition.STANDARD,
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
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
