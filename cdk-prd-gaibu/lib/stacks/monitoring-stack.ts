import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { ILogGroup, LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends StackProps {
  readonly logRetention?: RetentionDays;
}

export class MonitoringStack extends Stack {
  public readonly applicationLogGroup: ILogGroup;
  public readonly systemLogGroup: ILogGroup;

  constructor(scope: Construct, id: string, props?: MonitoringStackProps) {
    super(scope, id, props);

    const retention = props?.logRetention ?? RetentionDays.THREE_MONTHS;

    this.applicationLogGroup = this.ensureLogGroup('ApplicationLogs', `/cdk-prd-gaibu/app/tomcat`, retention);

    this.systemLogGroup = this.ensureLogGroup('SystemLogs', `/cdk-prd-gaibu/system`, retention);

    new CfnOutput(this, 'ApplicationLogGroupName', {
      value: this.applicationLogGroup.logGroupName,
      description: 'CloudWatch Logs group for Tomcat logs',
    });

    new CfnOutput(this, 'SystemLogGroupName', {
      value: this.systemLogGroup.logGroupName,
      description: 'CloudWatch Logs group for system logs',
    });
  }

  private ensureLogGroup(id: string, logGroupName: string, retention: RetentionDays): ILogGroup {
    const physicalId = `LogGroup-${logGroupName}`;
    const region = Stack.of(this).region;

    new AwsCustomResource(this, `${id}Create`, {
      resourceType: 'Custom::LogGroupEnsure',
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'createLogGroup',
        parameters: { logGroupName },
        physicalResourceId: PhysicalResourceId.of(physicalId),
        region,
        ignoreErrorCodesMatching: 'ResourceAlreadyExistsException',
      },
    });

    new AwsCustomResource(this, `${id}Retention`, {
      resourceType: 'Custom::LogGroupRetention',
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'putRetentionPolicy',
        parameters: {
          logGroupName,
          retentionInDays: retention,
        },
        region,
        physicalResourceId: PhysicalResourceId.of(`${physicalId}-retention`),
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
      onUpdate: {
        service: 'CloudWatchLogs',
        action: 'putRetentionPolicy',
        parameters: {
          logGroupName,
          retentionInDays: retention,
        },
        region,
        physicalResourceId: PhysicalResourceId.of(`${physicalId}-retention`),
      },
    });

    return LogGroup.fromLogGroupName(this, `${id}Reference`, logGroupName);
  }
}
