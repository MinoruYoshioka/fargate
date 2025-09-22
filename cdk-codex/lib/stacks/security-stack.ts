import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { CfnInstanceProfile, ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface SecurityStackProps extends StackProps {
  readonly vpc: IVpc;
}

export class SecurityStack extends Stack {
  public readonly loadBalancerSecurityGroup: SecurityGroup;
  public readonly applicationSecurityGroup: SecurityGroup;
  public readonly instanceRole: Role;
  public readonly instanceProfile: CfnInstanceProfile;
  public readonly ec2UserPasswordSecret: Secret;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    this.loadBalancerSecurityGroup = new SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Security group for the public Application Load Balancer',
    });
    this.loadBalancerSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'Allow inbound HTTP');
    this.loadBalancerSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'Allow inbound HTTPS');

    this.applicationSecurityGroup = new SecurityGroup(this, 'Ec2SecurityGroup', {
      vpc: props.vpc,
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

    new CfnOutput(this, 'AlbSecurityGroupId', {
      value: this.loadBalancerSecurityGroup.securityGroupId,
      description: 'Security group for the ALB',
    });
    new CfnOutput(this, 'Ec2SecurityGroupId', {
      value: this.applicationSecurityGroup.securityGroupId,
      description: 'Security group for the EC2 instance',
    });
    new CfnOutput(this, 'Ec2InstanceRoleArn', {
      value: this.instanceRole.roleArn,
      description: 'ARN of the EC2 instance IAM role',
    });
  }
}
