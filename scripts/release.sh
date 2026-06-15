#!/bin/bash
set -e

# ghコマンドの存在チェック
if ! command -v gh &> /dev/null; then
  echo "エラー: GitHub CLI (gh) がインストールされていません"
  echo "  brew install gh && gh auth login"
  exit 1
fi

# gh auth tokenからGH_TOKENを取得
export GH_TOKEN=$(gh auth token 2>/dev/null)
if [ -z "$GH_TOKEN" ]; then
  echo "エラー: GitHub CLIが未認証です"
  echo "  gh auth login を実行してください"
  exit 1
fi
echo "GitHub認証: OK"

# cargo PATHの確認
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo &> /dev/null; then
  echo "エラー: Rust (cargo) がインストールされていません"
  exit 1
fi

# Tauri署名キーの読み込み
if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  if [ -f "$HOME/.tauri/AgentNest.key" ]; then
    export TAURI_SIGNING_PRIVATE_KEY=$(cat "$HOME/.tauri/AgentNest.key")
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
    echo "署名キー: ~/.tauri/AgentNest.key から読み込み"
  else
    echo "エラー: TAURI_SIGNING_PRIVATE_KEY が未設定で、~/.tauri/AgentNest.key も見つかりません"
    echo "  自動更新には署名が必須です"
    exit 1
  fi
else
  echo "署名キー: 環境変数から読み込み"
fi

# 現在のブランチを取得
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "現在のブランチ: ${BRANCH}"

# 1. バージョンアップ
echo "=== バージョンアップ ==="
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
echo "リリースバージョン: v${VERSION}"

# 2. バージョン変更をコミット & タグ
git add package.json package-lock.json
git commit -m "リリース: v${VERSION}"
git tag "v${VERSION}"

# 3. フロントエンド・サーバービルド → Tauriビルド（beforeBuildCommandで自動実行）
# Universal Binary（x86_64 + arm64）でビルドし、Intel/Apple Silicon両方で動作させる
echo "=== Tauriビルド（Universal Binary、フロントエンド・サーバー含む）==="
npx tauri build --target universal-apple-darwin

# 5. git push（タグをリリース前にpush）
echo "=== git push ==="
git push origin "${BRANCH}"
git push origin "v${VERSION}"

# 6. GitHub Releasesへ公開
echo "=== GitHub Releasesへ公開 ==="
BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"

# リリース作成
gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --draft \
  --generate-notes

# DMGアップロード
if [ -d "$BUNDLE_DIR/dmg" ]; then
  for f in "$BUNDLE_DIR/dmg"/*.dmg; do
    [ -f "$f" ] && gh release upload "v${VERSION}" "$f"
  done
fi

# updater用アーティファクト（.app.tar.gz）アップロード
if [ -f "$BUNDLE_DIR/macos/AgentNest.app.tar.gz" ]; then
  gh release upload "v${VERSION}" "$BUNDLE_DIR/macos/AgentNest.app.tar.gz"
  echo "updater用バンドルをアップロード"
fi

# latest.jsonを生成してアップロード
SIGNATURE=$(cat "$BUNDLE_DIR/macos/AgentNest.app.tar.gz.sig")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$BUNDLE_DIR/macos/latest.json" <<JSONEOF
{
  "version": "${VERSION}",
  "notes": "v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/Junpeiwada/AgentNest/releases/download/v${VERSION}/AgentNest.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/Junpeiwada/AgentNest/releases/download/v${VERSION}/AgentNest.app.tar.gz"
    }
  }
}
JSONEOF
gh release upload "v${VERSION}" "$BUNDLE_DIR/macos/latest.json"
echo "latest.jsonをアップロード"

# 9. draftリリースを公開
echo "=== リリースを公開 ==="
gh release edit "v${VERSION}" --draft=false

# 8. 古いリリースを削除（最新以外）
echo "=== 古いリリースを削除 ==="
TAGS=$(gh release list --json tagName -q '.[].tagName' 2>/dev/null || true)
if [ -n "$TAGS" ]; then
  echo "$TAGS" | tail -n +2 | while read -r tag; do
    if [ -n "$tag" ]; then
      echo "  削除: ${tag}"
      gh release delete "${tag}" --yes --cleanup-tag 2>/dev/null || true
    fi
  done
fi

echo ""
echo "=== リリース完了: v${VERSION} ==="
say -v Kyoko "AgentNestリリースバージョン${VERSION}が完了しました" &
