'use strict';
// Sends the sign-up code by SMS.
//   TSUBU_SMS_PROVIDER=demo   (default) no SMS is sent; the code is shown on screen, clearly
//                             labelled "Demo". Fine for a portfolio, NOT real phone verification.
//   TSUBU_SMS_PROVIDER=twilio real SMS through Twilio (paid; free trial credit exists).
//                             Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.

// Japanese numbers (090…) to international format (+8190…).
const toE164 = (phone) => (phone.startsWith('0') ? '+81' + phone.slice(1) : phone);

function createSms(env = process.env) {
  const provider = (env.TSUBU_SMS_PROVIDER || 'demo').toLowerCase();
  if (provider === 'twilio') {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
    if (!sid || !token || !from) throw new Error('TSUBU_SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
    return {
      mode: 'twilio',
      async send(phone, text) {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
          method: 'POST',
          headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: toE164(phone), From: from, Body: text }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
      },
    };
  }
  return { mode: 'demo', async send() { /* shown on screen instead */ } };
}

module.exports = { createSms, toE164 };
