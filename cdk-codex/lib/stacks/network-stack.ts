import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { IpAddresses, SelectedSubnets, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkStackProps extends StackProps {
  readonly cidr?: string;
  readonly maxAzs?: number;
}

export class NetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly publicSubnets: SelectedSubnets;
  public readonly privateSubnets: SelectedSubnets;
  public readonly isolatedSubnets: SelectedSubnets;

  constructor(scope: Construct, id: string, props?: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'ApplicationVpc', {
      ipAddresses: IpAddresses.cidr(props?.cidr ?? '10.0.0.0/16'),
      natGateways: 1,
      maxAzs: props?.maxAzs ?? 2,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'PrivateWithEgress',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.publicSubnets = this.vpc.selectSubnets({ subnetType: SubnetType.PUBLIC });
    this.privateSubnets = this.vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS });
    this.isolatedSubnets = this.vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED });

    new CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'Provisioned VPC identifier',
    });
    new CfnOutput(this, 'PublicSubnetIds', {
      value: this.publicSubnets.subnetIds.join(','),
      description: 'Public subnet identifiers',
    });
    new CfnOutput(this, 'PrivateSubnetIds', {
      value: this.privateSubnets.subnetIds.join(','),
      description: 'Private subnet identifiers',
    });
    new CfnOutput(this, 'IsolatedSubnetIds', {
      value: this.isolatedSubnets.subnetIds.join(','),
      description: 'Isolated subnet identifiers',
    });
  }
}
