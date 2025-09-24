import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends StackProps {
}

export class MonitoringStack extends Stack {
  public readonly applicationLogGroup: LogGroup;
  public readonly systemLogGroup: LogGroup;

  constructor(scope: Construct, id: string, props?: MonitoringStackProps) {
    super(scope, id, props);

    const retention = RetentionDays.THREE_MONTHS;

    this.applicationLogGroup = new LogGroup(this, 'ApplicationLogGroup', {
      logGroupName: `/prd-gaibu/app/tomcat`,
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.systemLogGroup = new LogGroup(this, 'SystemLogGroup', {
      logGroupName: `/prd-gaibu/system`,
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new StringParameter(this, 'ParamApplicationLogGroupName', {
      parameterName: '/prd-gaibu/monitoring/applicationLogGroupName',
      stringValue: this.applicationLogGroup.logGroupName,
    });

    new StringParameter(this, 'ParamSystemLogGroupName', {
      parameterName: '/prd-gaibu/monitoring/systemLogGroupName',
      stringValue: this.systemLogGroup.logGroupName,
    });
  }
}