# 復元済み環境の引き渡し案

**種別は未承認の設計提案。**
所有者は配備運用と復旧担当、対象読者は保護された配備の承認者と運用者。
R2 の既存データ復元と引き渡しを扱い、DB を保持した R3 の修復と区別する。現行の復元機能の拡張や本番操作を承認する文書ではない。
既存の [配備ライフサイクル](DEPLOYMENT-LIFECYCLE.md)、[復旧契約](BACKUP.md)、[初回配備](INITIAL-DEPLOYMENT-FLOW.md) が定める状態遷移、承認、単一 writer の制約を適用する。

## 実行面の選択

| 案 | 実行面 | 運用上の差 |
| --- | --- | --- |
| 復旧担当が隔離先を復元し、配備運用者が同じ認定済み Backend handoff で起動する | 既存の独立秘密管理、オペレーター手順、Ansible、保護された production queue | 復号鍵を配備面に渡さず、証拠の照合と公開承認を既存の配備トランザクションで実施できる |
| R3 の手順で同じ VM 上の既存サービスを修復して再起動する | 既存の rootless Quadlet、通常復旧ヘルパー、Ansible | DB、資格情報、認定済み配備状態が残る障害を扱える。VM または DB を喪失した場合は復元が先行する |

復元を要する既存環境には第一案を採ることを提案する。
R3 の同一環境修復は既知の健全な release と DB の組を保持できる場合に適用する。
保全証拠の照合には既存の読取専用 Preflight と保護された運用記録を使う案とする。
保護された復元素材を扱うのは復旧担当者と隔離先に限り、通常 Backend handoff は証拠の非秘密部分を参照する。

## 復元点と公開承認の照合

1. 復旧担当者は独立保管先のバックアップを選び、保護された運用 receipt の送信元、取得対象、暗号文 digest と照合する。v2 のダウンロード、復号、隔離ドリルで DB と history を確認する。同時に復旧鍵、DB ロール、Podman secrets と外部サービス設定の取得経路を確認する。
2. 対象の明示承認後、配備運用者は既存 Ansible で隔離された復元先の基盤を収束する。復旧担当者は DB、history、資格情報を既存手順で復元する。既存データを収める VM または DB への上書きや復元点以後の書込みの扱いには、対象と失われる範囲を明示した別の操作承認を使う。元の writer が停止した証拠、または同時稼働できない状態の確認を公開の前提にする。
3. 復元先で、選択済みバックアップの内容と PostgreSQL ledger、DB と history の fingerprint、owner と Passkey、OAuth client、認証設定、資格情報の識別子を照合する。論理復元では source と target の PostgreSQL cluster ID や DB OID が変わり得る。独立 receipt が選択元を識別し、復元先で実測したホスト、cluster ID、DB OID を同じ復元操作に結び付ける。R3 の同一環境修復では現在の DB と release の既存 identity を照合する。
4. Preflight から公開まで、検証済みの復元先と候補 digest、互換な通常 Frontend、承認期限を同じ保護記録に結び付ける。復元先が clean API slot の場合は、R6 の既存条件と承認を満たした上で既存 owner と client で起動する。既存配備の復旧は再観測後に該当する R3 を用いる。DB が健全なままの R3 は該当する基盤またはサービスだけを修復する。
5. readiness、正しい immutable digest、外部の許可と拒否、既存 owner の認証を確認する。公開後は新規に受理した書込みを含む復旧点を決めてから次の復旧操作に移る。保存先の再確認と独立復元の受入は通常 Console と復旧担当者が記録する。

復元元でバックアップを実行できる主体と、復元先で起動する executor も別に確認する。
隔離ドリルでは本番の書込資格情報を渡さず、復元先の executor を停止した状態で選択した receipt と復元内容を照合する。
worker の再開は、元の executor を停止するか書込みを遮断し、既存の host lock 下で復元した run、operation、schedule slot を独立保全証拠と照合した後に行う。復元された要求は自動実行から外し、運用側の判断を既存 journal に残す案とする。
保存先、許可設定、資格情報を再利用できるか判断できない場合は停止させ、通常 Console の承認済み再設定と検証を経て有効化する。

中断時は既存の transaction 記録と現状態を再照合する。
用途が確定しない記録、復元不足、複数 writer の可能性、復元素材の欠落、別のホストや候補に紐付く証拠、期限切れは停止にする。
公開前に失敗した対象は隔離状態に戻し、復元済みデータと記録を保持する。

## Preflight へ引き渡す非秘密の証拠案

復旧担当者が復元操作 ID に対する証拠を発行し、配備運用者が対象、公開承認と停止・遮断の実測を付ける。
原本を既存の独立した保護運用記録に保管する。
配備運用者は承認済み記録の検証用写しだけを、既存の保護された VM 管理経路から配置する案とする。
配置先は既存の VM 内配備状態と同じ運用面で管理し、保護された配備主体だけに書込みを許可する。Preflight はピン留めした管理接続で読み取り、一般の Workflow 入力、Console、復元元の S3 オブジェクトから渡された主張を発行元として扱わない。

| 区分 | 照合する項目 | 発行者または観測者 |
| --- | --- | --- |
| 選択した復旧点 | 復元操作 ID、環境、backup ID、source identity、取得時刻、v2 の checksum manifest と独立転送 receipt の SHA-256、隔離 restore receipt の SHA-256。source cluster ID と DB OID は既存の認証済み元記録で確認できた場合に記録 | 復旧担当者。独立保管された receipt と選択した暗号文から確認 |
| 復元先 | 管理接続の pin、ホスト ID、target cluster ID と DB OID、logical DB と history の fingerprint、ledger、owner binding、Auth catalog と runtime 設定の fingerprint、Passkey と OAuth client の検証結果、必要な role と秘密の再配備を確認した記録 ID | 復旧担当者が復元を証明し、配備運用者が対象と生きた観測を確認 |
| 公開の承認 | Backend の認定 source と immutable digest、互換 Frontend の identity、対象の R6 または R3、承認済み UTC window、復元点以後の書込みの扱い、元の writer と executor の停止または再起動を防ぐ遮断の記録 | 配備運用者が既存の保護された承認と観測を紐付ける |

v2 manifest の database と history の fingerprint は内容照合用で、source cluster ID や DB OID の代わりには使わない。
証拠には平文データ、接続文字列、バックアップ鍵、資格情報を入れない。
既存 Preflight は認証元を確認した証拠の digest を `backupSha256` に関連付ける候補とする。
digest はすり替えを検出する手掛かりで、証拠の発行元は保護された運用経路で確認する。

保護された handoff は production queue と既存の host lock の下で、同じ記録の digest、承認期限、対象の host/cluster/OID、復元内容、ledger、owner と Auth、候補および Frontend を再照合する。
元の writer の停止または遮断が現在も有効なことを確認し、Tunnel の公開直前に承認期限と対象を再確認する。
別の対象や古い記録は R0 で停止し、再判定する。
ここで示す証拠の形式・権限・取込境界は承認対象であり、現行 Preflight や配備コードが対応済みであることを前提にしない。
[Preflight の binding](../../scripts/deployment/preflight/observe.mjs) [配備トランザクション](../../deploy/ansible/deploy-transaction.yml)

## 受入証拠

| 検証環境 | 確認する事実 |
| --- | --- |
| 使い捨て VM | 合成した既存 owner と原稿を独立保存から別の PostgreSQL へ復元。source と target の cluster ID/OID が異なっても証拠が正しい対象に結び付く。source 側の ID がない v2 でも認証済みのバックアップ識別子で選択元を確認し、target 側の ID は必ず測る。既存 owner を使って起動する |
| 拒否と再開の試験 | ほかの source、対象差し替え、証拠の改変または欠落、発行元不明、候補変更、期限切れ、元 writer の再出現、復元済み executor の未照合を試す。それぞれ対象の公開または executor 再開を拒否し、既存の記録を保全する。中断後は同じ対象と現状態を再検証する |
| 実環境 | 実際の保存先と独立ホストで復元し、運用者が RPO/RTO、復元点以後の書込み、元 writer 停止、外部経路、owner のログイン、バックアップ運用を受け入れる |

現行の [Ansible 隔離ドリル](../../deploy/ansible/restore-drill.yml) は使い捨て資源を使い、[通常配備の中断復旧](../../deploy/ansible/push-deployment-recover.sh) は既存の release 状態を扱う。
既存の Preflight、配備面と保護運用記録への引き渡しが受け入れられる場合に限り、それらを復元済み環境の公開へつなぐ。
初回専用の保全 receipt や credential escrow を復旧の証拠として再導入せず、既存の v2 保全資料と独立した復旧鍵を利用する。
