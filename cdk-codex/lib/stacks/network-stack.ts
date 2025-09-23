import { Stack, StackProps, Fn } from 'aws-cdk-lib';
import { IpAddresses, SelectedSubnets, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
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

    // Collect attributes for VPC import in other stacks
    const azs = this.availabilityZones;
    const publicSubnetIds = this.vpc.publicSubnets.map((s) => s.subnetId);
    const publicSubnetRouteTableIds = this.vpc.publicSubnets.map((s) => s.routeTable.routeTableId);
    const privateSubnetIds = this.vpc.privateSubnets.map((s) => s.subnetId);
    const privateSubnetRouteTableIds = this.vpc.privateSubnets.map((s) => s.routeTable.routeTableId);
    const isolatedSubnetIds = this.vpc.isolatedSubnets.map((s) => s.subnetId);
    const isolatedSubnetRouteTableIds = this.vpc.isolatedSubnets.map((s) => s.routeTable.routeTableId);

    // Publish to SSM Parameter Store (comma-separated lists)
    new StringParameter(this, 'ParamNetworkVpcId', {
      parameterName: '/cdk-codex/network/vpcId',
      stringValue: this.vpc.vpcId,
    });
    new StringParameter(this, 'ParamNetworkAzs', {
      parameterName: '/cdk-codex/network/azs',
      stringValue: azs.join(','),
    });
    new StringParameter(this, 'ParamNetworkPublicSubnetIds', {
      parameterName: '/cdk-codex/network/publicSubnetIds',
      stringValue: publicSubnetIds.join(','),
    });
    new StringParameter(this, 'ParamNetworkPublicSubnetRouteTableIds', {
      parameterName: '/cdk-codex/network/publicSubnetRouteTableIds',
      stringValue: publicSubnetRouteTableIds.join(','),
    });
    new StringParameter(this, 'ParamNetworkPrivateSubnetIds', {
      parameterName: '/cdk-codex/network/privateSubnetIds',
      stringValue: privateSubnetIds.join(','),
    });
    new StringParameter(this, 'ParamNetworkPrivateSubnetRouteTableIds', {
      parameterName: '/cdk-codex/network/privateSubnetRouteTableIds',
      stringValue: privateSubnetRouteTableIds.join(','),
    });
    new StringParameter(this, 'ParamNetworkIsolatedSubnetIds', {
      parameterName: '/cdk-codex/network/isolatedSubnetIds',
      stringValue: isolatedSubnetIds.join(','),
    });
    new StringParameter(this, 'ParamNetworkIsolatedSubnetRouteTableIds', {
      parameterName: '/cdk-codex/network/isolatedSubnetRouteTableIds',
      stringValue: isolatedSubnetRouteTableIds.join(','),
    });
  }
}
