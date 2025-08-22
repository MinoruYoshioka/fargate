# Fargate with Aurora Provisioned Stack

このプロジェクトは、AWS Fargate と Aurora（プロビジョンド版）を使用したコンテナアプリケーションのインフラストラクチャをAWS CDKで定義しています。

## アーキテクチャの概要

- **コンテナ実行環境**: Amazon ECS on AWS Fargate
- **データベース**: Amazon Aurora PostgreSQL（プロビジョンド版）
- **ロードバランサー**: Application Load Balancer (ALB)
- **ネットワーク**: Multi-AZ VPC with public/private/isolated subnets
- **セキュリティ**: AWS Secrets Manager for credentials management

## 主な特徴

### Aurora プロビジョンド版の利点
- **予測可能な性能**: 固定インスタンスタイプによる一貫したパフォーマンス
- **高可用性**: 1台のWriter + 2台のReaderによるマルチAZ構成
- **読み取りスケーラビリティ**: 複数のReadレプリカによる負荷分散
- **Performance Insights**: データベースパフォーマンスの詳細な監視
- **暗号化**: 保存時および転送時のデータ暗号化
- **長期バックアップ**: 30日間の自動バックアップ

### Fargateサービスの機能
- **強化されたリソース**: 2 vCPU / 4GB RAM での実行
- **オートスケーリング**: CPU/メモリ使用率に基づく自動スケーリング (3〜6タスク)
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
- **ClusterInstanceCount**: Auroraクラスターのインスタンス数

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
# ライターへの接続（読み書き可能）
psql -h <AuroraClusterEndpoint> -U postgres -d migrateddb

# リーダーへの接続（読み取り専用）
psql -h <AuroraReadEndpoint> -U postgres -d migrateddb
```

## スケーリング設定

### Aurora プロビジョンド版
- **Writer**: 1台 (r6g.large)
- **Reader**: 2台 (r6g.large)
- **固定インスタンス**: 予測可能なコストとパフォーマンス

### Fargateタスク
- 最小タスク数: 3
- 最大タスク数: 6
- CPU使用率75%でスケールアウト
- メモリ使用率75%でスケールアウト

## モニタリング

### CloudWatchアラーム
- **CPU使用率**: 80%以上で警告
- **接続数**: 80接続以上で警告
- **Performance Insights**: 詳細なクエリレベル分析

### ログ管理
- **アプリケーションログ**: CloudWatch Logs (14日間保持)
- **Auroraログ**: 全SQLステートメント記録
- **スロークエリ**: 1秒以上のクエリを記録

## コスト最適化のポイント

1. **固定インスタンス**: 予測可能な月額コスト
2. **NAT Gateway**: 1つのみ使用してコストを削減
3. **ログ保持期間**: 14日間に設定（必要に応じて調整可能）
4. **インスタンスタイプ**: r6g.largeで性能とコストのバランス

## 本番環境での推奨設定

```typescript
// より大きなインスタンス
instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.XLARGE)

// 削除保護を有効化
deletionProtection: true,
removalPolicy: cdk.RemovalPolicy.RETAIN,

// より長いバックアップ保持期間
retention: cdk.Duration.days(35),

// より多くのリーダーレプリカ
readers: [
  // 3-4台のリーダーレプリカを設定
]
```

## クリーンアップ

リソースを削除する場合:
```bash
cdk destroy
```

**注意**: プロビジョンドインスタンスは削除に時間がかかる場合があります。

## トラブルシューティング

### タスクが起動しない場合
1. CloudWatch Logsでタスクのログを確認
2. ECSコンソールでタスクの詳細を確認
3. セキュリティグループの設定を確認

### データベース接続エラー
1. Secrets Managerの認証情報を確認
2. セキュリティグループのルールを確認
3. Aurora クラスターの状態を確認

### 性能問題
1. Performance Insightsでクエリ性能を確認
2. CloudWatchメトリクスでリソース使用率を確認
3. 読み取り負荷をリーダーレプリカに分散

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

### インスタンスタイプの変更

開発環境向けには小さなインスタンス:
```typescript
instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM)
```

本番環境向けにはより大きなインスタンス:
```typescript
instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.XLARGE)
```

## Serverlessとの比較

| 項目 | Aurora Serverless v2 | Aurora プロビジョンド |
|------|---------------------|---------------------|
| **コスト** | 使用量ベース | 固定月額 |
| **起動時間** | コールドスタートあり | 常時稼働 |
| **性能** | 変動的 | 予測可能 |
| **スケール** | 自動（0.5-128 ACU） | 手動（インスタンス追加） |
| **適用場面** | 不定期ワークロード | 常時稼働アプリ |

## ライセンス

このサンプルコードはMITライセンスの下で提供されています。