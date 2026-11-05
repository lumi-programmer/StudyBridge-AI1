// Scratch probe: what does a module (not the cell) see in this kernel?
export function describe() {
  const cellCrypto = globalThis.__cellCrypto;
  return [
    `module typeof crypto=${typeof crypto}`,
    `randomUUID=${typeof crypto?.randomUUID}`,
    `subtle=${typeof crypto?.subtle}`,
    `Response=${typeof Response}`,
    `Request=${typeof Request}`,
    `fetch=${typeof fetch}`,
    `Blob=${typeof Blob}`,
    `sameCryptoAsCell=${cellCrypto === crypto}`,
    `sameGlobalAsCell=${globalThis.__cellGlobal === globalThis}`,
  ].join(' | ');
}
