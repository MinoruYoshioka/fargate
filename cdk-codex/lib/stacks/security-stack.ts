import { Stack, StackProps, Fn } from 'aws-cdk-lib';
import { Vpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { CfnInstanceProfile, ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface SecurityStackProps extends StackProps {
}

export class SecurityStack extends Stack {
  public readonly loadBalancerSecurityGroup: SecurityGroup;
  public readonly applicationSecurityGroup: SecurityGroup;
  public readonly instanceRole: Role;
  public readonly instanceProfile: CfnInstanceProfile;
  public readonly ec2UserPasswordSecret: Secret;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const vpc = Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: StringParameter.valueForStringParameter(this, '/cdk-codex/network/vpcId'),
      availabilityZones: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/azs')),
      publicSubnetIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/publicSubnetIds')),
      publicSubnetRouteTableIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/publicSubnetRouteTableIds')),
      privateSubnetIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/privateSubnetIds')),
      privateSubnetRouteTableIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/privateSubnetRouteTableIds')),
      isolatedSubnetIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/isolatedSubnetIds')),
      isolatedSubnetRouteTableIds: Fn.split(',', StringParameter.valueForStringParameter(this, '/cdk-codex/network/isolatedSubnetRouteTableIds')),
    });

    this.loadBalancerSecurityGroup = new SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for the public Application Load Balancer',
    });
    this.loadBalancerSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'Allow inbound HTTP');
    this.loadBalancerSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'Allow inbound HTTPS');

    this.applicationSecurityGroup = new SecurityGroup(this, 'Ec2SecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for the application EC2 instance',
    });
    this.applicationSecurityGroup.addIngressRule(
      this.loadBalancerSecurityGroup,
      Port.tcp(8080),
      'Allow ALB to reach Tomcat',
    );

    this.instanceRole = new Role(this, 'Ec2InstanceRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'Instance role permitting Session Manager access and logging',
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    this.instanceProfile = new CfnInstanceProfile(this, 'Ec2InstanceProfile', {
      roles: [this.instanceRole.roleName],
    });

    // Create secret for EC2 user password
    this.ec2UserPasswordSecret = new Secret(this, 'Ec2UserPasswordSecret', {
      description: 'Password for ec2-user account for serial console access',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'password',
        excludeCharacters: ' "\'\\/\\@',
        includeSpace: false,
        passwordLength: 16,
      },
    });

    // Publish identifiers to SSM Parameter Store
    new StringParameter(this, 'ParamAlbSecurityGroupId', {
      parameterName: '/cdk-codex/security/albSecurityGroupId',
      stringValue: this.loadBalancerSecurityGroup.securityGroupId,
    });
    new StringParameter(this, 'ParamEc2SecurityGroupId', {
      parameterName: '/cdk-codex/security/ec2SecurityGroupId',
      stringValue: this.applicationSecurityGroup.securityGroupId,
    });
    new StringParameter(this, 'ParamEc2InstanceRoleArn', {
      parameterName: '/cdk-codex/security/instanceRoleArn',
      stringValue: this.instanceRole.roleArn,
    });
    new StringParameter(this, 'ParamEc2UserPasswordSecretArn', {
      parameterName: '/cdk-codex/security/ec2UserPasswordSecretArn',
      stringValue: this.ec2UserPasswordSecret.secretArn,
    });
  }
}
