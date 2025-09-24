# CDK-CODEX - 外部向けWebアプリケーション基盤

このプロジェクトは、AWS CDK（TypeScript）を使用した外部向けWebアプリケーション基盤のInfrastructure as Codeです。
本番環境向けの堅牢で可用性の高いインフラストラクチャを構築します。

## アーキテクチャ概要

本プロジェクトは、以下の5つのスタックで構成されています：

### 1. NetworkStack（ネットワークスタック）
- **VPC**: デフォルトCIDR `10.0.0.0/16`、カスタマイズ可能
- **サブネット**: パブリック、プライベート、アイソレーテッドサブネット
- **NAT Gateway**: 1つのNAT Gateway（高可用性とコストのバランス）
- **AZ**: デフォルト2つのAvailability Zone、最大数設定可能

### 2. SecurityStack（セキュリティスタック）
- **ALB用セキュリティグループ**: HTTP(80)の受信を許可
- **EC2用セキュリティグループ**: ALBからのTomcat(8080)アクセスを許可
- **IAMロール**: EC2インスタンス用（SSM、CloudWatch、Secrets Manager権限）
- **EC2ユーザーパスワードシークレット**: インスタンスアクセス用

### 3. MonitoringStack（監視スタック）
- **CloudWatch ロググループ**: アプリケーションログとシステムログ
- **ログ保持期間**: 固定3ヶ月
- **SSMパラメータ**: ロググループ名を他スタックで参照可能

### 4. DatabaseStack（データベーススタック）
- **Aurora PostgreSQL**: サーバーレス v2クラスタ
- **データベース名**: 固定 `appdb`
- **セキュリティ**: アプリケーションからのアクセスのみ許可
- **サブネットグループ**: アイソレーテッドサブネット使用

### 5. ComputeStack（コンピュートスタック）
- **EC2インスタンス**: RHEL 9、t3.medium、プライベートサブネット配置
- **Application Load Balancer**: パブリックサブネットに配置、HTTP(80)のみ
- **UserData**: Java 8、SSM Agent、CloudWatch Agentを自動インストール
- **ヘルスチェック**: ALBからのアプリケーションヘルスチェック
- **監視**: CPU使用率、ALB 5xxエラー用CloudWatchアラーム

## 技術スタック

- **OS**: Red Hat Enterprise Linux 9
- **Java**: OpenJDK 8（java-1.8.0-openjdk + devel）
- **アプリケーションサーバー**: Apache Tomcat（ポート8080）
- **データベース**: Aurora PostgreSQL
- **監視**: CloudWatch Logs & Metrics
- **管理**: AWS Systems Manager（SSM）

## デプロイ方法

### 前提条件
- AWS CLI設定済み
- Node.js 18以上
- CDK CLI（`npm install -g aws-cdk`）

### 環境設定
```bash
npm install
```

### 設定可能なコンテキスト変数
```bash
# VPC CIDR範囲の変更
cdk deploy -c vpcCidr=192.168.0.0/16

# 最大AZ数の変更
cdk deploy -c maxAzs=3
```

### 個別スタックデプロイ
```bash
# ネットワークのみ
STACK=network cdk deploy

# セキュリティまで
STACK=security cdk deploy

# 監視スタックのみ
STACK=monitoring cdk deploy

# データベースまで
STACK=database cdk deploy

# 全体（コンピュートまで）
STACK=compute cdk deploy
```

### 全スタック一括デプロイ
```bash
cdk deploy --all
```

## 有用なコマンド

* `npm run build`   - TypeScriptをJavaScriptにコンパイル
* `npm run watch`   - ファイル変更を監視してコンパイル
* `npm run test`    - Jestユニットテストを実行
* `npx cdk deploy`  - スタックをAWSアカウント/リージョンにデプロイ
* `npx cdk diff`    - デプロイ済みスタックと現在の状態を比較
* `npx cdk synth`   - CloudFormationテンプレートを生成
* `npx cdk destroy` - スタックを削除

## セキュリティ考慮事項

- EC2インスタンスはプライベートサブネットに配置
- IMDSv2を強制有効化
- セキュリティグループで最小権限の原則を適用
- データベースは専用のアイソレーテッドサブネットに配置
- Secrets Managerによる認証情報の安全な管理
- SSM Parameter Storeによるクロススタック参照（CfnOutput廃止）

## 監視・ログ

- **システムログ**: `/var/log/messages`、SSMエージェント、UserDataログ
- **アプリケーションログ**: Tomcatログ（`/var/log/tomcat/catalina.out`）
- **メトリクス**: CPU使用率、ALB 5xxエラー数
- **アラーム**: CPU 80%超過、ALB 5xxエラー 5件超過

## 注意事項

- 本番環境では`STACK`環境変数を使用せず、全スタックをデプロイしてください
- データベース削除保護が有効になっているため、削除時は注意が必要です
- NAT Gatewayの料金にご注意ください（高可用性が必要な場合は複数AZに配置を検討）

## ライセンス

このプロジェクトはMITライセンスの下で公開されています。