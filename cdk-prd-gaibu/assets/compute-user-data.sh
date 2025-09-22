yum update -y
yum install -y java-1.8.0-openjdk tomcat amazon-cloudwatch-agent jq awscli
systemctl enable --now tomcat

SECRET_ARN="__SECRET_ARN__"
AWS_REGION=$(curl -s http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region)
SECRET_VALUE=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region "$AWS_REGION" --query SecretString --output text)
DB_USERNAME=$(echo "$SECRET_VALUE" | jq -r .username)
DB_PASSWORD=$(echo "$SECRET_VALUE" | jq -r .password)
DB_HOST="__DB_HOST__"
DB_PORT="__DB_PORT__"
DB_NAME="__DB_NAME__"

cat <<'ENVVARS' >/etc/profile.d/app-db.sh
export DB_USERNAME="$DB_USERNAME"
export DB_PASSWORD="$DB_PASSWORD"
export DB_ENDPOINT="$DB_HOST"
export DB_PORT="$DB_PORT"
export DB_NAME="$DB_NAME"
ENVVARS
chmod 600 /etc/profile.d/app-db.sh

install -d -m 0755 /opt/aws/amazon-cloudwatch-agent/etc
cat <<'CFG' >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
__CLOUDWATCH_AGENT_CONFIG__
CFG

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
