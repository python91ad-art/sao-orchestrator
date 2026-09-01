import 'dotenv/config';

async function main() {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  const apiUrl = process.env.NOWPAYMENTS_API_URL || 'https://api.nowpayments.io';
  
  console.log('=== NOWPayments Live Connectivity ===');
  console.log(`API Key: ${apiKey ? 'SET' : 'MISSING'}`);
  console.log(`API URL: ${apiUrl}`);
  
  if (!apiKey) { console.log('Result: SKIPPED (no API key)'); return; }
  
  // Test authentication via GET /v1/status
  try {
    const r = await fetch(`${apiUrl}/v1/status`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.text();
    if (r.ok) {
      console.log(`Auth: OK (${r.status}) — Status endpoint responded`);
      
      // Test balance endpoint
      try {
        const br = await fetch(`${apiUrl}/v1/balance`, {
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(10000),
        });
        const bb = await br.text();
        if (br.ok) console.log(`Balance: OK (${br.status})`);
        else console.log(`Balance: ${br.status} — ${bb.slice(0,150)}`);
      } catch(e: any) { console.log(`Balance: ERROR — ${e.message}`); }
      
      // Test available currencies
      try {
        const cr = await fetch(`${apiUrl}/v1/currencies?fixed_rate=true`, {
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(10000),
        });
        const cb = await cr.text();
        if (cr.ok) {
          try {
            const data = JSON.parse(cb);
            const count = Array.isArray(data) ? data.length : (data?.currencies?.length || 0);
            console.log(`Currencies: OK (${cr.status}) — ${count} available`);
          } catch { console.log(`Currencies: OK (${cr.status}) — parse OK`); }
        } else {
          console.log(`Currencies: ${cr.status} — ${cb.slice(0,150)}`);
        }
      } catch(e: any) { console.log(`Currencies: ERROR — ${e.message}`); }
    } else if (r.status === 401 || r.status === 403) {
      console.log(`AUTH_ERROR (${r.status}) — ${body.slice(0,200)}`);
    } else {
      console.log(`ERROR (${r.status}) — ${body.slice(0,200)}`);
    }
  } catch(e: any) { console.log(`FETCH_ERROR — ${e.message}`); }
}
main();
