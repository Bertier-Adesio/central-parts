// Lance une fonction Edge du dépôt en local pour tools/test-rfq-e2e.mjs : WeChat et les plateformes sont simulés,
// tout autre appel réseau est bloqué. Variables : FN (module de la fonction), PORT, CAPTURE (journal des envois).
const LOG = Deno.env.get('CAPTURE')!;
const write = (o: unknown) => Deno.writeTextFileSync(LOG, JSON.stringify(o) + '\n', { append: true });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.weixin.qq.com/cgi-bin/stable_token')) return new Response(JSON.stringify({ access_token: 'jeton', expires_in: 7200 }));
  if (url.startsWith('https://api.weixin.qq.com/cgi-bin/message/custom/send')) {
    const b = JSON.parse(String(init?.body));
    const fail = b.touser === 'oSILENT';                // contact hors fenêtre de 48 h
    write({ kind: 'wechat', to: b.touser, text: b.text.content, delivered: !fail });
    return new Response(JSON.stringify({ errcode: fail ? 45015 : 0 }));
  }
  if (url.startsWith('https://plateforme.example/')) {
    write({ kind: 'webhook', url, headers: init?.headers, body: String(init?.body) });
    return new Response('ok');
  }
  if (url.startsWith('http://localhost:54400/')) return realFetch(input, init);
  write({ kind: 'blocked', url });
  throw new Error('réseau bloqué : ' + url);
}) as typeof fetch;
const orig = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: any) => orig({ port: Number(Deno.env.get('PORT')), onListen: () => console.log('prête ' + Deno.env.get('PORT')) }, h);
await import(Deno.env.get('FN')!);
