# Fargate with Aurora Serverless v2 Stack

このプロジェクトは、AWS Fargate と Aurora Serverless v2 を使用したコンテナアプリケーションのインフラストラクチャをAWS CDKで定義しています。

## アーキテクチャの概要

- **コンテナ実行環境**: Amazon ECS on AWS Fargate
- **データベース**: Amazon Aurora Serverless v2 (PostgreSQL互換)
- **ロードバランサー**: Application Load Balancer (ALB)
- **ネットワーク**: Multi-AZ VPC with public/private/isolated subnets
- **セキュリティ**: AWS Secrets Manager for credentials management

## 主な特徴

### Aurora Serverless v2の利点
- **自動スケーリング**: 0.5〜2 ACU (Aurora Capacity Units) の範囲で自動スケール
- **高可用性**: マルチAZ構成で自動フェイルオーバー
- **読み取りレプリカ**: 読み取り専用エンドポイントによる負荷分散
- **Performance Insights**: データベースパフォーマンスの詳細な監視
- **暗号化**: 保存時および転送時のデータ暗号化

### Fargateサービスの機能
- **オートスケーリング**: CPU/メモリ使用率に基づく自動スケーリング (2〜10タスク)
- **ブルーグリーンデプロイメント**: ダウンタイムなしのローリングアップデート
- **ヘルスチェック**: ALBによる定期的なヘルスチェック
- **ログ管理**: CloudWatch Logsへの自動ログ転送

## 前提条件

- Node.js (v16以降)
- AWS CLI (設定済み)
- AWS CDK CLI (`npm install -g aws-cdk`)

## セットアップ

1. 依存関係のインストール:
```bash
cd fargate-aurora
npm install
```

2. CDKスタックのビルド:
```bash
npm run build
```

3. スタックの確認 (dry-run):
```bash
cdk synth
```

4. スタックのデプロイ:
```bash
cdk deploy
```

## デプロイ後の確認

デプロイが完了すると、以下の情報がCloudFormationの出力として表示されます：

- **LoadBalancerDNS**: アプリケーションにアクセスするためのALBのDNS名
- **AuroraClusterEndpoint**: 書き込み用のAuroraクラスターエンドポイント
- **AuroraReadEndpoint**: 読み取り専用のAuroraクラスターエンドポイント
- **SecretArn**: データベース認証情報を含むSecrets ManagerのARN

## アプリケーションへのアクセス

```bash
curl http://<LoadBalancerDNS>/
```

## データベースへの接続

Secrets Managerから認証情報を取得:
```bash
aws secretsmanager get-secret-value --secret-id migration/aurora-db-credentials --query SecretString --output text | jq .
```

PostgreSQLクライアントで接続:
```bash
psql -h <AuroraClusterEndpoint> -U postgres -d migrateddb
```

## スケーリング設定

### Aurora Serverless v2
- 最小容量: 0.5 ACU
- 最大容量: 2 ACU
- 自動的にワークロードに応じてスケール

### Fargateタスク
- 最小タスク数: 2
- 最大タスク数: 10
- CPU使用率70%でスケールアウト
- メモリ使用率70%でスケールアウト

## コスト最適化のポイント

1. **Aurora Serverless v2**: 使用量に応じた課金で、アイドル時はコストを削減
2. **NAT Gateway**: 1つのみ使用してコストを削減
3. **ログ保持期間**: 7日間に設定（必要に応じて調整可能）
4. **Spot Fargate**: 本番環境では検討可能（現在は通常のFargate）

## クリーンアップ

リソースを削除する場合:
```bash
cdk destroy
```

## トラブルシューティング

### タスクが起動しない場合
1. CloudWatch Logsでタスクのログを確認
2. ECSコンソールでタスクの詳細を確認
3. セキュリティグループの設定を確認

### データベース接続エラー
1. Secrets Managerの認証情報を確認
2. セキュリティグループのルールを確認
3. VPCのルーティングテーブルを確認

## カスタマイズ

### Spring Bootアプリケーションへの変更

`lib/fargate-aurora-stack.ts`の以下の部分を修正:

```typescript
image: ecs.ContainerImage.fromEcrRepository(yourEcrRepo, 'latest'),
containerPort: 8080, // Spring Bootのデフォルトポート
```

ヘルスチェックパスも調整:
```typescript
path: '/actuator/health', // Spring Boot Actuatorのヘルスチェック
```

### Aurora設定の調整

本番環境向けには以下を検討:
- `serverlessV2MaxCapacity`を増やす（例: 16 ACU）
- `deletionProtection`を`true`に設定
- `removalPolicy`を`cdk.RemovalPolicy.RETAIN`に変更

## ライセンス

このサンプルコードはMITライセンスの下で提供されています。