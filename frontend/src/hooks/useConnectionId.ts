import { useState } from "react";

const STORAGE_KEY = "agentnest.connectionId";

// sessionStorageが使えない環境（プライベートモード等でアクセス自体が例外を投げる場合）の
// フォールバック先。モジュールスコープに保持することで、同一タブ内の複数コンポーネントから
// このフックが呼ばれても同じ値を共有できる。
let memoryFallback: string | null = null;

/**
 * UUID v4 を生成する。
 *
 * `crypto.randomUUID()` はセキュアコンテキスト（https か localhost）でしか使えず、
 * それ以外では undefined になる。本アプリは Tailscale 経由の平文HTTP
 * （`http://<tailscale-ip>:3000`）で iPhone から使う運用が主要なユースケースなので、
 * そのまま呼ぶと TypeError でレンダーが落ち、画面が真っ白になる。
 * そのため getRandomValues による生成にフォールバックする。
 * サーバ側の検証（`sanitizeConnectionId`）は 8-4-4-4-12 の16進形式のみを見るので、
 * この生成結果で問題なく通る。
 */
function generateUuid(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    // 最後の砦。ここでの暗号学的強度は不要（セッションの識別用で、認証には使わない）。
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readOrCreateConnectionId(): string {
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const created = generateUuid();
    window.sessionStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    // sessionStorageへのアクセス自体が例外を投げる環境向けのフォールバック。
    // メモリ上に保持するのでタブ再読み込みで消えるが、アプリのクラッシュは防げる。
    if (!memoryFallback) memoryFallback = generateUuid();
    return memoryFallback;
  }
}

/**
 * タブ単位で不変の接続ID（UUID）を返すフック。
 *
 * サーバー側がセッションを connectionId で分離するようになったため、
 * 同一ブラウザで複数タブ・複数リポジトリを開いても互いのチャットセッションが
 * 混線しないよう、タブごとに一意なIDをフロントエンドが発行して全チャット系APIに
 * 載せる必要がある。localStorageだとブラウザ全体で共有され複数タブ間でIDが
 * 衝突してしまうため、タブ単位でスコープが切れるsessionStorageに保存する。
 *
 * useStateの遅延初期化を使うことで、生成・sessionStorageへの書き込みは
 * 初回レンダー時に1回だけ行われ、以降のレンダーでは同じ値を返す
 * （useEffect内でsetStateする実装ではないため、レンダー後に再描画が
 * 走ることもない）。
 */
export function useConnectionId(): string {
  const [connectionId] = useState<string>(readOrCreateConnectionId);
  return connectionId;
}
