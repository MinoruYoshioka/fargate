import { Stack, StackProps } from 'aws-cdk-lib';
import { IpAddresses, SelectedSubnets, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { StringListParameter, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface NetworkStackProps extends StackProps {
}

export class NetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly publicSubnets: SelectedSubnets;
  public readonly privateSubnets: SelectedSubnets;
  public readonly isolatedSubnets: SelectedSubnets;

  constructor(scope: Construct, id: string, props?: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'ApplicationVpc', {
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      natGateways: 1,
      maxAzs: 2,
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

    // Publish to SSM Parameter Store
    new StringParameter(this, 'ParamNetworkVpcId', {
      parameterName: '/cdk-codex/network/vpcId',
      stringValue: this.vpc.vpcId,
    });
    new StringListParameter(this, 'ParamNetworkAzs', {
      parameterName: '/cdk-codex/network/azs',
      stringListValue: azs,
    });
    new StringListParameter(this, 'ParamNetworkPublicSubnetIds', {
      parameterName: '/cdk-codex/network/publicSubnetIds',
      stringListValue: publicSubnetIds,
    });
    new StringListParameter(this, 'ParamNetworkPublicSubnetRouteTableIds', {
      parameterName: '/cdk-codex/network/publicSubnetRouteTableIds',
      stringListValue: publicSubnetRouteTableIds,
    });
    new StringListParameter(this, 'ParamNetworkPrivateSubnetIds', {
      parameterName: '/cdk-codex/network/privateSubnetIds',
      stringListValue: privateSubnetIds,
    });
    new StringListParameter(this, 'ParamNetworkPrivateSubnetRouteTableIds', {
      parameterName: '/cdk-codex/network/privateSubnetRouteTableIds',
      stringListValue: privateSubnetRouteTableIds,
    });
    new StringListParameter(this, 'ParamNetworkIsolatedSubnetIds', {
      parameterName: '/cdk-codex/network/isolatedSubnetIds',
      stringListValue: isolatedSubnetIds,
    });
    new StringListParameter(this, 'ParamNetworkIsolatedSubnetRouteTableIds', {
      parameterName: '/cdk-codex/network/isolatedSubnetRouteTableIds',
      stringListValue: isolatedSubnetRouteTableIds,
    });
  }
}
