import test from 'node:test';
import assert from 'node:assert/strict';
import { action } from './admin.js';

test('dashboard rate comparison lists ShipPrime couriers next to Shiprocket', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/v1/forward/rates') ? { data: [
      { tpl: 'DELHIVERY_AIR', forwardCharge: 62, codCharge: 30, serviceable: true },
      { tpl: 'XPRESSBEES', forwardCharge: 40, codCharge: 30, serviceable: true },
      { tpl: 'DTDC_AIR', forwardCharge: 55, codCharge: 30, serviceable: false } ] }
      : u.includes('/v1/forward/edd') ? { data: { minDays: 2, maxDays: 4 } }
      : u.includes('pickup') ? { data: [{ pincode: '410206', name: 'Ink Kulture' }] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const shipping = { shipprime_token: 'test-token', weight_g: 50, sp_pickup: { name: 'Ink Kulture', phone: '9000000001', address1: 'Shop 1', city: 'Navi Mumbai', state: 'Maharashtra', pincode: '410206' } };
    const DB = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [{ k: 'shipping', v: JSON.stringify(shipping) }] }), first: async () => null, run: async () => ({}) }) };
    const env = { DB };
    const r = await action('shipping_rates')(env, { pin: '110001', cod: true, amount: 499 });
    const sp = r.options.filter((o) => o.key.startsWith('shipprime|'));
    assert.deepEqual(sp.map((o) => o.courier), ['Xpressbees', 'Delhivery Air'], 'serviceable ones, cheapest first');
    assert.equal(sp[1].charge, 92);
    assert.equal(sp[1].cod_fee, 30);
    assert.deepEqual(r.sp_days, { min: 2, max: 4 });
    assert.ok(r.connected.includes('shipprime'));
  } finally { globalThis.fetch = real; }
});
