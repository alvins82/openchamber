// Reproduction: the cloudflared download URL surfaced by the web UI is dead.
// Source: packages/web/server/lib/tunnels/install-help.js line 9
const brokenUrl = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflared/downloads/';
const validUrl = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';

async function status(u) {
  const r = await fetch(u, { redirect: 'follow' });
  return { code: r.status, url: r.url };
}

const b = await status(brokenUrl);
console.log('broken installUrl in install-help.js ->', b.code, b.url);

const v = await status(validUrl);
console.log('current Cloudflare docs page         ->', v.code, v.url);

if (b.code === 404) {
  console.log('\nREPRODUCED: installUrl returned in the web UI now 404s.');
  process.exitCode = 1;
} else {
  console.log('\nNOT reproduced.');
}
