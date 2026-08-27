import type { Request, Response } from "express";
import { sanitizeConnectionId } from "../claude/executor.js";

/**
 * リクエストから connectionId（HTTPヘッダ `X-Connection-Id`）を取り出す。
 *
 * 通常は `server/index.ts` のミドルウェアが検証済みの値を `res.locals` に入れているが、
 * ルーターを単体でマウントした場合（単体チェック等、ミドルウェアを通らない構成）にも
 * 動くよう、`res.locals` が空ならヘッダから直接読むフォールバックを持たせている。
 * ルーターが外部ミドルウェアの有無に依存しないようにするのが狙い。
 *
 * 不正な形式・欠落のときは null を返すので、呼び出し側は 400 を返すこと。
 */
export function getConnectionId(req: Request, res: Response): string | null {
  const fromLocals = res.locals.connectionId as string | null | undefined;
  if (fromLocals) return fromLocals;
  return sanitizeConnectionId(req.header("X-Connection-Id"));
}
