import { useState } from "react";

const STORAGE_KEY = "agentnest.clientId";

// localStorageが使えない環境（プライベートモード等でアクセス自体が例外を投げる場合）の
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
 * サーバ側の検証（`sanitizeId`）は 8-4-4-4-12 の16進形式のみを見るので、
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
    // 最後の砦。ここでの暗号学的強度は不要（クライアント識別用で、認証には使わない）。
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readOrCreateClientId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const created = generateUuid();
    window.localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    // localStorageへのアクセス自体が例外を投げる環境向けのフォールバック。
    // メモリ上に保持するのでタブ再読み込みで消えるが、アプリのクラッシュは防げる。
    if (!memoryFallback) memoryFallback = generateUuid();
    return memoryFallback;
  }
}

/**
 * ブラウザ単位で不変のクライアントID（UUID）を返すフック。
 *
 * agentId/clientId分離対応により、サーバー側は実行1本ごとの `agentId` と
 * 所有者を表す `clientId` を別々に管理するようになった。`clientId` は
 * 「このブラウザが自分のAgentだと主張してよい単位」なので、タブを閉じても
 * リロードしても同じ値を返し続ける必要がある。そのため sessionStorage
 * （タブ単位）ではなく localStorage（ブラウザ単位）に保存する。
 *
 * 同一ブラウザの複数タブから同時に複数Agentを起動しても、`clientId` は
 * 共有されて構わない。混線防止の単位は `agentId` 側（サーバ発行・実行1本ごと）
 * が担うため、`clientId` がタブ間で同じであること自体は問題にならない。
 *
 * useStateの遅延初期化を使うことで、生成・localStorageへの書き込みは
 * 初回レンダー時に1回だけ行われ、以降のレンダーでは同じ値を返す
 * （useEffect内でsetStateする実装ではないため、レンダー後に再描画が
 * 走ることもない）。
 */
export function useClientId(): string {
  const [clientId] = useState<string>(readOrCreateClientId);
  return clientId;
}
