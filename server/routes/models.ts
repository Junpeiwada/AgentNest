import { Router } from "express";
import { getCachedModels, prefetchModels } from "../claude/executor.js";

const router = Router();

// キャッシュ済みのモデル一覧を返す（毎回 query() を起動しない）。
// 起動時プリフェッチが未成功（CLI未準備等）でキャッシュが空なら、ここで一度だけ再試行する。
// prefetchModels は成功するまで内部フラグを立てないため、回復後の初回アクセスで一覧が埋まる。
// それでも空なら従来どおり空配列を返し、フロントは「おまかせ」のみ表示する縮退動作になる。
router.get("/api/models", async (_req, res) => {
  if (getCachedModels().length === 0) {
    await prefetchModels();
  }
  res.json({ models: getCachedModels() });
});

export default router;
