import { RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends StackProps {
  readonly logRetention?: RetentionDays;
}

export class MonitoringStack extends Stack {
  public readonly applicationLogGroup: LogGroup;
  public readonly systemLogGroup: LogGroup;

  constructor(scope: Construct, id: string, props?: MonitoringStackProps) {
    super(scope, id, props);

    const retention = props?.logRetention ?? RetentionDays.THREE_MONTHS;

    this.applicationLogGroup = new LogGroup(this, 'ApplicationLogGroup', {
      logGroupName: `/cdk-prd-gaibu/app/tomcat`,
      retention,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.systemLogGroup = new LogGroup(this, 'SystemLogGroup', {
      logGroupName: `/cdk-prd-gaibu/system`,
      retention,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'ApplicationLogGroupName', {
      value: this.applicationLogGroup.logGroupName,
      description: 'CloudWatch Logs group for Tomcat logs',
    });

    new CfnOutput(this, 'SystemLogGroupName', {
      value: this.systemLogGroup.logGroupName,
      description: 'CloudWatch Logs group for system logs',
    });
  }
}
