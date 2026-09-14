import type { Request, Response } from "express";
import { sanitizeId } from "../claude/executor.js";

/**
 * リクエストから clientId（HTTPヘッダ `X-Client-Id`）を取り出す。
 *
 * agentId/clientId分離対応のフェーズ2で、API契約を `X-Connection-Id` から
 * `X-Client-Id` / `X-Agent-Id` の2ヘッダへ切り替えた。`X-Connection-Id` はもう受理しない。
 *
 * 通常は `server/index.ts` のミドルウェアが検証済みの値を `res.locals` に入れているが、
 * ルーターを単体でマウントした場合（単体チェック等、ミドルウェアを通らない構成）にも
 * 動くよう、`res.locals` が空ならヘッダから直接読むフォールバックを持たせている。
 * ルーターが外部ミドルウェアの有無に依存しないようにするのが狙い。
 *
 * 不正な形式・欠落のときは null を返すので、呼び出し側は 400 を返すこと
 * （`/api/status` のみ、ヘッダ無しをヘルスチェック互換として許容し 400 にしない）。
 */
export function getClientId(req: Request, res: Response): string | null {
  const fromLocals = res.locals.clientId as string | null | undefined;
  if (fromLocals) return fromLocals;
  return sanitizeId(req.header("X-Client-Id"));
}

/**
 * リクエストから agentId（HTTPヘッダ `X-Agent-Id`）を取り出す。
 *
 * `X-Client-Id` と異なり、このヘッダは省略可能。新規Agentを起こすリクエスト
 * （例: `POST /api/chat` で継続対象を指定しない場合）にはそもそも付かないため、
 * 欠落時は null を返すだけで 400 にはしない（呼び出し側がエンドポイントごとに
 * 必須/任意を判断する）。不正な形式のときも同様に null を返す。
 *
 * `X-Client-Id` と違い `server/index.ts` のミドルウェアでは検証しない
 * （必須かどうかがルートごとに異なるため）。常にヘッダから直接読む。
 */
export function getAgentId(req: Request): string | null {
  return sanitizeId(req.header("X-Agent-Id"));
}
