import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
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

    new StringParameter(this, 'ParamApplicationLogGroupName', {
      parameterName: '/cdk-codex/monitoring/applicationLogGroupName',
      stringValue: this.applicationLogGroup.logGroupName,
    });

    new StringParameter(this, 'ParamSystemLogGroupName', {
      parameterName: '/cdk-codex/monitoring/systemLogGroupName',
      stringValue: this.systemLogGroup.logGroupName,
    });
  }
}
